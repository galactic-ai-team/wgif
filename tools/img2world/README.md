# `tools/img2world` — Offline Single-Image to `.wgif` Prototype

Builds an explorable `.wgif` 3D world from a single RGB image completely offline on CPU.

## Model & License Details
- **Model**: `onnx-community/depth-anything-v2-small` (Depth Anything V2 Small, ViT-S backbone)
- **License**: **Apache-2.0** (free for commercial and open-source use; small ViT-S weights are Apache-2.0, unlike the CC-BY-NC-4.0 Large weights)
- **Runtime**: `@huggingface/transformers` (`onnxruntime-node` CPU execution provider, zero cloud calls once cached)
- **Download Size**:
  - Quantized (`q8` / `uint8`): **~25.4 MB** (`model_quantized.onnx`)
  - FP16 / FP32: ~49.8 MB / ~99.2 MB
- **Weight Storage**: Cached locally under `.cache/models/` (excluded via `.gitignore`; never committed to git).

## Usage
```bash
# Run with local Depth Anything V2 Small (CPU):
npx tsx tools/img2world/src/cli.ts --input photo.png --output world.wgif

# Run fully air-gapped / CI test mode (deterministic luminance+gradient depth fallback):
npx tsx tools/img2world/src/cli.ts --input photo.png --output world.wgif --synthetic-depth

Limits of Single-View Depth Worlds & Future Local Inpainting
What Breaks When the Camera Moves Away from the Origin

Disocclusion Shadows & Rubber-Sheet Stretching: A single image only observes the front-most surface along each camera ray. Stepping >0.4m laterally exposes geometry behind foreground silhouettes. On a continuous displaced grid, depth discontinuities triangulate into stretched "rubber-sheet" skirts; on thresholded meshes, they leave open holes.

Baked Lighting & Specular View-Dependence: Shadows, reflections, and highlights from the original photograph are baked into the baseColor texture and do not respond when viewing angle changes.

Out-of-Frustum Void: Rotating beyond the original camera's horizontal/vertical FOV (typically 50–65 degrees) hits the boundary of the frustum mesh unless the skybox/ground is extended.

Scale & Metric Ambiguity: Relative monocular depth maps lack true metric scale (scale and shift affine ambiguity), causing flat walls or floors to bow slightly unless regularized.

Three Local Ideas for Filling Unseen Areas (Future Work — Phase 2+)

Layered Depth Images (LDI) + Fast Telea/PatchMatch Edge Inpainting: Split the depth map at Canny/Sobel depth discontinuities into 2–3 depth layers (foreground, mid-ground, background), dilate foreground masks by 8–12 px, and run CPU PatchMatch or Navier-Stokes/Telea inpainting on the occluded background layer before meshing (<150 ms on CPU, 0 MB neural weights).

Tiny Distilled Local ONNX LaMa Inpainter (~50 MB INT8): Ship an optional LaMa-Fourier-Tiny ONNX model in the CLI toolchain to hallucinate plausible background textures behind disoccluded foreground objects at build time, baking a 2-layer mesh into the .wgif so runtime requires zero inference.

Outpainted Ground-Plane & Sky Dome Extrapolation: Automatically segment floor/ground and sky regions from surface normals derived from the depth map, fit a planar horizon, and synthesize a seamless procedural/tileable ground skirt and 360° equirectangular ambient sky dome around the high-detail central frustum.

