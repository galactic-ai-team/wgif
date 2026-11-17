# Size & speed budgets (Phase One)

A WGIF world should feel as light as a GIF. That only stays true if it is
enforced, so the numbers below are machine-readable in
`scripts/size-budgets.json` and checked by `npm run size:report` on every CI run.
Change a budget in one place: the JSON.

## Device classes

| Class | Representative hardware | Target |
|---|---|---|
| **C1 — low-end mobile** | 2019–2021 Android, 4 GB RAM, Mali-G52 / Adreno 610, 720–1080p, Chrome | 30 fps sustained, cold open ≤ 2.0 s |
| **C2 — mainstream mobile / thin laptop** | Adreno 640+, Apple A12+, Intel Iris Xe | 60 fps, cold open ≤ 1.2 s |
| **C3 — desktop** | discrete GPU or Apple M-series | 60 fps, cold open ≤ 0.6 s |

"Cold open" = file picked → first interactive frame, local file, no network.

## Byte budgets

| Budget | Limit | Today | Headroom |
|---|---:|---:|---:|
| `.wgif` total | **1 MiB** | ~30 KB | 34× |
| `preview.png` | 256 KiB | — | — |
| `world.glb` | 768 KiB | — | — |
| `manifest.json` | 16 KiB | — | — |
| `interactions.json`, `game-state.json` | 32 KiB each | — | — |
| any other entry | 256 KiB | — | — |
| entries per world | 256 | — | — |
| **uncompressed total per world** | **16 MiB** | — | — |
| **compression ratio (per entry ≥ 4 KiB)** | **64×** | — | — |
| **player JS, initial (entry graph) gzip** | **300 KiB** | ~209.9 KiB | 1.43× |
| any single **deferred** JS chunk gzip | 512 KiB | — | — |
| runtime WASM/models gzip (Phase One) | **0 B** | 0 B | — |
| player dist total gzip (excl. `.map`, runtime WASM and bundled sample `.wgif` worlds, which are content held to the per-world budgets) | 1.5 MiB | — | — |

Unknown entry names fall back to the 256 KiB default, so a new asset type
cannot sneak in unbounded.

### Initial vs deferred

"Initial" means every JS file reachable from the app entry through Vite's
static `imports` graph — what the browser must parse before the first frame.
"Deferred" means everything only reachable via `dynamicImports`. The split is
read from `apps/player/dist/.vite/manifest.json` (Vite 5) or
`apps/player/dist/manifest.json` (Vite 4); `build.manifest: true` in
`apps/player/vite.config.ts` is required to get it. If the manifest is
missing, every JS file is treated as initial — a lazy chunk cannot escape the
300 KiB budget by staying unclassified.

Why two numbers:

- The **300 KiB initial** budget is what a user pays to open the player at
  all. It is small on purpose and applies to every world.
- The **512 KiB per-deferred-chunk** budget is what a user pays *once* to
  unlock an optional feature (an ONNX runtime, a heavier codec). A world that
  doesn't need it never downloads it.
- **0 B runtime WASM** in Phase One keeps "open a `.wgif` and it just works"
  honest: no headers, no MIME plumbing, no COOP/COEP, no 10 MiB fetch on a
  phone in a parking lot.

### Optional runtimes: `requires[]` is the gate, the deferred budget is the cap

A world that needs the ONNX runtime declares `requires: ["runtime.onnx"]`.
When it does, the player lazy-loads the runtime as a deferred chunk. As of
dev b1beba5 no world requires `runtime.onnx`, so the player has **zero**
deferred chunks and zero runtime WASM: the rebounder uses a hand-written JS
MLP (Option A, < 2 KiB). If `onnxruntime-web` glue lands later it is
projected at ~107 KiB gzip (21% of the 512 KiB per-deferred-chunk budget);
the ~28 MiB onnxruntime WASM still requires a Phase Two spec decision to
raise `playerRuntimeWasmGzipBytes` from 0.

We deliberately do **not** have a separate `onnxRuntimeGzipBytes` row in
Phase One:

1. `requires[]` is a stronger gate than any size limit. A world without the
   capability requirement never downloads ONNX at all.
2. The generic 512 KiB per-deferred-chunk budget already catches a size
   regression in the ONNX glue.
3. A dedicated row requires tagging "which deferred chunk is ONNX" from the
   Vite manifest, which is not first-class and would break on any refactor
   of the ONNX import path.
4. Phase One ships **0 B runtime WASM** (`playerRuntimeWasmGzipBytes: 0`).
   If Phase Two needs to raise this to ship the ~28 MiB onnxruntime WASM,
   that's a spec decision for GPT-6 with `requires: ["runtime.onnx"]` made
   mandatory on any world that triggers a WASM fetch.

## Time budgets (measured manually, see `docs/PERF.md`)

| Metric | C1 | C2 | C3 |
|---|---:|---:|---:|
| cold open → first frame | ≤ 2000 ms | ≤ 1200 ms | ≤ 600 ms |
| steady-state p95 frame time | ≤ 33 ms | ≤ 16.7 ms | ≤ 16.7 ms |
| draw calls | ≤ 150 | ≤ 300 | ≤ 500 |
| triangles | ≤ 100 k | ≤ 300 k | ≤ 1 M |

These are not in CI — CI has no GPU, and a synthetic number from a headless
renderer would be a lie. They are recorded per release in `docs/PERF.md`.

## Why 1 MiB and 300 KiB

- 1 MiB expanded is ~10–30 ms of GLB parse plus ~4–10 ms of SHA-256 on C1.
  At 4 MiB those numbers start to be visible as a stall on open.
- 300 KiB gzip of JS is roughly 1 s of parse+compile on a C1 device. Three.js
  alone is ~150 KiB gzip, so the app + format layer gets ~150 KiB. That is
  enough for a hand-written player and *not* enough for a JSON-Schema
  compiler, a physics engine and an ML runtime in the same chunk. Those must
  be lazy chunks or absent.

## Known gaps in this budget (follow-ups)

1. **Preview decode size is not budgeted.** A 256 KiB PNG can decode to
   64 MiB of RGBA (4096²). Add a check on the PNG IHDR: ≤ 1024×1024.
2. **Compressed-in-container vs shipped bytes.** `.wgif` entries are already
   deflated, so brotli over the whole file saves little. The report prints
   both numbers so nobody optimizes the wrong one.
3. **No memory budget.** `performance.measureUserAgentSpecificMemory` is
   Chromium-only and cross-origin-isolated-only. Track manually for now.

## Running it

```bash
npm run build
npm run size:report                          # human table
npm run size:report -- --summary /tmp/s.md   # also write markdown
npm run size:report -- --json                # machine-readable
```

Exit code is 1 on any violation. `--soft` downgrades to a warning (use only
while landing a known-large change, and flip it back in the same PR).

## What to do when you are over

| Over budget | First move |
|---|---|
| `world.glb` | quantize + meshopt (see `docs/ASSET-COMPRESSION.md`) |
| `preview.png` | resize to ≤ 1024², re-encode; consider WebP |
| uncompressed total | almost certainly a zip bomb or an unbounded entry. Check the largest expanded entry; a well-behaved world cannot exceed 16 MiB from a 1 MiB container |
| compression ratio | the flagged entry (≥ 4 KiB stored) is padding, a placeholder, or hostile. Re-pack as real data, or drop it |
| player **initial** JS | check the biggest initial chunk in the report; usually ajv, or a lazy dependency imported eagerly. Move it behind `import()` — it becomes deferred and stops counting against 300 KiB |
| a single deferred chunk | if it exceeds 512 KiB, check whether the same file is also being pulled into the initial graph. If it is, split the shared code out before the lazy chunk grows further |
| runtime WASM/models | Phase One forbids this outright. Either drop the feature or propose a Phase Two budget line and get it approved; do not just bump the number |
