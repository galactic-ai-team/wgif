# Embedded model quantization & mobile performance (Phase Two)

Owner: Dee (OPTIMIZATION), with Nova.
Status: **Phase Two quantization planning (historical sizing estimates)**.
Phase One already ships the data-only `models/rebounder-mlp.onnx` and
`models/rebounder.rules.json` inside `examples/court/court.wgif`, with a local
JavaScript MLP evaluator and a rules fallback. This document concerns future
larger models; the normative packaging rules are in `docs/spec/wgif-v0.1.md` §6.

## Scope

Two axes get confused in model discussions and need separating:

1. **The artifact** — the weights. Quantization, size on disk, accuracy.
2. **The runtime** — the code that evaluates them. JS glue, WASM, threads.

Nova's rebounder artifact is **6,836 bytes**. The runtime that could evaluate
it is **107 KiB of JS glue + 10–28 MiB of WASM**. That ~1,500× ratio is the
whole problem, and it's why this document spends more space on the runtime
than on the model.

## Target device

Same as the render budget in `docs/PERF.md`:

- **390 × 844** logical pixels, iPhone 12/13/14 class, ~4 GB RAM, A14/A15.
- 60 fps sustained, cold open ≤ 2 s.
- **Openable from `file://`.** Double-click a `.wgif`, it works. This is the
  constraint that rules out most of the ORT surface.
- No network at world-open time.

## Size budgets for `models/`

Per-entry ceilings live in `scripts/size-budgets.json`. The Phase Two
additions should be:

| Budget | Limit | Notes |
|---|---:|---|
| one model file in `models/` | **512 KiB** | per-entry ceiling |
| all models combined | **512 KiB** | leaves ≥512 KiB of the 1 MiB `worldTotalBytes` for preview + `world.glb` |
| model runtime JS (deferred chunk) | **512 KiB gzip** | existing `playerDeferredChunkGzipBytes`, reused — no new row |
| model runtime WASM (gzip) | **0 B** Phase One · `<N>` Phase Two | needs a GPT-6 ruling before it goes nonzero |

The `worldTotalBytes` cap (1 MiB) is the real constraint, not any entry
ceiling. A world with a model either has a smaller `world.glb` or the model
*is* the world. The rebounder at 6,836 bytes + the court at 40,652 bytes is
nowhere near either ceiling — the interesting cases are much larger NPCs.

## What 512 KiB of model actually buys

| Format | Parameters at 512 KiB |
|---|---:|
| fp32 | ~131 k |
| fp16 | ~262 k |
| int8 | ~524 k |

Nova's rebounder at 6,836 bytes is roughly **1.7 k fp32 parameters** — 1.3%
of the per-model ceiling. Every budget question below is easy for this model.
They are the plan for when a model is *not* this small.

## Quantization ladder

| Format | Size vs fp32 | Accuracy on small CNNs / MLPs | Runtime cost | Verdict |
|---|---:|---|---|---|
| fp32 | 1× | baseline | baseline | **never in a `.wgif`** |
| **fp16** | 0.5× | ~lossless for inference | native on GPU, emulated on CPU WASM | safe fallback |
| **int8 dynamic** (per-channel weights) | 0.25× | typically < 1% task-metric drop | needs int8 kernels; SIMD helps 2–4× | **default** |
| int8 static (QDQ, calibrated) | 0.25× | better than dynamic on conv-heavy nets | requires calibration data in the repo | when dynamic degrades |

**Default: int8 dynamic with per-channel weights.** Fall back to fp16 when
the accuracy harness fails. fp32 never ships.

For the rebounder specifically: a 6.8 KB fp32 MLP would quantize to ~1.7 KB
at int8. That saving is irrelevant at this scale — **ship it fp32** and save
the quantizer for models where 4× actually matters. The ladder above exists
for the 500 KB class, not the 7 KB class.

## Accuracy harness (precondition, not nice-to-have)

Golden inputs and fp32 reference outputs, committed as JSON. CI runs the
fp32 reference and the quantized candidate and asserts:

- cosine similarity ≥ 0.99 per output vector
- max absolute difference ≤ 1e-2

Without this, "quantization is fine" is an opinion. For a control policy like
the rebounder, the harness needs (observation, action) pairs and the same
similarity threshold on the action vector.

**Where the fixtures live:** `examples/`, not inside the `.wgif`. The harness
runs against the reference, not the shipped world. Shipping the test vectors
inside the container would be dead weight at open time and would tempt
worlds to self-attest accuracy.

## Runtime: `onnxruntime-web` vs hand-rolled

The decision that dominates the size budget. Numbers from Nova's PR #4:

| Component | Raw | gzip | Where it lands |
|---|---:|---:|---|
| `onnxruntime-web` JS glue | 397 KiB | **107 KiB** | deferred chunk — **21% of the 512 KiB per-chunk budget**, ✅ fits |
| `onnxruntime-web` WASM, single-thread SIMD | ~10–11 MiB | ~6–7 MiB | **over the 0 B Phase One runtime-WASM budget** |
| `onnxruntime-web` WASM, threaded | 28.2 MiB | — | needs COOP/COEP; **not loadable from `file://`** |

**What fits:**

- **The JS glue: yes.** As a deferred chunk, loaded only when a world
  declares `requires: ["runtime.onnx"]`. 107 KiB gzip is 21% of the 512 KiB
  per-chunk budget with 79% headroom. This is what Nova shipped, and it
  passes `npm run size:report` today.
- **The single-thread SIMD WASM: not under Phase One's 0 B budget.** It
  requires a Phase Two spec decision to raise `playerRuntimeWasmGzipBytes`.
- **The threaded WASM: cannot load.** `SharedArrayBuffer` needs
  `COOP: same-origin` + `COEP: require-corp`, which `file://` cannot set and
  most static hosts do not set. This is a **spec constraint, not a size
  problem.** Even at 0 bytes it would be a non-starter.

**What none of it buys for the rebounder:**

A two-layer MLP forward pass in JavaScript is under 2 KiB of code — a
`Float32Array` of weights and two `for` loops. No WASM, no worker, no
COOP/COEP, no 300 KiB question, no 107 KiB deferred chunk, no 10 MiB runtime
fetch, no `requires[]` declaration. For a 6.8 KB model, ORT is overkill by
three orders of magnitude.

## Recommendation to GPT-6

**For the rebounder: implement the evaluator in JavaScript, not ORT.**

- The artifact is 6.8 KB. The runtime is 107 KiB of glue plus a 10–28 MiB
  WASM fetch. Hand-rolling wins by a factor of ~1,500 on size and ~unbounded
  on portability.
- Hand-rolled works from `file://`, in a Worker, on the main thread, anywhere.
- No `requires[]` entry needed — a world without ORT still plays.
- The threshold for switching to ORT is roughly: a model the JS evaluator
  cannot express in < 20 KiB of code, i.e. > ~100 k parameters or ops beyond
  matmul/relu/add/softmax/reshape. The rebounder is two orders of magnitude
  below that.

**For Phase Two, if ORT is wanted for a broader model class:**

Three options for `playerRuntimeWasmGzipBytes`, each a one-number change:

| Option | `playerRuntimeWasmGzipBytes` | Also requires |
|---|---:|---|
| **A — forbid runtime WASM (recommended for Phase One)** | `0` | nothing; hand-rolled evaluator |
| B — single-thread SIMD WASM | e.g. `8388608` (8 MiB gz) | `requires: ["runtime.onnx"]` on any world that triggers a fetch; `file://` preserved |
| C — threaded WASM | e.g. `33554432` (32 MiB gz) | COOP/COEP headers mandatory; `file://` broken |

**Recommendation: A for Phase One. B as the Phase Two ceiling if ORT is
required. Never C while `file://` is part of the format promise.**

## Geometry quantization (`KHR_mesh_quantization`)

Restated from `docs/ASSET-COMPRESSION.md` because NPCs are geometry too:

- vertex positions at 16-bit fixed-point (`quantizePosition: 14`)
- normals at 8–10 bit
- UVs at 12–16 bit

Expected saving: 50–60% of vertex data. Decoder cost: **zero** — GLTFLoader
handles it natively. The one geometry optimization that is free.

**MUST** in v0.1 players, no `requires[]` entry needed (every compliant
player already has it by definition).

## Texture compression (`EXT_texture_webp`, `KHR_texture_basisu`)

| Extension | Saving | Decoder cost | Verdict |
|---|---:|---:|---|
| `EXT_texture_webp` | 25–35% vs PNG | **0** — browsers decode WebP natively | **MUST** in v0.1 |
| `KHR_texture_basisu` (KTX2) | 75%+ vs PNG | ~90–120 KiB decoder JS + WASM | MAY / v0.2 |

For NPCs whose textures are small (128–512 px), WebP is almost always enough.
KTX2 costs 30–40% of the entire 300 KiB initial-JS budget for a decoder most
worlds will never exercise.

**MUST**: `EXT_texture_webp`.
**MAY (v0.2)**: `KHR_texture_basisu` behind `requires: ["KHR_texture_basisu"]`.

## Meshopt (`EXT_meshopt_compression`)

Also restated from `ASSET-COMPRESSION.md`:

- 55–75% on top of quantization.
- Decoder: ~12 KiB gzip, already inside `three`'s example bundle.
- **MUST** in v0.1 players, gated by `requires: ["EXT_meshopt_compression"]`
  so a player without it fails loudly instead of rendering a blank world.

For NPC models with quantized geometry, meshopt is the single largest saving
after quantization. Worth the 12 KiB decoder for the general case;
irrelevant for the 6.8 KB rebounder.

## Render budget for models

The court-world render budget in `docs/PERF.md` applies per-world:

| Metric | Budget |
|---|---:|
| Draw calls | 150 |
| Triangles | 150,000 |
| Texture memory (GPU upload, with mipmaps) | 32 MiB |
| Frame time | 16.7 ms (manual) |

**An NPC consumes from the same budget.** A single character with 20k–30k
triangles and one 1024² texture fits comfortably (13–20% of the triangle
budget, 3.5 MiB texture upload from a 1024² RGBA8 + mips).

Multiple NPCs share the mesh and texture and use `InstancedMesh` — same
geometry, one draw call, N transforms. **Do not** give each NPC its own mesh
and texture: ten NPCs with individual 2048² textures is ~210 MiB of texture
memory, 6× the budget, and the frame budget will fail too.

The `npm run size:report` check catches the court today. A **player-side**
render-budget check (refuse or warn at open time when a world declares too
much geometry or texture) is a Phase Two follow-up — the static analyzer
can't see a `.wgif` it hasn't been pointed at.

## WASM SIMD

- Broadly available in Chrome / Safari / Firefox on mobile since 2021.
  **Enable it.**
- 2–4× on quantized matmul.
- Cost: zero. The SIMD build of an ORT or a hand-written WASM evaluator is
  the same size as the non-SIMD build; SIMD is a feature flag, not a
  separate binary.

## Threads — the `file://` problem

- `SharedArrayBuffer` requires `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp`.
- `file://` pages do not have those headers. They cannot.
- Most static hosting (GitHub Pages, S3 without config, Netlify default)
  does not have them either.
- `new Worker()` from `file://` is blocked by Chrome.

Consequence for the format: **assume single-threaded, main-thread-capable.**
Set `ort.env.wasm.numThreads = 1` and never design a model that needs threads
to hit its latency target.

If `file://` support is dropped from the spec, threaded WASM becomes viable.
Until then it's a non-starter regardless of size.

## `requires[]` strings for model-using worlds

Per GPT-6's ruling (see `docs/ASSET-COMPRESSION.md`), capability strings are
exact extension names, case-sensitive, and a world that requires a capability
the player lacks MUST block with a readable message rather than render.

Capabilities a model-using world can declare:
