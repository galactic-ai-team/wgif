# Embedded model quantization plan (Phase Two)

Owner: Dee (OPTIMIZATION), with Nova. Nothing here ships in Phase One; the
`models/` slot stays reserved and empty.

## Size targets

| Item | Budget |
|---|---:|
| one model | 512 KiB |
| all models in a world | 1 MiB |
| model runtime (player) | lazy chunk only, excluded from the 300 KiB JS budget |

A world with a model therefore lands in a ~2 MiB class. That number belongs in
`docs/BUDGETS.md` before any model ships.

## Quantization options

| Format | Size vs fp32 | Accuracy | Runtime cost | Verdict |
|---|---|---|---|---|
| fp32 | 1× | baseline | baseline | no |
| **fp16** | 0.5× | ~lossless for inference | near-native on GPUs, emulated on CPU | safe default |
| **int8 dynamic** (weights only) | 0.25× | usually < 1% task-metric drop on small vision/control nets | needs int8 kernels; slow without SIMD | default for CNNs/MLPs |
| int8 static (QDQ, calibrated) | 0.25× | better than dynamic on conv-heavy nets | needs calibration data in the repo | if dynamic degrades |

Recommended: **int8 dynamic with per-channel weights** as the default, fp16
as the fallback when the accuracy harness fails, fp32 never.

## Accuracy harness (must exist before any model ships)

Golden inputs + fp32 reference outputs committed as `.json`. CI runs both and
asserts cosine similarity ≥ 0.99 and max abs diff ≤ 1e-2. Without this,
"quantization is fine" is an opinion.

## WASM SIMD on mobile — the important part

- **SIMD**: broadly available in Chrome/Safari/Firefox on mobile since 2021.
  Enable it. ~2–4× on quantized matmul.
- **Threads**: require `SharedArrayBuffer`, which requires COOP/COEP headers,
  which a `.wgif` opened from `file://` or a plain static host **does not
  have**. Assume **single-threaded**. Set `ort.env.wasm.numThreads = 1` and
  never design a model that needs threads to hit its latency target.
- **Workers**: Chrome blocks `new Worker()` from `file://`. If the player must
  work when the user double-clicks a `.wgif`, inference has to be able to run
  on the main thread. That is a spec-level constraint, not an optimization.
- **Runtime size**: the full `onnxruntime-web` bundle is ~1–2 MiB gzip. It
  cannot be in the initial chunk under any reading of the 300 KiB budget. It
  must be `import()`ed on first model use, and the `.wasm` artifacts must be
  either external (breaks single-file portability) or inlined (blows the
  budget). **This is an unresolved format question** — see blockers.

## No executable code in `.wgif`

ONNX is a data format; weights + graph, no code. Compliant. A JS runtime
inside the container would not be. Keep it that way.