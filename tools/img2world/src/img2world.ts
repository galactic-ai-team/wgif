import { createHash } from 'node:crypto';
import {
  encodeAnimatedGif89a,
  encodeDeterministicPng,
} from '../../../examples/court/src/prng.js';
import {
  packDeterministicWgifZip,
  type Rc1Creator,
  type Rc1Manifest,
} from '../../../examples/court/src/pack-court.js';

export interface Img2WorldOptions {
  imageRgba: Uint8Array;
  width: number;
  height: number;
  gridWidth?: number;
  gridHeight?: number;
  fovDeg?: number;
  depthScale?: number;
  maxEdgeStretch?: number;
  syntheticDepth?: boolean;
  modelId?: string;
  creator?: Rc1Creator;
  mode?: 'locked' | 'editable' | 'layered';
}

export interface Img2WorldOutput {
  glbBytes: Uint8Array;
  previewGifBytes: Uint8Array;
  wgifBytes: Uint8Array;
  depthMap: Float32Array;
  manifest: Rc1Manifest;
}

export interface EstimatedDepthResult {
  depth: Float32Array;
  depthWidth: number;
  depthHeight: number;
  modelUsed: string;
  license: string;
}

/**
 * Bilinearly resamples a 2D Float32 depth map from (srcW x srcH) to (dstW x dstH).
 */
export function resampleDepthBilinear(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float32Array {
  if (srcW === dstW && srcH === dstH) {
    return new Float32Array(src);
  }
  const out = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const gy = dstH > 1 ? (y / (dstH - 1)) * (srcH - 1) : 0;
    const y0 = Math.floor(gy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = gy - y0;

    for (let x = 0; x < dstW; x++) {
      const gx = dstW > 1 ? (x / (dstW - 1)) * (srcW - 1) : 0;
      const x0 = Math.floor(gx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = gx - x0;

      const v00 = src[y0 * srcW + x0]!;
      const v10 = src[y0 * srcW + x1]!;
      const v01 = src[y1 * srcW + x0]!;
      const v11 = src[y1 * srcW + x1]!;

      const top = v00 * (1 - wx) + v10 * wx;
      const bot = v01 * (1 - wx) + v11 * wx;
      out[y * dstW + x] = top * (1 - wy) + bot * wy;
    }
  }
  return out;
}

/**
 * Applies a 3x3 edge-preserving median filter to suppress quantization stair-stepping
 * and isolated depth spikes before meshing.
 */
export function medianFilter3x3(
  src: Float32Array,
  width: number,
  height: number
): Float32Array {
  const out = new Float32Array(width * height);
  const win = new Float32Array(9);
  for (let y = 0; y < height; y++) {
    const ym1 = Math.max(0, y - 1);
    const yp1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const xm1 = Math.max(0, x - 1);
      const xp1 = Math.min(width - 1, x + 1);
      win[0] = src[ym1 * width + xm1]!;
      win[1] = src[ym1 * width + x]!;
      win[2] = src[ym1 * width + xp1]!;
      win[3] = src[y * width + xm1]!;
      win[4] = src[y * width + x]!;
      win[5] = src[y * width + xp1]!;
      win[6] = src[yp1 * width + xm1]!;
      win[7] = src[yp1 * width + x]!;
      win[8] = src[yp1 * width + xp1]!;
      win.sort();
      out[y * width + x] = win[4]!;
    }
  }
  return out;
}

/**
 * Estimates normalized inverse depth [0..1] on CPU strictly offline.
 * Uses @huggingface/transformers (onnx-community/depth-anything-v2-small, Apache-2.0)
 * from local `.cache/models` (`allowRemoteModels = false`); falls back to deterministic prior.
 */
export async function estimateMonocularDepth(
  imageRgba: Uint8Array,
  width: number,
  height: number,
  options: { syntheticDepth?: boolean; modelId?: string } = {}
): Promise<EstimatedDepthResult> {
  const modelId = options.modelId ?? 'onnx-community/depth-anything-v2-small';

  if (!options.syntheticDepth) {
    try {
      const moduleName = '@huggingface/transformers';
      const transformers = (await import(/* @vite-ignore */ moduleName)) as {
        env: {
          allowLocalModels: boolean;
          allowRemoteModels: boolean;
          cacheDir: string;
        };
        pipeline: (
          task: string,
          model: string,
          opts: { device: string; dtype: string }
        ) => Promise<
          (img: unknown) => Promise<{
            predicted_depth: {
              data: Float32Array;
              dims?: number[];
              width?: number;
              height?: number;
            };
          }>
        >;
        RawImage: new (
          data: Uint8Array,
          w: number,
          h: number,
          ch: number
        ) => unknown;
      };
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = false;
      transformers.env.cacheDir = '.cache/models';
      const pipe = await transformers.pipeline('depth-estimation', modelId, {
        device: 'cpu',
        dtype: 'q8',
      });
      const rawImg = new transformers.RawImage(imageRgba, width, height, 4);
      const result = await pipe(rawImg);
      const pred = result.predicted_depth;
      const raw = pred.data;
      const dH =
        pred.height ??
        (pred.dims && pred.dims.length >= 2 ? pred.dims[pred.dims.length - 2]! : height);
      const dW =
        pred.width ??
        (pred.dims && pred.dims.length >= 2 ? pred.dims[pred.dims.length - 1]! : width);
      return {
        depth: normalizeFloatMap(raw, dW * dH),
        depthWidth: dW,
        depthHeight: dH,
        modelUsed: modelId,
        license: 'Apache-2.0',
      };
    } catch {
      // Fallback if offline CI environment does not have cached ONNX weights
    }
  }

  const depth = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const vPrior = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const lum =
        (0.299 * imageRgba[idx]! +
          0.587 * imageRgba[idx + 1]! +
          0.114 * imageRgba[idx + 2]!) /
        255;
      depth[y * width + x] = Math.min(1, Math.max(0, 0.65 * vPrior + 0.35 * lum));
    }
  }
  return {
    depth: normalizeFloatMap(depth, width * height),
    depthWidth: width,
    depthHeight: height,
    modelUsed: 'deterministic-geometric-prior-v1',
    license: 'MIT',
  };
}

function normalizeFloatMap(input: Float32Array, length: number): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < length; i++) {
    const v = input[i] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = ((input[i] ?? 0) - min) / span;
  }
  return out;
}

/**
 * Builds a displaced 3D mesh (.glb), orbiting preview.gif, RC1 manifest, and packed .wgif
 * with manifest.json as the first and STORED zip entry and strict RC1 provenance.
 */
export async function buildWorldFromImage(
  opts: Img2WorldOptions
): Promise<Img2WorldOutput> {
  const gw = opts.gridWidth ?? 64;
  const gh = opts.gridHeight ?? 64;
  const fovDeg = opts.fovDeg ?? 55;
  const depthScale = opts.depthScale ?? 2.2;
  const maxStretch = opts.maxEdgeStretch ?? 0.28;

  const {
    depth: rawDepth,
    depthWidth,
    depthHeight,
    modelUsed,
    license,
  } = await estimateMonocularDepth(opts.imageRgba, opts.width, opts.height, {
    syntheticDepth: opts.syntheticDepth,
    modelId: opts.modelId,
  });

  // 1) Resample depth tensor to image dimensions (if needed) and apply 3x3 median filter
  const imageAlignedDepth = resampleDepthBilinear(
    rawDepth,
    depthWidth,
    depthHeight,
    opts.width,
    opts.height
  );
  const filteredDepth = medianFilter3x3(imageAlignedDepth, opts.width, opts.height);
  // 2) Resample filtered depth to the target mesh grid (gw x gh)
  const gridDepth = resampleDepthBilinear(
    filteredDepth,
    opts.width,
    opts.height,
    gw,
    gh
  );

  const aspect = opts.width / opts.height;
  const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);

  const vertCount = gw * gh;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);

  for (let gy = 0; gy < gh; gy++) {
    const v = gy / (gh - 1);
    for (let gx = 0; gx < gw; gx++) {
      const u = gx / (gw - 1);
      const vi = gy * gw + gx;
      const d = gridDepth[vi]!;
      const zDist = 1.6 + (1.0 - d) * depthScale;
      const ndcX = (u - 0.5) * 2;
      const ndcY = (0.5 - v) * 2;

      positions[vi * 3] = ndcX * aspect * tanHalfFov * zDist;
      positions[vi * 3 + 1] = ndcY * tanHalfFov * zDist + 1.4;
      positions[vi * 3 + 2] = -zDist;
      normals[vi * 3 + 2] = 1;
      uvs[vi * 2] = u;
      uvs[vi * 2 + 1] = v;
    }
  }

  const indicesList: number[] = [];
  for (let gy = 0; gy < gh - 1; gy++) {
    for (let gx = 0; gx < gw - 1; gx++) {
      const a = gy * gw + gx;
      const b = a + 1;
      const c = a + gw;
      const d = c + 1;

      const dA = gridDepth[a]!;
      const dB = gridDepth[b]!;
      const dC = gridDepth[c]!;
      const dD = gridDepth[d]!;

      if (
        Math.abs(dA - dB) <= maxStretch &&
        Math.abs(dA - dC) <= maxStretch &&
        Math.abs(dB - dC) <= maxStretch
      ) {
        indicesList.push(a, c, b);
      }
      if (
        Math.abs(dB - dD) <= maxStretch &&
        Math.abs(dC - dD) <= maxStretch &&
        Math.abs(dB - dC) <= maxStretch
      ) {
        indicesList.push(b, c, d);
      }
    }
  }

  const indices = new Uint16Array(indicesList);
  const pngBytes = encodeDeterministicPng(opts.width, opts.height, opts.imageRgba);
  const glbBytes = packSingleMeshGlb(positions, normals, uvs, indices, pngBytes);
  const previewGifBytes = renderDepthPreviewGif(
    opts.imageRgba,
    filteredDepth,
    opts.width,
    opts.height
  );

  const sourceImageSha256 = createHash('sha256').update(pngBytes).digest('hex');
  const sceneSha256 = createHash('sha256').update(glbBytes).digest('hex');
  const previewSha256 = createHash('sha256').update(previewGifBytes).digest('hex');

  const manifest: Rc1Manifest = {
    wgif: '0.1',
    id: `urn:wgif:img2world:${sourceImageSha256.slice(0, 16)}`,
    title: 'Single-Image Depth World',
    description:
      'Offline monocular depth-displaced 3D world generated by @wgif/img2world.',
    creator: opts.creator ?? {
      name: 'Galactic AI Team (@wgif/img2world)',
      url: 'https://github.com/galactic-ai-team/wgif',
    },
    created: '2026-01-01T00:00:00.000Z',
    license: 'MIT',
    mode: opts.mode ?? 'editable',
    entry: {
      scene: 'scene/world.glb',
      preview: 'preview.gif',
    },
    spawn: {
      position: [0, 1.4, 0.2],
      lookAt: [0, 1.4, -2.5],
    },
    files: [
      {
        path: 'preview.gif',
        sha256: previewSha256,
        size: previewGifBytes.byteLength,
        mediaType: 'image/gif',
      },
      {
        path: 'scene/world.glb',
        sha256: sceneSha256,
        size: glbBytes.byteLength,
        mediaType: 'model/gltf-binary',
      },
    ],
    provenance: {
      parent: `sha256:${sourceImageSha256}`,
      generator: '@wgif/img2world@0.1.0',
      params: {
        origin: 'image-to-world',
        model: modelUsed,
        license,
        source_sha256: sourceImageSha256,
        input_dimensions: [opts.width, opts.height],
        grid_size: [gw, gh],
        fov_deg: fovDeg,
        depth_scale: depthScale,
        max_edge_stretch: maxStretch,
      },
    },
  };

  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(manifest, null, 2) + '\n'
  );
  const wgifBytes = packDeterministicWgifZip([
    { path: 'manifest.json', data: manifestBytes, store: true },
    { path: 'preview.gif', data: previewGifBytes },
    { path: 'scene/world.glb', data: glbBytes },
  ]);

  return {
    glbBytes,
    previewGifBytes,
    wgifBytes,
    depthMap: filteredDepth,
    manifest,
  };
}

function packSingleMeshGlb(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices: Uint16Array,
  pngBytes: Uint8Array
): Uint8Array {
  const pad4 = (n: number) => (4 - (n % 4)) % 4;
  const posB = new Uint8Array(
    positions.buffer,
    positions.byteOffset,
    positions.byteLength
  );
  const normB = new Uint8Array(
    normals.buffer,
    normals.byteOffset,
    normals.byteLength
  );
  const uvB = new Uint8Array(uvs.buffer, uvs.byteOffset, uvs.byteLength);
  const indB = new Uint8Array(
    indices.buffer,
    indices.byteOffset,
    indices.byteLength
  );

  const views: Array<{
    buffer: number;
    byteOffset: number;
    byteLength: number;
    target?: number;
  }> = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  const addPart = (b: Uint8Array, target?: number) => {
    const idx = views.length;
    views.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: b.length,
      ...(target ? { target } : {}),
    });
    parts.push(b);
    const p = pad4(b.length);
    if (p) parts.push(new Uint8Array(p));
    offset += b.length + p;
    return idx;
  };

  const texView = addPart(pngBytes);
  const posView = addPart(posB, 34962);
  const normView = addPart(normB, 34962);
  const uvView = addPart(uvB, 34962);
  const indView = addPart(indB, 34963);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = positions[i + c]!;
      if (v < min[c]!) min[c] = v;
      if (v > max[c]!) max[c] = v;
    }
  }

  const json = {
    asset: { version: '2.0', generator: '@wgif/img2world' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'DisplacedDepthWorld', mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    images: [{ bufferView: texView, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [
      {
        name: 'SourceImageProjected',
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0.0,
          roughnessFactor: 0.9,
        },
        extensions: {
          KHR_materials_unlit: {},
        },
      },
    ],
    bufferViews: views,
    accessors: [
      {
        bufferView: posView,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min,
        max,
      },
      {
        bufferView: normView,
        componentType: 5126,
        count: normals.length / 3,
        type: 'VEC3',
      },
      {
        bufferView: uvView,
        componentType: 5126,
        count: uvs.length / 2,
        type: 'VEC2',
      },
      {
        bufferView: indView,
        componentType: 5123,
        count: indices.length,
        type: 'SCALAR',
      },
    ],
    buffers: [{ byteLength: offset }],
  };

  const jb = new TextEncoder().encode(JSON.stringify(json));
  const jp = pad4(jb.length);
  const jsonChunk = new Uint8Array(jb.length + jp);
  jsonChunk.set(jb);
  jsonChunk.fill(0x20, jb.length);

  const binChunk = new Uint8Array(offset);
  let pOff = 0;
  for (const part of parts) {
    binChunk.set(part, pOff);
    pOff += part.length;
  }

  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunk.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  const bPos = 20 + jsonChunk.length;
  dv.setUint32(bPos, binChunk.length, true);
  dv.setUint32(bPos + 4, 0x004e4942, true);
  out.set(binChunk, bPos + 8);
  return out;
}

function renderDepthPreviewGif(
  rgba: Uint8Array,
  depth: Float32Array,
  srcW: number,
  srcH: number
): Uint8Array {
  const outW = Math.min(160, srcW);
  const outH = Math.min(120, srcH);
  const palette = new Uint8Array(64 * 3);
  for (let i = 0; i < 64; i++) {
    const r = ((i >>> 4) & 3) * 85;
    const g = ((i >>> 2) & 3) * 85;
    const b = (i & 3) * 85;
    palette[i * 3] = r;
    palette[i * 3 + 1] = g;
    palette[i * 3 + 2] = b;
  }

  const frames: Uint8Array[] = [];
  for (let f = 0; f < 12; f++) {
    const shift = Math.sin((f / 12) * Math.PI * 2) * 8;
    const frame = new Uint8Array(outW * outH);
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(srcH - 1, Math.floor((y / outH) * srcH));
      for (let x = 0; x < outW; x++) {
        const sxBase = Math.min(srcW - 1, Math.floor((x / outW) * srcW));
        const d = depth[sy * srcW + sxBase]!;
        const sx = Math.max(
          0,
          Math.min(srcW - 1, Math.round(sxBase + shift * d))
        );
        const pIdx = (sy * srcW + sx) * 4;
        const r = rgba[pIdx]! >>> 6;
        const g = rgba[pIdx + 1]! >>> 6;
        const b = rgba[pIdx + 2]! >>> 6;
        frame[y * outW + x] = (r << 4) | (g << 2) | b;
      }
    }
    frames.push(frame);
  }
  return encodeAnimatedGif89a(outW, outH, palette, frames, 8);
}