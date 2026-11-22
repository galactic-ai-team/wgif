/**
 * Image + depth -> a displaced, textured 3D mesh (pure maths, no DOM, no three.js).
 *
 * The photo is rebuilt as the surface the camera saw: every vertex sits on the ray through its
 * pixel, at a distance from the depth map. Seen from the original eye it looks exactly like the
 * picture; orbit away and the near parts move against the far ones (parallax).
 *
 * Depth Anything gives relative inverse depth (bigger = nearer). It is normalised to 0..1 with
 * robust percentiles, and distance follows disparity: d = 1 sits at `near`, d = 0 at
 * near·(1 + k), k = 1.6 · strength. Strength 0 is a flat picture.
 *
 * Edges: where the depth jumps between neighbouring vertices (a person in front of a wall) a
 * plain grid would stretch a "rubber sheet" between them. `cut` drops those triangles, and a dim
 * copy of the picture far behind (the back plate) fills the gap; `smooth` keeps every triangle and
 * blurs the depth more, so the stretch is a soft slope instead.
 */
export type EdgeMode = 'cut' | 'smooth';

export interface DepthMap {
  width: number;
  height: number;
  /** Row-major, 0..1, 1 = nearest. */
  data: Float32Array;
}

export interface MeshOptions {
  /** Image aspect, width / height. */
  aspect: number;
  /** Vertices across the longer side (the shorter side follows the aspect). */
  detail?: number;
  strength?: number;
  edge?: EdgeMode;
  /** Vertical field of view of the eye, degrees. */
  fovY?: number;
  /** Distance of the nearest point, metres. */
  near?: number;
  /** Eye position. */
  eye?: [number, number, number];
  /** Cut where the disparity jumps more than this between corners of a triangle. */
  cutThreshold?: number;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
}

export interface PhotoMesh {
  surface: MeshData;
  /** Flat copy of the picture just behind the farthest point (fills cut edges), or null at strength 0. */
  back: MeshData | null;
  /** Where orbit should centre: on the eye's axis, at the median depth. */
  focus: [number, number, number];
  eye: [number, number, number];
  cols: number;
  rows: number;
  /** Triangles dropped at depth edges. */
  cut: number;
  far: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Normalises raw model output (any scale, bigger = nearer) to 0..1 using the 1st and 99th
 * percentiles, so a few hot pixels do not flatten the rest. A constant map becomes all 0.5.
 */
export function normalizeDepth(raw: ArrayLike<number>, width: number, height: number, invert = false): DepthMap {
  const n = width * height;
  const finite: number[] = [];
  const stride = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += stride) if (Number.isFinite(raw[i]!)) finite.push(raw[i]!);
  finite.sort((a, b) => a - b);
  const lo = finite.length ? finite[Math.floor(finite.length * 0.01)]! : 0;
  const hi = finite.length ? finite[Math.min(finite.length - 1, Math.floor(finite.length * 0.99))]! : 1;
  const data = new Float32Array(n);
  const span = hi - lo;
  for (let i = 0; i < n; i++) {
    const v = Number.isFinite(raw[i]!) ? raw[i]! : lo;
    let d = span > 1e-9 ? clamp((v - lo) / span, 0, 1) : 0.5;
    if (invert) d = 1 - d;
    data[i] = d;
  }
  return { width, height, data };
}

/** Bilinear sample at (u, v) in 0..1. */
export function sampleDepth(map: DepthMap, u: number, v: number): number {
  const x = clamp(u, 0, 1) * (map.width - 1), y = clamp(v, 0, 1) * (map.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(map.width - 1, x0 + 1), y1 = Math.min(map.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, d = map.data;
  const top = d[y0 * map.width + x0]! * (1 - fx) + d[y0 * map.width + x1]! * fx;
  const bot = d[y1 * map.width + x0]! * (1 - fx) + d[y1 * map.width + x1]! * fx;
  return top * (1 - fy) + bot * fy;
}

/** A 3x3 box blur, `passes` times (in place on a copy). */
function blur(grid: Float32Array, w: number, h: number, passes: number): Float32Array {
  let a: Float32Array = grid;
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += a[yy * w + xx]!;
            c++;
          }
        }
        b[y * w + x] = s / c;
      }
    }
    a = b;
  }
  return a;
}

/** Grid size for a picture: `detail` vertices across the longer side. */
export function gridSize(aspect: number, detail: number): { cols: number; rows: number } {
  const a = clamp(aspect, 0.1, 10);
  return a >= 1 ? { cols: detail, rows: Math.max(2, Math.round(detail / a)) } : { cols: Math.max(2, Math.round(detail * a)), rows: detail };
}

function computeNormals(pos: Float32Array, idx: ArrayLike<number>): Float32Array {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3;
    const ux = pos[b]! - pos[a]!, uy = pos[b + 1]! - pos[a + 1]!, uz = pos[b + 2]! - pos[a + 2]!;
    const vx = pos[c]! - pos[a]!, vy = pos[c + 1]! - pos[a + 1]!, vz = pos[c + 2]! - pos[a + 2]!;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] = n[k]! + fx;
      n[k + 1] = n[k + 1]! + fy;
      n[k + 2] = n[k + 2]! + fz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!);
    if (l > 1e-12) {
      n[i] = n[i]! / l;
      n[i + 1] = n[i + 1]! / l;
      n[i + 2] = n[i + 2]! / l;
    } else n[i + 2] = 1;
  }
  return n;
}

function bounds(pos: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

/** A flat rectangle facing +Z at distance `z` in front of the eye, filling the field of view. */
function plate(eye: [number, number, number], z: number, tanX: number, tanY: number): MeshData {
  const hx = tanX * z, hy = tanY * z;
  const positions = new Float32Array([
    eye[0] - hx, eye[1] + hy, eye[2] - z, eye[0] + hx, eye[1] + hy, eye[2] - z,
    eye[0] - hx, eye[1] - hy, eye[2] - z, eye[0] + hx, eye[1] - hy, eye[2] - z,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
  const indices = new Uint16Array([0, 2, 1, 1, 2, 3]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  return { positions, normals, uvs, indices, ...bounds(positions) };
}

export function buildPhotoMesh(depth: DepthMap | null, opts: MeshOptions): PhotoMesh {
  const strength = clamp(opts.strength ?? 1, 0, 3);
  const edge = opts.edge ?? 'cut';
  const near = opts.near ?? 3;
  const eye = opts.eye ?? [0, 1.6, 0];
  const fovY = ((opts.fovY ?? 50) * Math.PI) / 180;
  const tanY = Math.tan(fovY / 2), tanX = tanY * opts.aspect;
  const { cols, rows } = gridSize(opts.aspect, opts.detail ?? 128);
  const vw = cols + 1, vh = rows + 1;
  const k = 1.6 * strength;
  const far = near * (1 + k);
  // Disparity at each vertex, lightly smoothed (more for `smooth`).
  let grid: Float32Array = new Float32Array(vw * vh);
  for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) grid[j * vw + i] = depth ? sampleDepth(depth, i / cols, j / rows) : 0.5;
  grid = blur(grid, vw, vh, edge === 'smooth' ? 3 : 1);
  const dist = (d: number): number => (near * (1 + k)) / (1 + k * d);

  const positions = new Float32Array(vw * vh * 3), uvs = new Float32Array(vw * vh * 2);
  for (let j = 0; j < vh; j++) {
    for (let i = 0; i < vw; i++) {
      const v = j * vw + i, u = i / cols, t = j / rows, z = strength > 0 ? dist(grid[v]!) : near;
      positions[v * 3] = eye[0] + (u * 2 - 1) * tanX * z;
      positions[v * 3 + 1] = eye[1] + (1 - t * 2) * tanY * z;
      positions[v * 3 + 2] = eye[2] - z;
      uvs[v * 2] = u;
      uvs[v * 2 + 1] = t;
    }
  }
  const threshold = opts.cutThreshold ?? 0.06 * Math.max(1, 128 / Math.max(cols, rows));
  const tris: number[] = [];
  let cut = 0;
  const zOf = (v: number): number => eye[2] - positions[v * 3 + 2]!;
  const jump = (a: number, b: number, c: number): number => {
    const za = zOf(a), zb = zOf(b), zc = zOf(c);
    const zMin = Math.min(za, zb, zc);
    return zMin > 1e-6 ? (Math.max(za, zb, zc) - zMin) / zMin : 0;
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * vw + i, b = a + 1, c = a + vw, d = c + 1;
      // Counter-clockwise seen from the eye (+Z faces the eye).
      for (const [p, q, r] of [[a, c, b], [b, c, d]] as const) {
        if (edge === 'cut' && strength > 0 && jump(p, q, r) > threshold) {
          cut++;
          continue;
        }
        tris.push(p, q, r);
      }
    }
  }
  const indices = vw * vh > 65535 ? new Uint32Array(tris) : new Uint16Array(tris);
  const surface: MeshData = { positions, normals: computeNormals(positions, indices), uvs, indices, ...bounds(positions) };

  const sorted = Array.from(grid).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0.5;
  const fz = strength > 0 ? dist(median) : near;
  return {
    surface,
    back: strength > 0 ? plate(eye, far * 1.04, tanX, tanY) : null,
    focus: [eye[0], eye[1], eye[2] - fz],
    eye,
    cols,
    rows,
    cut,
    far,
  };
}

/**
 * Stand-in depth for tests and for when no model is available: a soft "floor comes toward you"
 * gradient plus a little of the picture's brightness. Deterministic; not a real depth estimate.
 */
export function syntheticDepth(rgba: ArrayLike<number>, width: number, height: number): DepthMap {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const lum = (0.2126 * rgba[o]! + 0.7152 * rgba[o + 1]! + 0.0722 * rgba[o + 2]!) / 255;
      data[y * width + x] = clamp(0.15 + 0.6 * (y / Math.max(1, height - 1)) + 0.25 * lum, 0, 1);
    }
  }
  return { width, height, data };
}
