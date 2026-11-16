/** Tiny procedural mesh helpers (positions, normals, uint16/uint32 indices). */
export interface MeshData {
  positions: number[];
  normals: number[];
  indices: number[];
}

export const emptyMesh = (): MeshData => ({ positions: [], normals: [], indices: [] });

export function append(target: MeshData, src: MeshData): MeshData {
  const base = target.positions.length / 3;
  target.positions.push(...src.positions);
  target.normals.push(...src.normals);
  for (const i of src.indices) target.indices.push(i + base);
  return target;
}

/** Axis-aligned box centred at (cx, cy, cz) with full sizes (sx, sy, sz). */
export function box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): MeshData {
  const m = emptyMesh();
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces: [number[], number[][]][] = [
    [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
    [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
    [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
    [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
    [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
    [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
  ];
  for (const [n, verts] of faces) {
    const b = m.positions.length / 3;
    for (const v of verts) {
      m.positions.push(cx + v[0]!, cy + v[1]!, cz + v[2]!);
      m.normals.push(n[0]!, n[1]!, n[2]!);
    }
    m.indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return m;
}

/** Flat annulus segment on the XZ plane at height y (for painted arcs and circles). */
export function ring(cx: number, y: number, cz: number, rInner: number, rOuter: number, a0 = 0, a1 = Math.PI * 2, seg = 48): MeshData {
  const m = emptyMesh();
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    const c = Math.cos(a), s = Math.sin(a);
    m.positions.push(cx + c * rInner, y, cz + s * rInner, cx + c * rOuter, y, cz + s * rOuter);
    m.normals.push(0, 1, 0, 0, 1, 0);
    if (i < seg) {
      const b = i * 2;
      m.indices.push(b, b + 3, b + 1, b, b + 2, b + 3);
    }
  }
  return m;
}

/** Horizontal torus (rim) in the XZ plane. */
export function torus(cx: number, cy: number, cz: number, R: number, r: number, segR = 32, segT = 10): MeshData {
  const m = emptyMesh();
  for (let i = 0; i <= segR; i++) {
    const u = (i / segR) * Math.PI * 2;
    for (let j = 0; j <= segT; j++) {
      const v = (j / segT) * Math.PI * 2;
      const nx = Math.cos(v) * Math.cos(u), ny = Math.sin(v), nz = Math.cos(v) * Math.sin(u);
      m.positions.push(cx + (R + r * Math.cos(v)) * Math.cos(u), cy + r * Math.sin(v), cz + (R + r * Math.cos(v)) * Math.sin(u));
      m.normals.push(nx, ny, nz);
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

export function sphere(cx: number, cy: number, cz: number, r: number, segU = 24, segV = 16): MeshData {
  const m = emptyMesh();
  for (let j = 0; j <= segV; j++) {
    const v = (j / segV) * Math.PI;
    for (let i = 0; i <= segU; i++) {
      const u = (i / segU) * Math.PI * 2;
      const nx = Math.sin(v) * Math.cos(u), ny = Math.cos(v), nz = Math.sin(v) * Math.sin(u);
      m.positions.push(cx + r * nx, cy + r * ny, cz + r * nz);
      m.normals.push(nx, ny, nz);
    }
  }
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i, b = a + segU + 1;
      m.indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return m;
}

/** Vertical cylinder from y0 to y1. */
export function cylinder(cx: number, cz: number, y0: number, y1: number, r: number, seg = 16): MeshData {
  const m = emptyMesh();
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    m.positions.push(cx + c * r, y0, cz + s * r, cx + c * r, y1, cz + s * r);
    m.normals.push(c, 0, s, c, 0, s);
    if (i < seg) {
      const b = i * 2;
      m.indices.push(b, b + 1, b + 3, b, b + 3, b + 2);
    }
  }
  return m;
}
