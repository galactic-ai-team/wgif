import { createHash } from 'node:crypto';
import {
  encodeAnimatedGif89a,
  encodeDeterministicPng,
} from '../../../examples/court/src/prng.js';

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
}

export interface Img2WorldOutput {
  glbBytes: Uint8Array;
  previewGifBytes: Uint8Array;
  depthMap: Float32Array; // normalized [0, 1], 1 = near, 0 = far
  manifest: Record<string, unknown>;
}

/**
 * Estimates normalized inverse depth [0..1] on CPU.
 * Uses @huggingface/transformers (onnx-community/depth-anything-v2-small, Apache-2.0)
 * when available and syntheticDepth is false; falls back to deterministic edge-aware depth in CI.
 */
export async function estimateMonocularDepth(
  imageRgba: Uint8Array,
  width: number,
  height: number,
  options: { syntheticDepth?: boolean; modelId?: string } = {}
): Promise<{ depth: Float32Array; modelUsed: string; license: string }> {
  const modelId = options.modelId ?? 'onnx-community/depth-anything-v2-small';

  if (!options.syntheticDepth) {
    try {
      const transformers = await import('@huggingface/transformers');
      transformers.env.allowLocalModels = true;
      transformers.env.cacheDir = '.cache/models';
      const pipe = await transformers.pipeline('depth-estimation', modelId, {
        device: 'cpu',
        dtype: 'q8',
      });
      const rawImg = new transformers.RawImage(imageRgba, width, height, 4);
      const result = (await pipe(rawImg)) as {
        predicted_depth: { data: Float32Array };
      };
      const raw = result.predicted_depth.data;
      const out = normalizeFloatMap(raw, width * height);
      return {
        depth: out,
        modelUsed: modelId,
        license: 'Apache-2.0',
      };
    } catch {
      // Fallback if offline CI environment does not have cached ONNX weights
    }
  }

  // Deterministic offline fallback depth estimator (vertical perspective prior + luminance cue)
  const depth = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const vPrior = y / Math.max(1, height - 1); // lower pixels closer
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
 * Builds a displaced 3D mesh (.glb), orbiting preview.gif, and WGIF manifest from a single image.
 */
export async function buildWorldFromImage(
  opts: Img2WorldOptions
): Promise<Img2WorldOutput> {
  const gw = opts.gridWidth ?? 64;
  const gh = opts.gridHeight ?? 64;
  const fovDeg = opts.fovDeg ?? 55;
  const depthScale = opts.depthScale ?? 2.2;
  const maxStretch = opts.maxEdgeStretch ?? 0.28;

  const { depth, modelUsed, license } = await estimateMonocularDepth(
    opts.imageRgba,
    opts.width,
    opts.height,
    { syntheticDepth: opts.syntheticDepth, modelId: opts.modelId }
  );

  const aspect = opts.width / opts.height;
  const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);

  const vertCount = gw * gh;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const gridDepth = new Float32Array(vertCount);

  for (let gy = 0; gy < gh; gy++) {
    const v = gy / (gh - 1);
    const sy = Math.min(opts.height - 1, Math.floor(v * (opts.height - 1)));
    for (let gx = 0; gx < gw; gx++) {
      const u = gx / (gw - 1);
      const sx = Math.min(opts.width - 1, Math.floor(u * (opts.width - 1)));
      const d = depth[sy * opts.width + sx]!; // 1 = near, 0 = far
      const zDist = 1.6 + (1.0 - d) * depthScale;
      const ndcX = (u - 0.5) * 2;
      const ndcY = (0.5 - v) * 2;

      const vi = gy * gw + gx;
      gridDepth[vi] = d;
      positions[vi * 3] = ndcX * aspect * tanHalfFov * zDist;
      positions[vi * 3 + 1] = ndcY * tanHalfFov * zDist + 1.4;
      positions[vi * 3 + 2] = -zDist;
      normals[vi * 3 + 2] = 1;
      uvs[vi * 2] = u;
      uvs[vi * 2 + 1] = v;
    }
  }

  // Build triangles, skipping steep disocclusion cliffs > maxStretch to prevent rubber-sheet artifacts
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
    depth,
    opts.width,
    opts.height
  );

  const sourceImageSha256 = createHash('sha256').update(pngBytes).digest('hex');
  const sceneSha256 = createHash('sha256').update(glbBytes).digest('hex');
  const previewSha256 = createHash('sha256').update(previewGifBytes).digest('hex');

  const manifest = {
    wgif_version: '0.1.0',
    id: `urn:wgif:img2world:${sourceImageSha256.slice(0, 16)}`,
    title: 'Single-Image Depth World',
    created_at: '2026-01-01T00:00:00.000Z',
    license: 'MIT',
    entrypoints: {
      scene: 'scene/world.glb',
      preview: 'preview.gif',
    },
    camera: {
      default_mode: 'orbit',
      spawn: {
        position: [0, 1.4, 0.2],
        target: [0, 1.4, -2.5],
        fov_deg: fovDeg,
      },
    },
    provenance: {
      origin: 'image-to-world',
      source_inputs: [
        {
          role: 'primary_image',
          mime_type: 'image/png',
          sha256: sourceImageSha256,
          dimensions: [opts.width, opts.height],
        },
      ],
      generator: {
        name: '@wgif/img2world',
        version: '0.1.0',
        model: {
          id: modelUsed,
          license,
        },
        parameters: {
          grid_size: [gw, gh],
          fov_deg: fovDeg,
          depth_scale: depthScale,
          max_edge_stretch: maxStretch,
        },
      },
      assets: [
        { path: 'scene/world.glb', sha256: sceneSha256 },
        { path: 'preview.gif', sha256: previewSha256 },
      ],
    },
  };

  return {
    glbBytes,
    previewGifBytes,
    depthMap: depth,
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
  const posB = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  const normB = new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength);
  const uvB = new Uint8Array(uvs.buffer, uvs.byteOffset, uvs.byteLength);
  const indB = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);

  const views: Array<{ buffer: number; byteOffset: number; byteLength: number; target?: number }> = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  const addPart = (b: Uint8Array, target?: number) => {
    const idx = views.length;
    views.push({ buffer: 0, byteOffset: offset, byteLength: b.length, ...(target ? { target } : {}) });
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
      },
    ],
    bufferViews: views,
    accessors: [
      { bufferView: posView, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: normView, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: uvView, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
      { bufferView: indView, componentType: 5123, count: indices.length, type: 'SCALAR' },
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
  // 64-color RGB332-like quantized palette
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
        const sx = Math.max(0, Math.min(srcW - 1, Math.round(sxBase + shift * d)));
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
