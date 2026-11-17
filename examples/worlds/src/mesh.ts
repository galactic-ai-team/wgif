import { Document, NodeIO, type Material, type Node, type Texture } from '@gltf-transform/core';

/** Procedural mesh data with optional UVs (glTF convention: v = 0 is the top of the image). */
export interface Mesh {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export const empty = (): Mesh => ({ positions: [], normals: [], uvs: [], indices: [] });

export function merge(target: Mesh, ...parts: Mesh[]): Mesh {
  for (const src of parts) {
    const base = target.positions.length / 3;
    target.positions.push(...src.positions);
    target.normals.push(...src.normals);
    target.uvs.push(...src.uvs);
    for (const i of src.indices) target.indices.push(i + base);
  }
  return target;
}

type V3 = [number, number, number];

function quadInto(m: Mesh, n: V3, verts: V3[], uv: [number, number][]): void {
  const b = m.positions.length / 3;
  verts.forEach((v, k) => {
    m.positions.push(v[0], v[1], v[2]);
    m.normals.push(n[0], n[1], n[2]);
    m.uvs.push(uv[k]![0], uv[k]![1]);
  });
  m.indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
}

/**
 * Axis-aligned box centred at (cx, cy, cz), full sizes (sx, sy, sz). Each face maps the whole
 * texture once, scaled by `uvScale` (repeats per metre when > 0, or once per face when 0).
 */
export function box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, uvScale = 0): Mesh {
  const m = empty();
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces: [V3, V3[], number, number][] = [
    [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], sz, sy],
    [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], sz, sy],
    [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], sx, sz],
    [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], sx, sz],
    [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], sx, sy],
    [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], sx, sy],
  ];
  for (const [n, verts, w, h] of faces) {
    const u = uvScale > 0 ? w * uvScale : 1, v = uvScale > 0 ? h * uvScale : 1;
    quadInto(m, n, verts.map((p) => [cx + p[0], cy + p[1], cz + p[2]] as V3), [[0, v], [u, v], [u, 0], [0, 0]]);
  }
  return m;
}

/**
 * A flat picture: a w x h rectangle centred at `c`, facing `normal` (one of the four horizontal
 * axes), with the image upright as seen from the front.
 */
export function picture(c: V3, w: number, h: number, normal: '+x' | '-x' | '+z' | '-z'): Mesh {
  const m = empty();
  // Right-hand direction as seen by a viewer looking at the picture's front.
  const right: Record<typeof normal, V3> = { '+z': [1, 0, 0], '-z': [-1, 0, 0], '+x': [0, 0, -1], '-x': [0, 0, 1] };
  const n: Record<typeof normal, V3> = { '+z': [0, 0, 1], '-z': [0, 0, -1], '+x': [1, 0, 0], '-x': [-1, 0, 0] };
  const r = right[normal];
  const at = (sx: number, sy: number): V3 => [c[0] + r[0] * sx * w / 2, c[1] + sy * h / 2, c[2] + r[2] * sx * w / 2];
  quadInto(m, n[normal], [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], [[0, 1], [1, 1], [1, 0], [0, 0]]);
  return m;
}

export function sphere(cx: number, cy: number, cz: number, r: number, segU = 24, segV = 16, inward = false): Mesh {
  const m = empty();
  for (let j = 0; j <= segV; j++) {
    const v = j / segV, phi = v * Math.PI;
    for (let i = 0; i <= segU; i++) {
      const u = i / segU, theta = u * Math.PI * 2;
      // Equirectangular: u runs with longitude, v = 0 at the zenith. Seen from inside, x is mirrored
      // so the panorama reads the right way round (not as its mirror image).
      const x = (inward ? 1 : -1) * Math.cos(theta) * Math.sin(phi), y = Math.cos(phi), z = Math.sin(theta) * Math.sin(phi);
      m.positions.push(cx + r * x, cy + r * y, cz + r * z);
      const s = inward ? -1 : 1;
      m.normals.push(s * x, s * y, s * z);
      m.uvs.push(u, v);
    }
  }
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i, b = a + segU + 1;
      if (inward) m.indices.push(a, a + 1, b, b, a + 1, b + 1);
      else m.indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return m;
}

export function cylinder(cx: number, cz: number, y0: number, y1: number, r: number, seg = 16): Mesh {
  const m = empty();
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
    m.positions.push(cx + r * x, y0, cz + r * z, cx + r * x, y1, cz + r * z);
    m.normals.push(x, 0, z, x, 0, z);
    m.uvs.push(i / seg, 1, i / seg, 0);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    m.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const cap = (y: number, ny: number): void => {
    const c = m.positions.length / 3;
    m.positions.push(cx, y, cz);
    m.normals.push(0, ny, 0);
    m.uvs.push(0.5, 0.5);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      m.positions.push(cx + r * Math.cos(a), y, cz + r * Math.sin(a));
      m.normals.push(0, ny, 0);
      m.uvs.push(0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2);
    }
    for (let i = 0; i < seg; i++) {
      if (ny > 0) m.indices.push(c, c + i + 2, c + i + 1);
      else m.indices.push(c, c + i + 1, c + i + 2);
    }
  };
  cap(y1, 1);
  cap(y0, -1);
  return m;
}

/** A torus lying flat (axis +Y), e.g. a hoop rim. */
export function torus(cx: number, cy: number, cz: number, R: number, r: number, segR = 32, segT = 10): Mesh {
  const m = empty();
  for (let i = 0; i <= segR; i++) {
    const u = (i / segR) * Math.PI * 2;
    for (let j = 0; j <= segT; j++) {
      const v = (j / segT) * Math.PI * 2;
      const nx = Math.cos(v) * Math.cos(u), ny = Math.sin(v), nz = Math.cos(v) * Math.sin(u);
      m.positions.push(cx + (R + r * Math.cos(v)) * Math.cos(u), cy + r * ny, cz + (R + r * Math.cos(v)) * Math.sin(u));
      m.normals.push(nx, ny, nz);
      m.uvs.push(i / segR, j / segT);
    }
  }
  for (let i = 0; i < segR; i++) {
    for (let j = 0; j < segT; j++) {
      const a = i * (segT + 1) + j, b = a + segT + 1;
      m.indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return m;
}

/** A flat ring (annulus segment) on the floor at height y, for painted court lines. */
export function ring(cx: number, y: number, cz: number, rIn: number, rOut: number, a0 = 0, a1 = Math.PI * 2, seg = 48): Mesh {
  const m = empty();
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg, x = Math.cos(a), z = Math.sin(a);
    m.positions.push(cx + rIn * x, y, cz + rIn * z, cx + rOut * x, y, cz + rOut * z);
    m.normals.push(0, 1, 0, 0, 1, 0);
    m.uvs.push(0, 0, 1, 1);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    m.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return m;
}

/** Moves a mesh in place: optional turn about +Z, then about +Y (radians), then a shift. */
export function place(m: Mesh, o: { rotZ?: number; rotY?: number; at?: V3 }): Mesh {
  const cz = Math.cos(o.rotZ ?? 0), sz = Math.sin(o.rotZ ?? 0), cy = Math.cos(o.rotY ?? 0), sy = Math.sin(o.rotY ?? 0);
  const [tx, ty, tz] = o.at ?? [0, 0, 0];
  const turn = (a: number[], i: number, shift: boolean): void => {
    let x = a[i]!, y = a[i + 1]!;
    const z0 = a[i + 2]!;
    [x, y] = [x * cz - y * sz, x * sz + y * cz];
    const z = -x * sy + z0 * cy;
    x = x * cy + z0 * sy;
    a[i] = x + (shift ? tx : 0); a[i + 1] = y + (shift ? ty : 0); a[i + 2] = z + (shift ? tz : 0);
  };
  for (let i = 0; i < m.positions.length; i += 3) {
    turn(m.positions, i, true);
    turn(m.normals, i, false);
  }
  return m;
}

/** Smooth vertex normals from the triangles (counter-clockwise faces point out). */
function smoothNormals(m: Mesh): void {
  const n = new Array<number>(m.positions.length).fill(0), p = m.positions;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i]! * 3, b = m.indices[i + 1]! * 3, c = m.indices[i + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] = n[k]! + fx;
      n[k + 1] = n[k + 1]! + fy;
      n[k + 2] = n[k + 2]! + fz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1;
    n[i] = n[i]! / l;
    n[i + 1] = n[i + 1]! / l;
    n[i + 2] = n[i + 2]! / l;
  }
  m.normals = n;
}

/** One cross-section of a loft: at `z`, from `yb` up to `yt`, `hw` either side of x = 0. */
export interface Station {
  z: number;
  yb: number;
  yt: number;
  hw: number;
}

/**
 * A smooth body lofted through rounded-rectangle sections along Z (a car body, a canopy).
 * `round` is the superellipse exponent: 2 is an ellipse, higher is boxier. The ends are capped.
 */
export function loft(stations: Station[], round = 4, seg = 28): Mesh {
  const m = empty();
  const e = 2 / round;
  const sgn = (v: number): number => (v < 0 ? -1 : 1);
  for (const [k, s] of stations.entries()) {
    const cy = (s.yb + s.yt) / 2, hh = (s.yt - s.yb) / 2;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      m.positions.push(s.hw * sgn(c) * Math.abs(c) ** e, cy + hh * sgn(sn) * Math.abs(sn) ** e, s.z);
      m.uvs.push(i / seg, k / (stations.length - 1));
    }
  }
  // Seen from +Z the ring runs counter-clockwise, so (ring k, ring k+1 further along +Z) faces outward this way:
  for (let k = 0; k + 1 < stations.length; k++) {
    for (let i = 0; i < seg; i++) {
      const a = k * seg + i, b = k * seg + ((i + 1) % seg), c = a + seg, d = b + seg;
      if (stations[k + 1]!.z > stations[k]!.z) m.indices.push(a, b, d, a, d, c);
      else m.indices.push(a, d, b, a, c, d);
    }
  }
  const cap = (k: number, towardPlus: boolean): void => {
    const s = stations[k]!, centre = m.positions.length / 3;
    m.positions.push(0, (s.yb + s.yt) / 2, s.z);
    m.uvs.push(0.5, 0.5);
    for (let i = 0; i < seg; i++) {
      const a = k * seg + i, b = k * seg + ((i + 1) % seg);
      if (towardPlus) m.indices.push(centre, a, b);
      else m.indices.push(centre, b, a);
    }
  };
  const forward = stations[stations.length - 1]!.z > stations[0]!.z;
  cap(0, !forward);
  cap(stations.length - 1, forward);
  smoothNormals(m);
  // Make sure the faces point out (the winding above depends on the ring direction).
  let out = 0;
  const mid = stations[Math.floor(stations.length / 2)]!, my = (mid.yb + mid.yt) / 2;
  for (let i = 0; i < stations.length * seg * 3; i += 3) out += m.normals[i]! * m.positions[i]! + m.normals[i + 1]! * (m.positions[i + 1]! - my);
  if (out < 0) {
    for (let i = 0; i < m.indices.length; i += 3) [m.indices[i + 1], m.indices[i + 2]] = [m.indices[i + 2]!, m.indices[i + 1]!];
    smoothNormals(m);
  }
  return m;
}

/**
 * A solid with a constant cross-section `profile` (convex, [z, y] points counter-clockwise seen from
 * +X) from x0 to x1: ramps and wedges. Flat-shaded.
 */
export function extrudeX(profile: [number, number][], x0: number, x1: number): Mesh {
  const m = empty();
  const n = profile.length;
  const face = (verts: V3[], normal: V3): void => {
    const b = m.positions.length / 3;
    for (const v of verts) {
      m.positions.push(...v);
      m.normals.push(...normal);
      m.uvs.push(v[2], v[1]);
    }
    for (let i = 1; i + 1 < verts.length; i++) m.indices.push(b, b + i, b + i + 1);
  };
  // +X side: (z, y) counter-clockwise seen from +X means (-z) is "right"... build with explicit normals.
  face(profile.map(([z, y]) => [x1, y, z] as V3).reverse(), [1, 0, 0]);
  face(profile.map(([z, y]) => [x0, y, z] as V3), [-1, 0, 0]);
  for (let i = 0; i < n; i++) {
    const [z0, y0] = profile[i]!, [z1, y1] = profile[(i + 1) % n]!;
    const dz = z1 - z0, dy = y1 - y0, l = Math.hypot(dz, dy) || 1;
    // Outward normal of an edge of a counter-clockwise (seen from +X) polygon in the (z, y) plane.
    const nz = -dy / l, ny = dz / l;
    face([[x0, y0, z0], [x0, y1, z1], [x1, y1, z1], [x1, y0, z0]], [0, ny, nz]);
  }
  return fixWinding(m);
}

/** Flips each triangle whose winding disagrees with its normals, so faces point the way they are lit. */
function fixWinding(m: Mesh): Mesh {
  const p = m.positions, nr = m.normals;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i]!, b = m.indices[i + 1]!, c = m.indices[i + 2]!;
    const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const vx = p[c * 3]! - p[a * 3]!, vy = p[c * 3 + 1]! - p[a * 3 + 1]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * nr[a * 3]! + fy * nr[a * 3 + 1]! + fz * nr[a * 3 + 2]! < 0) {
      m.indices[i + 1] = c;
      m.indices[i + 2] = b;
    }
  }
  return m;
}

/** A cone (or a frustum when `top` > 0) standing on y0. */
export function cone(cx: number, cz: number, y0: number, y1: number, r: number, top = 0, seg = 16): Mesh {
  const m = empty();
  const slope = (r - top) / (y1 - y0);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a), l = Math.hypot(1, slope);
    m.positions.push(cx + r * x, y0, cz + r * z, cx + top * x, y1, cz + top * z);
    m.normals.push(x / l, slope / l, z / l, x / l, slope / l, z / l);
    m.uvs.push(i / seg, 1, i / seg, 0);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    m.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const c = m.positions.length / 3;
  m.positions.push(cx, y0, cz);
  m.normals.push(0, -1, 0);
  m.uvs.push(0.5, 0.5);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    m.positions.push(cx + r * Math.cos(a), y0, cz + r * Math.sin(a));
    m.normals.push(0, -1, 0);
    m.uvs.push(0.5, 0.5);
  }
  for (let i = 0; i < seg; i++) m.indices.push(c, c + i + 1, c + i + 2);
  return fixWinding(m);
}

export interface MatOptions {
  rough?: number;
  metal?: number;
  emissive?: [number, number, number];
  texture?: Texture;
  /** Use the texture as the emissive map too, so a picture shows its own colours in any light. */
  glowTexture?: boolean;
  doubleSided?: boolean;
}

/** Small wrapper over a glTF-Transform document: deterministic, self-contained GLB output. */
export class GlbBuilder {
  readonly doc = new Document();
  private readonly buffer = this.doc.createBuffer();
  private readonly scene;

  constructor(name: string, generator: string) {
    this.doc.getRoot().getAsset().generator = generator;
    this.scene = this.doc.createScene(name);
  }

  /** Embeds an image (JPEG or PNG bytes) in the GLB binary chunk. */
  texture(name: string, bytes: Uint8Array, mimeType: 'image/jpeg' | 'image/png'): Texture {
    return this.doc.createTexture(name).setImage(bytes).setMimeType(mimeType);
  }

  material(name: string, rgba: [number, number, number, number], o: MatOptions = {}): Material {
    const m = this.doc.createMaterial(name).setBaseColorFactor(rgba).setRoughnessFactor(o.rough ?? 0.8).setMetallicFactor(o.metal ?? 0);
    if (rgba[3] < 1) m.setAlphaMode('BLEND');
    if (o.texture) m.setBaseColorTexture(o.texture);
    if (o.emissive) m.setEmissiveFactor(o.emissive);
    if (o.texture && o.glowTexture) m.setEmissiveTexture(o.texture);
    if (o.doubleSided) m.setDoubleSided(true);
    return m;
  }

  /** An empty node (a group), under `parent` or at the scene root. */
  node(name: string, parent?: Node, at?: V3): Node {
    const node = this.doc.createNode(name);
    if (at) node.setTranslation(at);
    if (parent) parent.addChild(node);
    else this.scene.addChild(node);
    return node;
  }

  add(name: string, data: Mesh, material: Material, extras?: Record<string, unknown>, parent?: Node): Node {
    const count = data.positions.length / 3;
    const pos = this.doc.createAccessor().setType('VEC3').setArray(new Float32Array(data.positions)).setBuffer(this.buffer);
    const nrm = this.doc.createAccessor().setType('VEC3').setArray(new Float32Array(data.normals)).setBuffer(this.buffer);
    const idx = this.doc.createAccessor().setType('SCALAR')
      .setArray(count > 65535 ? new Uint32Array(data.indices) : new Uint16Array(data.indices)).setBuffer(this.buffer);
    const prim = this.doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setIndices(idx).setMaterial(material);
    if (data.uvs.length === count * 2) {
      prim.setAttribute('TEXCOORD_0', this.doc.createAccessor().setType('VEC2').setArray(new Float32Array(data.uvs)).setBuffer(this.buffer));
    }
    const node = this.doc.createNode(name).setMesh(this.doc.createMesh(name).addPrimitive(prim));
    if (extras) node.setExtras(extras);
    if (parent) parent.addChild(node);
    else this.scene.addChild(node);
    return node;
  }

  async glb(): Promise<Uint8Array> {
    return new NodeIO().writeBinary(this.doc);
  }
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
