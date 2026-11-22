/**
 * Builds a .wgif from a picture (or a GIF's frames) and, for the 3D mode, its depth map.
 *
 * What goes in the file: the textured mesh (world.glb, with the first frame as its texture), the
 * computed depth map (assets/depth.png, 8-bit, so the scene can be rebuilt or improved later
 * without the model), for a GIF a sprite sheet of its frames (assets/frames.jpg), a preview and
 * the interactions entry that frames the view and runs the animation. The depth model itself is
 * never packed. Everything is kept inside the size budgets (scripts/size-budgets.json).
 *
 * Pure apart from the injected image codec, so it runs in Node tests with a PNG encoder and in the
 * page with canvas JPEG.
 */
import { packWgif, utf8, type ManifestInput, type WgifFiles } from '@wgif/format';
import { writeGlb, type GlbMaterial, type GlbNode } from './glb.js';
import { buildPhotoMesh, type DepthMap, type EdgeMode, type MeshData } from './mesh.js';

export interface Picture {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface Encoded {
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface ImageCodec {
  /** `quality` 0..1 applies to JPEG; a codec may answer with PNG instead (tests do). */
  encode(p: Picture, type: 'image/jpeg' | 'image/png', quality: number): Promise<Encoded>;
}

export type PhotoMode = '3d' | 'flat';

export interface DepthInfo {
  model: string;
  revision: string;
  license: string;
  /** e.g. "webgpu", "wasm", "mock". */
  backend: string;
  inputSize: [number, number];
  ms: number;
}

export interface PhotoWorldInput {
  /** One picture, or a GIF's frames (already sampled), all the same size. */
  frames: Picture[];
  delaysMs?: number[];
  depth: DepthMap | null;
  mode: PhotoMode;
  strength?: number;
  edge?: EdgeMode;
  title?: string;
  /** File name of the source, for the credits. */
  sourceName?: string;
  depthInfo?: DepthInfo | null;
  /** A rendered preview (PNG); without one the picture itself is used. */
  preview?: Uint8Array;
  /** ISO time; defaults to now. */
  created?: string;
}

export interface PhotoWorld {
  bytes: Uint8Array;
  manifest: ManifestInput;
  files: WgifFiles;
  /** Bytes per payload, before zipping. */
  sizes: Record<string, number>;
  focus: [number, number, number];
  eye: [number, number, number];
  /** Triangles dropped at depth edges (3D mode). */
  cut: number;
  vertices: number;
}

/** From scripts/size-budgets.json (world total, world.glb expanded, preview, any other entry). */
export const BUDGET = { total: 1024 * 1024, glb: 768 * 1024, preview: 256 * 1024, entry: 256 * 1024 } as const;

export const PHOTO_NODE = 'photo';
export const BACK_NODE = 'photo_back';
export const FRAMES_FILE_BASE = 'assets/frames';
export const DEPTH_FILE = 'assets/depth.png';
/** GIFs are capped at this many frames in the file. */
export const MAX_FRAMES = 48;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Area-averaging resize (good for big downscales; plain bilinear when enlarging). */
export function resize(p: Picture, w: number, h: number): Picture {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w === p.width && h === p.height) return p;
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = p.width / w, sy = p.height / h, src = p.rgba;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy, y1 = Math.min(p.height, y0 + Math.max(1, sy));
    for (let x = 0; x < w; x++) {
      const x0 = x * sx, x1 = Math.min(p.width, x0 + Math.max(1, sx));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          const o = (Math.min(p.height - 1, yy) * p.width + Math.min(p.width - 1, xx)) * 4, wt = wx * wy;
          r += src[o]! * wt;
          g += src[o + 1]! * wt;
          b += src[o + 2]! * wt;
          a += src[o + 3]! * wt;
          wsum += wt;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / wsum;
      out[o + 1] = g / wsum;
      out[o + 2] = b / wsum;
      out[o + 3] = a / wsum;
    }
  }
  return { width: w, height: h, rgba: out };
}

/** Scales so the longer side is at most `long` (never enlarges). */
export const fit = (p: Picture, long: number): Picture => {
  const s = Math.min(1, long / Math.max(p.width, p.height));
  return s >= 1 ? p : resize(p, p.width * s, p.height * s);
};

/** Transparent pixels (GIFs) over a dark backdrop, so the JPEG has no black fringes surprises. */
function flatten(p: Picture, bg: [number, number, number] = [18, 18, 24]): Picture {
  let any = false;
  for (let i = 3; i < p.rgba.length; i += 4) if (p.rgba[i]! < 255) { any = true; break; }
  if (!any) return p;
  const out = new Uint8ClampedArray(p.rgba.length);
  for (let i = 0; i < p.rgba.length; i += 4) {
    const a = p.rgba[i + 3]! / 255;
    out[i] = p.rgba[i]! * a + bg[0] * (1 - a);
    out[i + 1] = p.rgba[i + 1]! * a + bg[1] * (1 - a);
    out[i + 2] = p.rgba[i + 2]! * a + bg[2] * (1 - a);
    out[i + 3] = 255;
  }
  return { width: p.width, height: p.height, rgba: out };
}

function depthPicture(d: DepthMap, long = 256): Picture {
  const rgba = new Uint8ClampedArray(d.width * d.height * 4);
  for (let i = 0; i < d.data.length; i++) {
    const v = Math.round(clamp(d.data[i]!, 0, 1) * 255);
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return fit({ width: d.width, height: d.height, rgba }, long);
}

/**
 * The still background of an animation: per-pixel median of up to `samples` frames. Depth is
 * estimated on this, so a moving thing (a bouncing ball) does not leave a frozen bump in the mesh;
 * it plays across the background's surface instead.
 */
export function medianFrame(frames: Picture[], samples = 9): Picture {
  if (frames.length <= 2) return frames[0]!;
  const pick = Array.from({ length: Math.min(samples, frames.length) }, (_, i) => frames[Math.floor((i * frames.length) / Math.min(samples, frames.length))]!);
  const { width, height } = pick[0]!;
  const out = new Uint8ClampedArray(width * height * 4), v = new Uint8Array(pick.length), mid = pick.length >> 1;
  for (let i = 0; i < out.length; i++) {
    for (let k = 0; k < pick.length; k++) v[k] = pick[k]!.rgba[i]!;
    v.sort();
    out[i] = v[mid]!;
  }
  return { width, height, rgba: out };
}

/** Reads assets/depth.png pixels back into a depth map (red channel). */
export function depthFromPicture(p: Picture): DepthMap {
  const data = new Float32Array(p.width * p.height);
  for (let i = 0; i < data.length; i++) data[i] = p.rgba[i * 4]! / 255;
  return { width: p.width, height: p.height, data };
}

// ---- small meshes for the room -----------------------------------------------------------------

function meshOf(positions: number[], normals: number[], uvs: number[], indices: number[]): MeshData {
  const pos = new Float32Array(positions);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) {
    const k = i % 3;
    min[k] = Math.min(min[k]!, pos[i]!);
    max[k] = Math.max(max[k]!, pos[i]!);
  }
  return { positions: pos, normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint16Array(indices), min, max };
}

/** An axis-aligned box, faces pointing out. */
export function boxMesh(c: [number, number, number], s: [number, number, number]): MeshData {
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
  const h = s.map((v) => v / 2) as [number, number, number];
  const faces: [number, [number, number, number], [number, number, number], [number, number, number]][] = [
    [0, [1, 0, 0], [0, 0, -1], [0, 1, 0]], [0, [-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [1, [0, 1, 0], [1, 0, 0], [0, 0, -1]], [1, [0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [2, [0, 0, 1], [1, 0, 0], [0, 1, 0]], [2, [0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [, n, u, v] of faces) {
    const base = P.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let k = 0; k < 3; k++) P.push(c[k]! + (n[k]! + u[k]! * a + v[k]! * b) * h[k]!);
      N.push(...n);
      U.push((a + 1) / 2, (1 - b) / 2);
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return meshOf(P, N, U, I);
}

/** A flat disc at height y, facing up. */
export function discMesh(cx: number, cz: number, y: number, r: number, seg = 48): MeshData {
  const P = [cx, y, cz], N = [0, 1, 0], U = [0.5, 0.5], I: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    P.push(cx + Math.cos(a) * r, y, cz - Math.sin(a) * r);
    N.push(0, 1, 0);
    U.push(0.5 + Math.cos(a) / 2, 0.5 - Math.sin(a) / 2);
    if (i > 0) I.push(0, i, i + 1);
  }
  return meshOf(P, N, U, I);
}

/** A rectangle facing +Z, centred at c. */
function quadMesh(c: [number, number, number], w: number, h: number): MeshData {
  const [x, y, z] = c;
  return meshOf(
    [x - w / 2, y + h / 2, z, x - w / 2, y - h / 2, z, x + w / 2, y + h / 2, z, x + w / 2, y - h / 2, z],
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 0, 0, 1, 1, 0, 1, 1],
    [0, 1, 2, 2, 1, 3],
  );
}

// ---- the world ---------------------------------------------------------------------------------

export interface PhotoFramingAndBackdrop {
  floorY: number;
  floorColor: [number, number, number];
  skyColor: [number, number, number];
  pivotDistance: number;
}

/**
 * Derives seamless floor height, edge-matched backdrop colors, and median-depth
 * orbit pivot directly from the source picture and generated mesh positions.
 */
export function computePhotoFramingAndBackdrop(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  positions: Float32Array,
  gridCols: number,
  gridRows: number,
  near = 3,
  k = 1.6,
  medianDisparity = 0.5,
): PhotoFramingAndBackdrop {
  const sampleBand = (yStart: number, yEnd: number, darken: number): [number, number, number] => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        r += rgba[i] ?? 0;
        g += rgba[i + 1] ?? 0;
        b += rgba[i + 2] ?? 0;
        n++;
      }
    }
    if (n === 0) return [0.05, 0.05, 0.07];
    const s = darken / (255 * n);
    return [r * s, g * s, b * s];
  };

  const bandRows = Math.max(1, Math.floor(height * 0.05));
  const skyColor = sampleBand(0, bandRows, 0.42);
  const floorColor = sampleBand(height - bandRows, height, 0.35);

  let bottomMinY = Infinity;
  const lastRowOffset = (gridRows - 1) * gridCols;
  for (let c = 0; c < gridCols; c++) {
    const y = positions[(lastRowOffset + c) * 3 + 1]!;
    if (y < bottomMinY) bottomMinY = y;
  }
  const floorY = Number.isFinite(bottomMinY) ? bottomMinY - 0.02 : 0;
  const pivotDistance = (near * (1 + k)) / (1 + k * clamp(medianDisparity, 0, 1));
  return { floorY, floorColor, skyColor, pivotDistance };
}

interface Scene {
  nodes: GlbNode[];
  materials: GlbMaterial[];
  focus: [number, number, number];
  eye: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  statics: string[];
  cut: number;
  vertices: number;
  alsoNodes: string[];
  backdrop?: { sky: [number, number, number]; floor: [number, number, number] };
}

function scene3d(first: Picture, depth: DepthMap | null, aspect: number, strength: number, edge: EdgeMode, detail: number): Scene {
  // First pass at a dummy eye to learn how far down the far edge goes, then lift the eye so the
  // whole picture stands cleanly above the floor.
  const probe = buildPhotoMesh(depth, { aspect, strength, edge, detail: 4 });
  const tanY = Math.tan((50 * Math.PI) / 360);
  const farZ = probe.back ? probe.far * 1.04 : 3;
  const eyeY = tanY * farZ + 0.05;
  const m = buildPhotoMesh(depth, { aspect, strength, edge, detail, eye: [0, eyeY, 0] });
  const backdrop = computePhotoFramingAndBackdrop(
    first.rgba,
    first.width,
    first.height,
    m.surface.positions,
    m.cols + 1,
    m.rows + 1,
    3,
    1.6 * strength,
  );
  const radius = Math.max(6, farZ * 1.1);
  const nodes: GlbNode[] = [
    { name: PHOTO_NODE, mesh: m.surface, material: 0 },
    { name: 'floor', mesh: discMesh(0, -farZ * 0.55, backdrop.floorY, radius), material: 2, extras: { wgif: { collider: 'static' } } },
  ];
  if (m.back) nodes.splice(1, 0, { name: BACK_NODE, mesh: m.back, material: 1 });
  return {
    nodes,
    materials: [
      { name: 'photo', color: [1, 1, 1, 1], glow: 0, doubleSided: true },
      { name: 'photo_back', color: [0.22, 0.22, 0.25, 1], glow: 0, doubleSided: true },
      { name: 'floor', color: [...backdrop.floorColor, 1], rough: 0.95 },
    ],
    focus: m.focus,
    eye: m.eye,
    bounds: { min: [-radius, backdrop.floorY, -farZ * 0.55 - radius], max: [radius, eyeY * 2 + 4, radius] },
    statics: ['floor'],
    cut: m.cut,
    vertices: m.surface.positions.length / 3,
    alsoNodes: m.back ? [BACK_NODE] : [],
    backdrop: { sky: backdrop.skyColor, floor: backdrop.floorColor },
  };
}

function sceneFlat(aspect: number): Scene {
  // A small dark room with the picture hung as a lit screen on the far wall.
  const maxW = 4.4, maxH = 2.7;
  const w = aspect >= maxW / maxH ? maxW : maxH * aspect, h = w / aspect;
  const cy = Math.max(1.75, h / 2 + 0.45), z = -4.9;
  const X = 4, Z = 5, H = Math.max(3.6, cy + h / 2 + 0.6);
  const nodes: GlbNode[] = [
    { name: PHOTO_NODE, mesh: quadMesh([0, cy, z + 0.06], w, h), material: 0 },
    { name: 'screen_frame', mesh: boxMesh([0, cy, z + 0.02], [w + 0.16, h + 0.16, 0.06]), material: 1 },
    { name: 'floor', mesh: boxMesh([0, -0.05, 0], [2 * X, 0.1, 2 * Z]), material: 2, extras: { wgif: { collider: 'static' } } },
    { name: 'wall_back', mesh: boxMesh([0, H / 2, -Z - 0.05], [2 * X, H, 0.1]), material: 3, extras: { wgif: { collider: 'static' } } },
    { name: 'wall_left', mesh: boxMesh([-X - 0.05, H / 2, 0], [0.1, H, 2 * Z]), material: 3, extras: { wgif: { collider: 'static' } } },
    { name: 'wall_right', mesh: boxMesh([X + 0.05, H / 2, 0], [0.1, H, 2 * Z]), material: 3, extras: { wgif: { collider: 'static' } } },
  ];
  return {
    nodes,
    materials: [
      { name: 'photo', color: [1, 1, 1, 1], glow: 0, doubleSided: true },
      { name: 'frame', color: [0.08, 0.08, 0.09, 1], rough: 0.6 },
      { name: 'floor', color: [0.16, 0.15, 0.17, 1], rough: 0.9 },
      { name: 'wall', color: [0.24, 0.24, 0.27, 1], rough: 0.95 },
    ],
    focus: [0, cy, z],
    eye: [0, 1.7, 1.2],
    bounds: { min: [-X + 0.3, 0, -Z + 0.3], max: [X - 0.3, H, Z - 0.3] },
    statics: ['floor', 'wall_back', 'wall_left', 'wall_right'],
    cut: 0,
    vertices: 4,
    alsoNodes: [],
  };
}

/** Lays frames out on a sprite sheet: the most cells that fit `maxSide`, at `cellLong` px. */
export function atlasLayout(count: number, aspect: number, cellLong: number, maxSide = 2048): { columns: number; rows: number; cw: number; ch: number } {
  let cw = aspect >= 1 ? cellLong : Math.round(cellLong * aspect), ch = aspect >= 1 ? Math.round(cellLong / aspect) : cellLong;
  // As square a sheet as possible.
  const columns = clamp(Math.ceil(Math.sqrt((count * ch) / cw)), 1, count), rows = Math.ceil(count / columns);
  const s = Math.min(1, maxSide / (columns * cw), maxSide / (rows * ch));
  cw = Math.max(8, Math.floor(cw * s));
  ch = Math.max(8, Math.floor(ch * s));
  return { columns, rows, cw, ch };
}

async function encodeAtlas(frames: Picture[], codec: ImageCodec, budget: number): Promise<{ enc: Encoded; columns: number; rows: number }> {
  const aspect = frames[0]!.width / frames[0]!.height;
  for (const cellLong of [320, 256, 200, 160, 128, 96]) {
    const { columns, rows, cw, ch } = atlasLayout(frames.length, aspect, cellLong);
    const sheet = new Uint8ClampedArray(columns * cw * rows * ch * 4);
    const W = columns * cw;
    frames.forEach((f, i) => {
      const cell = resize(flatten(f), cw, ch);
      const ox = (i % columns) * cw, oy = Math.floor(i / columns) * ch;
      for (let y = 0; y < ch; y++) sheet.set(cell.rgba.subarray(y * cw * 4, (y + 1) * cw * 4), ((oy + y) * W + ox) * 4);
    });
    for (const q of [0.8, 0.7, 0.6]) {
      const enc = await codec.encode({ width: W, height: rows * ch, rgba: sheet }, 'image/jpeg', q);
      if (enc.bytes.length <= budget) return { enc, columns, rows };
    }
  }
  throw new Error('the GIF frames do not fit in the size budget');
}

const extOf = (e: Encoded): string => (e.mimeType === 'image/png' ? 'png' : 'jpg');

export async function buildPhotoWorld(input: PhotoWorldInput, codec: ImageCodec): Promise<PhotoWorld> {
  if (input.frames.length === 0) throw new Error('no picture');
  const first = flatten(input.frames[0]!);
  const aspect = first.width / first.height;
  const mode = input.mode === '3d' && input.depth ? '3d' : 'flat';
  const strength = clamp(input.strength ?? 1, 0, 2);
  const edge = input.edge ?? 'cut';
  const animated = input.frames.length > 1;
  const files: WgifFiles = {};

  // Animation sheet first (it has the tightest budget of its own).
  let framesEntry: Record<string, unknown> | null = null;
  if (animated) {
    const frames = input.frames.slice(0, MAX_FRAMES);
    const atlas = await encodeAtlas(frames, codec, BUDGET.entry - 4096);
    const file = `${FRAMES_FILE_BASE}.${extOf(atlas.enc)}`;
    files[file] = atlas.enc.bytes;
    const delays = frames.map((_, i) => Math.round(clamp(input.delaysMs?.[i] ?? 100, 20, 60_000)));
    framesEntry = { file, columns: atlas.columns, rows: atlas.rows, count: frames.length, delaysMs: delays };
  }
  if (mode === '3d' && input.depth) {
    const enc = await codec.encode(depthPicture(input.depth), 'image/png', 1);
    files[DEPTH_FILE] = enc.bytes;
  }

  // Scene + texture, shrinking until it fits.
  const used = (): number => Object.values(files).reduce((s, b) => s + b.length, 0);
  let glb: Uint8Array | null = null, sc: Scene | null = null;
  const tries: [number, number, number][] = mode === '3d'
    ? [[112, 1024, 0.85], [112, 1024, 0.75], [100, 896, 0.75], [96, 768, 0.72], [80, 640, 0.7], [64, 512, 0.7]]
    : [[0, 1280, 0.86], [0, 1024, 0.8], [0, 896, 0.75], [0, 768, 0.7], [0, 512, 0.7]];
  for (const [detail, long, q] of tries) {
    sc = mode === '3d' ? scene3d(first, input.depth, aspect, strength, edge, detail) : sceneFlat(aspect);
    const tex = await codec.encode(fit(first, animated ? Math.min(long, 768) : long), 'image/jpeg', q);
    glb = writeGlb(sc.nodes, sc.materials, [tex], 'wgif-player photo creator 0.1');
    if (glb.length <= BUDGET.glb - 8192 && used() + glb.length <= BUDGET.total - BUDGET.preview - 32 * 1024) break;
    glb = null;
  }
  if (!glb || !sc) throw new Error('the picture does not fit in the size budget');
  files['world.glb'] = glb;

  let preview = input.preview;
  if (!preview || preview.length > BUDGET.preview) {
    for (const long of [480, 400, 320, 240]) {
      preview = (await codec.encode(fit(first, long), 'image/png', 1)).bytes;
      if (preview.length <= BUDGET.preview - 1024) break;
    }
  }
  files['preview.png'] = preview!;

  const photo: Record<string, unknown> = { type: 'photo', id: 'photo', node: PHOTO_NODE, focus: round3(sc.focus), eye: round3(sc.eye) };
  if (sc.alsoNodes.length) photo.alsoNodes = sc.alsoNodes;
  if (sc.backdrop) photo.backdrop = { sky: round3(sc.backdrop.sky), floor: round3(sc.backdrop.floor) };
  if (framesEntry) photo.frames = framesEntry;
  const interactions = {
    version: '0.1',
    camera: { spawn: round3(sc.eye), lookAt: round3(sc.focus), firstPersonHeight: 1.7, bounds: sc.bounds },
    objects: [],
    colliders: { static: sc.statics },
    interactions: [photo],
  };
  files['interactions.json'] = utf8(JSON.stringify(interactions, null, 2) + '\n');

  const source = (input.sourceName ?? 'picture').replace(/[^\w .()-]/g, '_').slice(0, 80) || 'picture';
  const title = (input.title ?? source.replace(/\.[a-z0-9]+$/i, '')).trim().slice(0, 120) || 'Picture';
  const di = mode === '3d' ? input.depthInfo ?? null : null;
  const credits: Record<string, unknown>[] = [
    { file: 'world.glb#photo', title: source, author: 'Supplied by the creator of this world', source: 'uploaded in WGIF Player', license: 'As supplied by the creator' },
  ];
  if (di && di.backend !== 'mock') credits.push({ file: DEPTH_FILE, title: 'Depth computed in the browser', author: 'Depth Anything V2 Small (Yang et al.), ONNX export by onnx-community', source: `https://huggingface.co/${di.model}`, license: di.license, note: 'model not bundled; only its output is stored' });
  const created = input.created ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const idHash = Array.from(glb.subarray(glb.length - 64, glb.length - 56)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const manifest: ManifestInput = {
    $schema: 'https://github.com/galactic-ai-team/wgif/blob/main/packages/format/schema/manifest.v0.1.schema.json',
    wgif: '0.1',
    id: `player.photo.${created.slice(0, 10).replace(/-/g, '')}.${idHash}`,
    title,
    description: mode === '3d'
      ? `${animated ? 'An animated GIF' : 'A picture'} rebuilt in 3D from an estimated depth map. Orbit to see the parallax.`
      : `${animated ? 'An animated GIF' : 'A picture'} on a screen in a small room.`,
    creator: { name: 'Made with WGIF Player' },
    created,
    license: 'LicenseRef-as-supplied',
    mode: 'editable',
    units: 'meters',
    entry: { scene: 'world.glb', preview: 'preview.png', interactions: 'interactions.json' },
    spawn: { position: round3(sc.eye), lookAt: round3(sc.focus) },
    // The photo component has no capability id in v0.1 (docs/notes/photo-component.md): an older
    // player shows the scene with the first frame and warns about the interactions[] entry.
    requires: ['scene.glb', 'interaction.camera'],
    provenance: {
      generator: 'wgif-player photo creator 0.1',
      params: {
        mode,
        frames: animated ? Math.min(input.frames.length, MAX_FRAMES) : 1,
        ...(mode === '3d' ? { strength: Math.round(strength * 100) / 100, edge, depth: di ? { model: di.model, revision: di.revision, backend: di.backend, inputSize: di.inputSize } : 'synthetic' } : {}),
      },
    },
    extensions: { 'x-credits': credits },
  };
  const bytes = await packWgif(manifest, files);
  if (bytes.length > BUDGET.total) throw new Error(`the world is ${bytes.length} bytes, over the 1 MiB budget`);
  const sizes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length]));
  return { bytes, manifest, files, sizes, focus: sc.focus, eye: sc.eye, cut: sc.cut, vertices: sc.vertices };
}

const round3 = (v: [number, number, number]): [number, number, number] => v.map((n) => Math.round(n * 1000) / 1000) as [number, number, number];

/** Same world, new preview (after the player has rendered it). */
export async function withPreview(w: PhotoWorld, png: Uint8Array): Promise<PhotoWorld> {
  if (png.length > BUDGET.preview) return w;
  const files = { ...w.files, 'preview.png': png };
  const { files: _drop, ...manifest } = w.manifest as ManifestInput & { files?: unknown };
  void _drop;
  const bytes = await packWgif(manifest, files);
  if (bytes.length > BUDGET.total) return w;
  return { ...w, bytes, files, sizes: { ...w.sizes, 'preview.png': png.length } };
}
