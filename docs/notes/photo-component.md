# Pictures in 3D (`interactions[]` type `photo`) and the in-player creator — proposal

Status: **implemented in the player, proposed for the format.** The v0.1 schemas are unchanged.
Format-lane review: GPT-6 (brief in the team outbox).

## What it is

"Create from image" in the player turns a PNG / JPEG / WebP / GIF into a world:

* **3D (AI depth):** Depth Anything V2 Small estimates depth in the browser; the picture becomes
  a displaced, textured mesh rebuilt along the camera rays, so from the start view it looks like
  the picture and orbiting shows real parallax. Triangles across big depth jumps are cut
  ("Cut at depth edges") and a dim copy of the picture behind fills the gaps; unticked, the depth
  is smoothed more and every triangle is kept (a soft slope instead of a hole).
* **Flat screen:** the picture on a lit screen in a small room (no model, no download).
* **GIFs:** decoded in the page (own decoder, `apps/player/src/photo/gif.ts`), at most 48 frames
  (evenly sampled, delays summed so the loop keeps its length). Depth is estimated on the GIF's
  still background (per-pixel median of up to 9 frames), and the frames play on the mesh.

Everything runs locally. The file it saves carries the mesh, the computed depth map and the
frames — never the model.

## Why it fits v0.1 without a schema change

Like vehicles and audio, it is an entry in the free-form top-level `interactions` array, and the
world lists **no** new capability in `requires[]` (`scene.glb`, `interaction.camera` only). The
mesh is plain glTF 2.0 with no extensions (the picture is an emissive texture on a black base,
so it shows at its own colours in any light; KHR_materials_unlit is not in the v0.1 extension
allow-list). An older player opens it, shows the 3D picture still (frame 0), and warns that
`interactions[]` has an entry it cannot run.

## Shape

```json
{
  "type": "photo",
  "id": "photo",
  "node": "photo",
  "alsoNodes": ["photo_back"],
  "focus": [0, 3.81, -4.47],
  "eye": [0, 3.94, 0],
  "frames": { "file": "assets/frames.jpg", "columns": 5, "rows": 5, "count": 24, "delaysMs": [70, 70] }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `id`, `node` | required | `node` is the mesh showing the picture |
| `focus` | required | orbit centre (on the eye's axis, at the median depth) |
| `eye` | null | where the picture was "taken" from; the start view is just behind it |
| `alsoNodes` | [] | other nodes with the same picture (the back plate); they animate too |
| `frames` | null | a sprite sheet: `count` frames left to right, top to bottom, on a `columns` x `rows` grid; `delaysMs` per frame (20..60000) |

`frames.file` is a path inside the .wgif (`[A-Za-z0-9._/-]`, no `..`, never a URL). With fewer
than 2 frames or a bad file the picture is shown still, with a warning. One photo per world.

The player: keeps the photo nodes out of static merging, turns tone mapping off for their
materials (true colours), starts orbit from `eye` looking at `focus`, uses a turned view for the
export preview, and for `frames` swaps the materials' maps for the sheet and moves the texture
offset per frame (no mipmaps, so frames never bleed into each other).

## Other payloads

* `assets/depth.png` — the depth map the mesh was made from (8-bit grey, 1 = near, long side
  ≤ 256 px). Not needed to play; it lets a later tool rebuild the mesh (other strength, better
  mesher) without running the model again.
* `provenance.params` — `mode`, `frames`, `strength`, `edge` and the depth model id, revision,
  backend and input size.
* `extensions.x-credits` — the picture ("supplied by the creator of this world") and, when the
  model ran, the depth model with its licence.

## Size budget

Kept inside `scripts/size-budgets.json` by the builder (`apps/player/src/photo/world.ts`): it
shrinks the mesh grid and the texture until `world.glb` ≤ 760 KiB; the sheet is re-encoded
smaller until it is ≤ 252 KiB; the preview ≤ 255 KiB; the whole file ≤ 1 MiB.

## The depth model

| | |
| --- | --- |
| Model | `onnx-community/depth-anything-v2-small`, revision `4472b7362082ad9968fee890ca0f1e5aca36b93d` — two files, one per backend: `onnx/model_quantized.onnx` (int8) for the CPU/wasm path, `onnx/model_q4f16.onnx` (4-bit weights, MatMulNBits) for the WebGPU path. The int8 file is NOT used on WebGPU: its 79 DynamicQuantizeLinear + 48 MatMulInteger + 31 ConvInteger nodes are not in the WebGPU provider's operator table, so every one falls back to the CPU with a GPU↔CPU copy each. |
| Base | Depth Anything V2 Small (Yang et al., 2024), Apache-2.0 (the Base/Large/Giant checkpoints are CC-BY-NC; only Small is Apache) |
| Size | int8 27,258,801 B, SHA-256 `fcf51f1b…85547f20d`; q4f16 19,126,267 B, SHA-256 `eca72971…9bf1e` (both pinned in `src/photo/depth.ts`) |
| Runtime | onnxruntime-web 1.31.1 from jsDelivr (MIT): `ort.wasm.min.mjs` + `ort-wasm-simd-threaded.{mjs,wasm}` (14.8 MB, 3.2 MB brotli on the wire), or the WebGPU build (`ort.webgpu.min.mjs` + asyncify, 28.7 MB) when the browser has an adapter |
| Input | long side 392 px (CPU) / 518 px (GPU), both sides multiples of 14, ImageNet mean/std |
| Output | relative inverse depth, normalised with the 1st/99th percentiles |

Nothing of it is in the player bundle (the creator chunk is 12 KB gzip). On first 3D use the
files are fetched, checked against pinned SHA-256 hashes (`src/photo/depth.ts`) and stored in
Cache Storage (`wgif-depth-v1`), so later uses — and offline use — need no network. The
service worker never touches cross-origin requests, which is why the creator caches them itself.
One thread, so no cross-origin isolation (see `onnx-wasm-coop-coep.md`). `?depth=mock` swaps in a
synthetic depth map (tests); `?depth=wasm` / `?depth=webgpu` force a backend.

Measured headless (Chrome, SwiftShader, no GPU, this box): first load 3.3–4.0 s (download of
~30 MB + runtime start, fast network), inference 0.9–1.3 s at 392 px, later loads from the cache
0.3 s.

## Playback cost

A picture world is a flat unlit surface, so the player draws it that way (nothing in the file changes):

* The glTF stores the picture as an emissive map on a black base (true colours in any light). At play
  time the player swaps that for an unlit `MeshBasicMaterial` with the same texture and factor, takes
  the picture out of the shadow pass, and draws the dark floor unlit too. Same look, far less
  per-pixel work (no lights, IBL or shadow lookups).
* Picture worlds render at most 1.5 device pixels per CSS pixel (the texture is at most ~1000 px), keep
  orbit damping on phones, and touch devices never get MSAA.
* A GIF's sprite-sheet cells are inset by half a texel (no bleed from neighbouring frames), the sheet is
  uploaded when the world opens, and nothing is redrawn between two frames unless the cross-fade runs.
  Frames of 40 ms or more are cross-faded into the next one in the shader (two samples of the same
  sheet), so a 14 fps GIF moves smoothly at the screen's rate; the quality governor turns the fade off
  from step 3 down, and the player then draws only when the frame changes.
* `apps/player/e2e/photo-perf.e2e.mjs` measures frame times and a synchronous render cost per world,
  at desktop and 390x844 with CPU throttling (headless SwiftShader, so relative numbers only).

## Limits

* One picture has one viewpoint: what was hidden behind things is not there. Cut edges show the
  dim back plate; orbit far round and the picture reads as a relief, not a full 3D model.
* Depth is relative and guessed. Skies, glass, mirrors, flat graphics and text, and night photos
  can come out odd; the Depth slider (0 = flat) is the escape hatch.
* GIFs: depth comes from the still background, so moving things are painted onto it rather than
  standing out. Frames are capped at 48 and shrunk to fit a 2048 px sheet.
* Phones: the CPU path is several times slower than desktop and the first use downloads ~30 MB;
  the flat mode needs neither.
