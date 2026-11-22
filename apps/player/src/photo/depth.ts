/**
 * Monocular depth estimation in the browser: Depth Anything V2 Small (Apache-2.0), ONNX export by
 * onnx-community, run with onnxruntime-web. Nothing of it is in the player bundle: the runtime
 * (from jsDelivr) and the model (from Hugging Face) are fetched the first time the creator makes a
 * 3D scene, checked against pinned SHA-256 hashes, and kept in Cache Storage so later uses (and
 * offline use) need no network. WebGPU when the browser has it, otherwise WebAssembly on one
 * thread (so no cross-origin isolation is needed, docs/notes/onnx-wasm-coop-coep.md).
 *
 * `?depth=mock` (tests) skips all of it and returns a synthetic depth map.
 */
import { normalizeDepth, syntheticDepth, type DepthMap } from './mesh.js';
import type { DepthInfo, Picture } from './world.js';

export const MODEL = {
  repo: 'onnx-community/depth-anything-v2-small',
  revision: '4472b7362082ad9968fee890ca0f1e5aca36b93d',
  file: 'onnx/model_quantized.onnx',
  bytes: 27_258_801,
  sha256: 'fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d',
  license: 'Apache-2.0',
} as const;

/**
 * The WebGPU file is NOT the int8 one. `model_quantized.onnx` is a dynamic-int8 graph: 79
 * DynamicQuantizeLinear + 48 MatMulInteger + 31 ConvInteger nodes, none of which the WebGPU
 * execution provider implements, so every one falls back to the CPU with a GPU↔CPU copy each
 * (another int8 graph measured 0.18x and all-NaN that way). `model_q4f16.onnx` is the same Small
 * checkpoint with 4-bit weights: 48 MatMulNBits nodes, which the WebGPU provider does implement,
 * and it is smaller (19.1 MB vs 27.3 MB). Same float32 input, same output. On a synthetic test
 * picture its depth tracks the int8 reference at correlation 0.95 (mean absolute difference 0.07
 * on normalised depth); check it on real photos before relying on it. The wasm path keeps int8:
 * the WASM provider runs MatMulInteger/ConvInteger natively with SIMD.
 */
export const WEBGPU_MODEL = {
  file: 'onnx/model_q4f16.onnx',
  bytes: 19_126_267,
  sha256: 'eca72971aea64216d767c70c534160de53b5435b588d362bac6dbd5a73f9bf1e',
} as const;

const ORT_VERSION = '1.31.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

interface Pinned {
  file: string;
  sha256: string;
  bytes: number;
}

/** The runtime files per backend (hashes of the published npm package). */
const RUNTIME: Record<'wasm' | 'webgpu', { main: Pinned; glue: Pinned; wasm: Pinned }> = {
  wasm: {
    main: { file: 'ort.wasm.min.mjs', sha256: 'c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234', bytes: 53_725 },
    glue: { file: 'ort-wasm-simd-threaded.mjs', sha256: '30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3', bytes: 24_738 },
    wasm: { file: 'ort-wasm-simd-threaded.wasm', sha256: '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d', bytes: 14_848_852 },
  },
  webgpu: {
    main: { file: 'ort.webgpu.min.mjs', sha256: '329cd956772397a1aedd668e911195d39afefb182f6fc14aafa4f08ac8d8f379', bytes: 70_742 },
    glue: { file: 'ort-wasm-simd-threaded.asyncify.mjs', sha256: '59cf781530e1a16df2a291d78798e3ec1152467edaec402d6f9599d85047c302', bytes: 53_457 },
    wasm: { file: 'ort-wasm-simd-threaded.asyncify.wasm', sha256: 'ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec', bytes: 28_747_738 },
  },
};

const modelUrl = (file: string): string => `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${file}`;
const CACHE = 'wgif-depth-v1';

export type Backend = 'webgpu' | 'wasm' | 'mock';

export interface Progress {
  /** What is happening, for the status line. */
  stage: string;
  /** 0..1 when known. */
  fraction: number | null;
}

/** The slice of onnxruntime-web this file uses (it is loaded at run time, so no compile-time import). */
interface OrtTensor {
  data: Float32Array;
  dims: readonly number[];
}
interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
interface Ort {
  env: { wasm: { numThreads?: number; wasmPaths?: unknown; wasmBinary?: ArrayBuffer | Uint8Array; proxy?: boolean }; logLevel?: string };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<OrtSession> };
}

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE);
  } catch {
    return null; // private mode on some browsers
  }
}

/** Fetches (or takes from the cache) one pinned file and checks its hash. */
async function fetchPinned(url: string, pin: { sha256: string; bytes: number }, label: string, onProgress: (p: Progress) => void): Promise<Uint8Array> {
  const cache = await openCache();
  const cached = await cache?.match(url);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (bytes.length === pin.bytes && hex(await crypto.subtle.digest('SHA-256', bytes)) === pin.sha256) return bytes;
    await cache?.delete(url); // damaged: fetch again
  }
  onProgress({ stage: `Downloading ${label}…`, fraction: 0 });
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error(`could not download ${label} (HTTP ${res.status})`);
  const out = new Uint8Array(pin.bytes);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) throw new Error(`${label} is not the expected file`);
    out.set(value, got);
    got += value.length;
    onProgress({ stage: `Downloading ${label}… ${(got / 1e6).toFixed(1)} / ${(pin.bytes / 1e6).toFixed(1)} MB`, fraction: got / pin.bytes });
  }
  if (got !== pin.bytes || hex(await crypto.subtle.digest('SHA-256', out)) !== pin.sha256) throw new Error(`${label} did not match its pinned hash, not used`);
  try {
    await cache?.put(url, new Response(out, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch {
    // Out of storage: it still works this time.
  }
  return out;
}

/** True when the model and a runtime are already stored (no download needed). */
export async function depthCached(): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  const has = async (url: string): Promise<boolean> => !!(await cache.match(url));
  // Either backend ready counts: the WebGPU file is q4f16, the wasm file is int8.
  const webgpuReady =
    (await has(modelUrl(WEBGPU_MODEL.file))) && (await has(ORT_BASE + RUNTIME.webgpu.wasm.file));
  const wasmReady =
    (await has(modelUrl(MODEL.file))) && (await has(ORT_BASE + RUNTIME.wasm.wasm.file));
  return webgpuReady || wasmReady;
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

const blobUrl = (bytes: Uint8Array, type: string): string => URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));

let loaded: { backend: 'webgpu' | 'wasm'; session: OrtSession; ort: Ort; loadMs: number } | null = null;

async function loadRuntime(backend: 'webgpu' | 'wasm', onProgress: (p: Progress) => void): Promise<Ort> {
  const files = RUNTIME[backend];
  const [main, glue, wasm] = await Promise.all([
    fetchPinned(ORT_BASE + files.main.file, files.main, 'the runtime', () => {}),
    fetchPinned(ORT_BASE + files.glue.file, files.glue, 'the runtime', () => {}),
    fetchPinned(ORT_BASE + files.wasm.file, files.wasm, 'the runtime', onProgress),
  ]);
  const ort = (await import(/* @vite-ignore */ blobUrl(main, 'text/javascript'))) as Ort;
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.proxy = true;
  ort.env.wasm.wasmPaths = { mjs: blobUrl(glue, 'text/javascript') };
  ort.env.wasm.wasmBinary = wasm;
  ort.env.logLevel = 'error';
  return ort;
}

/** Loads the model once per page (download on first use, then from the cache). */
export async function loadDepth(prefer: Backend | 'auto', onProgress: (p: Progress) => void = () => {}): Promise<{ backend: 'webgpu' | 'wasm'; loadMs: number }> {
  if (loaded && (prefer === 'auto' || prefer === loaded.backend)) return { backend: loaded.backend, loadMs: loaded.loadMs };
  const t0 = performance.now();
  const order: ('webgpu' | 'wasm')[] = prefer === 'wasm' ? ['wasm'] : prefer === 'webgpu' ? ['webgpu', 'wasm'] : (await hasWebGpu()) ? ['webgpu', 'wasm'] : ['wasm'];
  let last: unknown = null;
  for (const backend of order) {
    try {
      // The model file is per backend (q4f16 for WebGPU, int8 for wasm), so it is fetched here,
      // inside the loop: a WebGPU failure that falls back to wasm fetches the int8 file then.
      const pin = backend === 'webgpu' ? WEBGPU_MODEL : MODEL;
      const model = await fetchPinned(modelUrl(pin.file), pin, `the depth model (once, ~${(pin.bytes / 1e6).toFixed(0)} MB)`, onProgress);
      onProgress({ stage: `Starting the depth model (${backend === 'webgpu' ? 'GPU' : 'CPU'})…`, fraction: null });
      const ort = await loadRuntime(backend, onProgress);
      const session = await ort.InferenceSession.create(model, { executionProviders: [backend], graphOptimizationLevel: 'all' });
      loaded = { backend, session, ort, loadMs: Math.round(performance.now() - t0) };
      return { backend, loadMs: loaded.loadMs };
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`the depth model could not start: ${(last as Error)?.message ?? last}`);
}

/** Model input size: long side `long`, both sides multiples of 14 (the ViT patch). */
export function inputSize(w: number, h: number, long: number): [number, number] {
  const s = long / Math.max(w, h);
  const r = (v: number): number => Math.max(14, Math.round((v * s) / 14) * 14);
  return [r(w), r(h)];
}

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

/** Resizes with a canvas (fast, smooth) and lays the pixels out as a normalised NCHW tensor. */
function toTensor(p: Picture, w: number, h: number): Float32Array {
  const src = document.createElement('canvas');
  src.width = p.width;
  src.height = p.height;
  src.getContext('2d')!.putImageData(new ImageData(p.rgba as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0);
  const dst = document.createElement('canvas');
  dst.width = w;
  dst.height = h;
  const ctx = dst.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(3 * w * h), plane = w * h;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (px[i * 4 + c]! / 255 - MEAN[c]!) / STD[c]!;
  }
  return out;
}

export interface DepthResult {
  depth: DepthMap;
  info: DepthInfo;
  /** Time to get the model running (download or cache, runtime start), ms; 0 when it already was. */
  loadMs: number;
}

/** Estimates depth for a picture. */
export async function estimateDepth(p: Picture, prefer: Backend | 'auto', onProgress: (p: Progress) => void = () => {}): Promise<DepthResult> {
  if (prefer === 'mock') {
    return { depth: syntheticDepth(p.rgba, p.width, p.height), info: { model: 'synthetic', revision: '-', license: '-', backend: 'mock', inputSize: [p.width, p.height], ms: 0 }, loadMs: 0 };
  }
  const was = loaded;
  const { backend, loadMs } = await loadDepth(prefer, onProgress);
  const { session, ort } = loaded!;
  const [w, h] = inputSize(p.width, p.height, backend === 'webgpu' ? 518 : 392);
  onProgress({ stage: 'Estimating depth…', fraction: null });
  const t0 = performance.now();
  const input = new ort.Tensor('float32', toTensor(p, w, h), [1, 3, h, w]);
  const out = await session.run({ [session.inputNames[0]!]: input });
  const t = out[session.outputNames[0]!]!;
  const dims = t.dims, oh = dims[dims.length - 2]!, ow = dims[dims.length - 1]!;
  const ms = Math.round(performance.now() - t0);
  return { depth: normalizeDepth(t.data, ow, oh), info: { model: MODEL.repo, revision: MODEL.revision, license: MODEL.license, backend, inputSize: [w, h], ms }, loadMs: was === loaded ? 0 : loadMs };
}
