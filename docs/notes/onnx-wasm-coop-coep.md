# Note: threaded ONNX WASM and COOP/COEP headers (Embedded AI lane, Nova)

**Question:** does the player need `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
headers to run the threaded ONNX Runtime Web WASM, and what should it do offline without them?

## Short answer

**No — not as shipped.** The ONNX rebounder runs in a real browser with no COOP/COEP
headers at all. The player needs no special headers, and offline it does nothing different:
the WASM asset is bundled same-origin, fetched lazily only when an ONNX model loads, and if
it ever cannot load the loader falls back to the rules model and says so in the info panel.

## Evidence (real browser, Nov 16, 2026)

Playwright Chromium 159 (headless shell, SwiftShader WebGL), serving the built player
(`apps/player/dist`) from localhost two ways — plain, and with
`COOP: same-origin` + `COEP: require-corp` — and loading two worlds: the sample court
(rules-first manifest) and a test repack of the court with the ONNX model listed first.

| Serving | `crossOriginIsolated` | Sample court (rules-first) | ONNX-first world | WASM fetch | Console errors |
|---|---|---|---|---|---|
| Plain, no headers | `false` | rules model, scene moving | **onnx model, scene moving** | 200 | none |
| COOP + COEP | `true` | rules model, scene moving | **onnx model, scene moving** | 200 | none |

"Scene moving" means screenshots 3 s apart differ — the NPC loop is actually driving the
marker and the ball, not just loading a session. The `#ai` line in the player reports the
runtime actually in use, so a fallback would have shown up there.

## Why no headers are needed

- `packages/ai` sets `onnxruntime-web` `env.wasm.numThreads = 1` before creating a session.
  At one thread the runtime never spawns workers and never needs `SharedArrayBuffer`, so
  the page does not need to be cross-origin isolated — even though the binary it loads is
  the threaded build (`ort-wasm-simd-threaded.jsep.wasm`, the only WASM file the
  `onnxruntime-web` 1.23 bundle references).
- The WASM is a same-origin asset in the player bundle (`dist/assets/`), not a CDN fetch,
  so there is no cross-origin fetch for COEP to gate. Offline serving (plain static host,
  `vite preview`, a file share) works as-is.

## What would need headers

- **More than one thread.** If a future model sets `numThreads > 1`, the runtime spawns
  workers via `SharedArrayBuffer`, and the page MUST be cross-origin isolated
  (`COOP: same-origin` + `COEP: require-corp`) or session creation fails. Keep
  `numThreads = 1` unless a model is measured to need threads, and treat that as a
  spec-visible change: the world's descriptor would have to say so, and hosts that
  cannot set the headers would have to fall back.
- **A single-threaded WASM fallback is not available in this bundle.** The
  `onnxruntime-web` 1.23 default bundle ships only the threaded jsep WASM; there is no
  separate single-threaded `.wasm` to fall back to. The fallback that exists — and the
  one the player uses — is the **rules model**, which needs no WASM at all. Do not add a
  second WASM build to chase a case the rules model already covers.

## What the player should do offline without the headers

Nothing special — this is the current behaviour, and it is the right one:

1. Load the world; try models in manifest order.
2. If an ONNX model cannot load (WASM missing, session fails, tensor mismatch), run its
   declared `fallback` rules model and show which runtime is active.
3. Worlds that lead with rules never fetch the WASM at all (the court does this, so the
   sample stays light); worlds that lead with ONNX pay one lazy ~29 MB fetch.

## Addendum — Option A (Nov 16, 2026)

The player no longer ships ONNX Runtime Web at all. Dee's Option A was
adopted: the rebounder's `.onnx` file is evaluated by a hand-rolled JS MLP
evaluator (`packages/ai/src/jsmlp.ts`), because PR #3 sets the runtime-WASM
budget to 0 B. The findings above still stand for the ONNX Runtime path,
which remains as Node-side verification (`packages/ai/src/onnx.ts`, not
exported from the package), but the COOP/COEP question is moot for the
player — there is no WASM to isolate. Verified Nov 16 in the same browser
harness: the ONNX-first court loads as "onnx model", the NPC moves (1s/4s
screenshots differ) and settles (12s/15s identical), with zero WASM fetches
and zero console errors, plain and with COOP/COEP.

For the record, on Dee's question: the earlier check used the **threaded**
build (`ort-wasm-simd-threaded.jsep.wasm` — the only WASM file the
`onnxruntime-web` 1.23 bundle references; there is no single-thread build in
the bundle), run single-threaded at `numThreads = 1`. So the check proved
the threaded binary instantiates and runs without cross-origin isolation when
limited to one thread — not that a single-thread build exists.

## How to reproduce the check

The check is not in the repo (Playwright is not a repo dependency). To repeat it:

```bash
# 1. Build the player, then serve dist twice (plain + with headers).
# 2. Repack the court ONNX-first: unpack court.wgif, reverse manifest.models,
#    repack — the test world is not committed.
# 3. In a real browser, open each server, load the sample court (expect "rules
#    model"), then open the ONNX-first world via the file input (expect "onnx
#    model"), and confirm the scene moves and the console is clean.
```

The scripts used for the Nov 16 check (static servers + Playwright driver) were temporary
and are not committed; the procedure above is enough to re-run it.
