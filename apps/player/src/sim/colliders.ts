import type { Vec3 } from './vec.js';

/**
 * Static collision geometry: world-space triangles in a uniform grid.
 *
 * A world's colliders are the triangle meshes of the nodes it names (interactions.json
 * `colliders.static`, or `extras.wgif.collider` as a fallback), so what you see is what you hit.
 * Balls and the walker are spheres tested against the nearest triangle. Sphere queries never allocate.
 */

/** Floors, walls and other geometry everything collides with. */
export const LAYER_SOLID = 1;
/** Thin props such as hoop rims: balls bounce off them, the walker ignores them. */
export const LAYER_PROP = 2;
export const LAYER_ALL = LAYER_SOLID | LAYER_PROP;

export interface ColliderOptions {
  layer?: number;
  /** Multiplier applied to a ball's restitution when it hits this group (a rim is deader than a floor). */
  restitution?: number;
}

export interface ColliderGroup {
  readonly id: number;
  readonly name: string;
  readonly layer: number;
  readonly restitution: number;
  triangles: number;
}

/** Result of a sphere query: closest surface point, the normal pointing at the sphere, and the overlap. */
export interface Contact {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  depth: number;
  group: number;
}

export interface RayHit {
  t: number;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  group: number;
}

export const newContact = (): Contact => ({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, depth: 0, group: -1 });
export const newRayHit = (): RayHit => ({ t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, group: -1 });

const TARGET_CELLS = 16384;
const MIN_CELL = 0.5;
/** Triangles covering more cells than this (big floors) are kept in a short list checked by every query. */
const LARGE_TRIANGLE_CELLS = 256;

export class StaticColliders {
  readonly groups: ColliderGroup[] = [];
  readonly min: Vec3 = [0, 0, 0];
  readonly max: Vec3 = [0, 0, 0];

  private pending: number[] = [];
  private pendingGroup: number[] = [];
  private V = new Float64Array(0);
  private N = new Float64Array(0);
  private G = new Uint16Array(0);
  private stamp = new Uint32Array(0);
  private query = 0;
  private cellStart = new Int32Array(2);
  private cellItems = new Int32Array(0);
  private large: number[] = [];
  private cell = 1;
  private nx = 1;
  private ny = 1;
  private nz = 1;
  private dirty = true;
  // Scratch state, so queries never allocate.
  private qx = 0;
  private qy = 0;
  private qz = 0;
  private bx = 0;
  private by = 0;
  private bz = 0;
  private sId = 0;
  private sMask = 0;
  private sBest = 0;
  private sFound = -1;

  get triangleCount(): number {
    return this.pendingGroup.length;
  }

  /**
   * Adds a mesh. `positions` is xyz per vertex in world space, `indices` is three per triangle
   * (or null for an unindexed soup). Degenerate triangles are dropped.
   */
  addMesh(name: string, positions: ArrayLike<number>, indices?: ArrayLike<number> | null, opts: ColliderOptions = {}): ColliderGroup {
    const group: ColliderGroup = { id: this.groups.length, name, layer: opts.layer ?? LAYER_SOLID, restitution: opts.restitution ?? 1, triangles: 0 };
    this.groups.push(group);
    const count = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
    for (let t = 0; t < count; t++) {
      const ia = indices ? indices[t * 3]! * 3 : t * 9;
      const ib = indices ? indices[t * 3 + 1]! * 3 : t * 9 + 3;
      const ic = indices ? indices[t * 3 + 2]! * 3 : t * 9 + 6;
      const ax = positions[ia]!, ay = positions[ia + 1]!, az = positions[ia + 2]!;
      const bx = positions[ib]!, by = positions[ib + 1]!, bz = positions[ib + 2]!;
      const cx = positions[ic]!, cy = positions[ic + 1]!, cz = positions[ic + 2]!;
      if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) continue;
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (!(area2 > 1e-12)) continue;
      this.pending.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      this.pendingGroup.push(group.id);
      group.triangles++;
    }
    this.dirty = true;
    return group;
  }

  /** Adds an axis-aligned box (12 triangles). Used for fallback floors and in tests. */
  addBox(name: string, min: Vec3, max: Vec3, opts: ColliderOptions = {}): ColliderGroup {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const p = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
    const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
    return this.addMesh(name, p, i, opts);
  }

  /** (Re)builds the lookup grid. Called automatically by the first query after a change. */
  build(): this {
    const count = this.pendingGroup.length;
    this.V = Float64Array.from(this.pending);
    this.G = Uint16Array.from(this.pendingGroup);
    this.N = new Float64Array(count * 3);
    this.stamp = new Uint32Array(count);
    this.query = 0;
    const V = this.V;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let t = 0; t < count; t++) {
      const o = t * 9;
      const ux = V[o + 3]! - V[o]!, uy = V[o + 4]! - V[o + 1]!, uz = V[o + 5]! - V[o + 2]!;
      const vx = V[o + 6]! - V[o]!, vy = V[o + 7]! - V[o + 1]!, vz = V[o + 8]! - V[o + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      this.N[t * 3] = nx / l;
      this.N[t * 3 + 1] = ny / l;
      this.N[t * 3 + 2] = nz / l;
      for (let k = 0; k < 9; k += 3) {
        x0 = Math.min(x0, V[o + k]!); x1 = Math.max(x1, V[o + k]!);
        y0 = Math.min(y0, V[o + k + 1]!); y1 = Math.max(y1, V[o + k + 1]!);
        z0 = Math.min(z0, V[o + k + 2]!); z1 = Math.max(z1, V[o + k + 2]!);
      }
    }
    if (count === 0) x0 = y0 = z0 = x1 = y1 = z1 = 0;
    this.min[0] = x0; this.min[1] = y0; this.min[2] = z0;
    this.max[0] = x1; this.max[1] = y1; this.max[2] = z1;

    const ex = Math.max(x1 - x0, 1e-3), ey = Math.max(y1 - y0, 1e-3), ez = Math.max(z1 - z0, 1e-3);
    this.cell = Math.max(MIN_CELL, Math.cbrt((ex * ey * ez) / TARGET_CELLS));
    this.nx = Math.max(1, Math.ceil(ex / this.cell));
    this.ny = Math.max(1, Math.ceil(ey / this.cell));
    this.nz = Math.max(1, Math.ceil(ez / this.cell));
    const cells = this.nx * this.ny * this.nz;
    const counts = new Int32Array(cells + 1);
    const ranges = new Int32Array(count * 6);
    this.large = [];
    for (let t = 0; t < count; t++) {
      const o = t * 9;
      const ix0 = this.ix(Math.min(V[o]!, V[o + 3]!, V[o + 6]!)), ix1 = this.ix(Math.max(V[o]!, V[o + 3]!, V[o + 6]!));
      const iy0 = this.iy(Math.min(V[o + 1]!, V[o + 4]!, V[o + 7]!)), iy1 = this.iy(Math.max(V[o + 1]!, V[o + 4]!, V[o + 7]!));
      const iz0 = this.iz(Math.min(V[o + 2]!, V[o + 5]!, V[o + 8]!)), iz1 = this.iz(Math.max(V[o + 2]!, V[o + 5]!, V[o + 8]!));
      if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) * (iz1 - iz0 + 1) > LARGE_TRIANGLE_CELLS) {
        this.large.push(t);
        ranges[t * 6] = -1;
        continue;
      }
      ranges.set([ix0, ix1, iy0, iy1, iz0, iz1], t * 6);
      for (let iz = iz0; iz <= iz1; iz++) for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) counts[this.key(ix, iy, iz) + 1]!++;
    }
    for (let i = 0; i < cells; i++) counts[i + 1]! += counts[i]!;
    this.cellStart = counts.slice();
    this.cellItems = new Int32Array(counts[cells]!);
    const fill = counts.slice(0, cells);
    for (let t = 0; t < count; t++) {
      if (ranges[t * 6] === -1) continue;
      const r = t * 6;
      for (let iz = ranges[r + 4]!; iz <= ranges[r + 5]!; iz++) {
        for (let iy = ranges[r + 2]!; iy <= ranges[r + 3]!; iy++) {
          for (let ix = ranges[r]!; ix <= ranges[r + 1]!; ix++) this.cellItems[fill[this.key(ix, iy, iz)]!++] = t;
        }
      }
    }
    this.dirty = false;
    return this;
  }

  /**
   * Finds the triangle closest to a sphere's centre that the sphere overlaps.
   * Returns false when the sphere touches nothing on the given layers.
   */
  closest(cx: number, cy: number, cz: number, r: number, mask: number, out: Contact): boolean {
    if (this.dirty) this.build();
    if (this.G.length === 0) return false;
    if (cx + r < this.min[0] || cx - r > this.max[0] || cy + r < this.min[1] || cy - r > this.max[1] || cz + r < this.min[2] || cz - r > this.max[2]) return false;
    this.sId = this.nextQuery();
    this.sMask = mask;
    this.sBest = r * r;
    this.sFound = -1;
    for (const t of this.large) this.testSphere(t, cx, cy, cz);
    const ix0 = this.ix(cx - r), ix1 = this.ix(cx + r), iy0 = this.iy(cy - r), iy1 = this.iy(cy + r), iz0 = this.iz(cz - r), iz1 = this.iz(cz + r);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const k = this.key(ix, iy, iz);
          for (let i = this.cellStart[k]!, end = this.cellStart[k + 1]!; i < end; i++) this.testSphere(this.cellItems[i]!, cx, cy, cz);
        }
      }
    }
    const found = this.sFound, best = this.sBest, bx = this.bx, by = this.by, bz = this.bz;
    if (found < 0) return false;
    const d = Math.sqrt(best);
    out.x = bx; out.y = by; out.z = bz;
    if (d > 1e-9) {
      out.nx = (cx - bx) / d; out.ny = (cy - by) / d; out.nz = (cz - bz) / d;
    } else {
      out.nx = this.N[found * 3]!; out.ny = this.N[found * 3 + 1]!; out.nz = this.N[found * 3 + 2]!;
    }
    out.depth = r - d;
    out.group = this.G[found]!;
    return true;
  }

  /** Nearest hit of a ray (unit direction) within maxT. Triangles are two-sided; the normal faces the ray origin. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, mask: number, out: RayHit): boolean {
    if (this.dirty) this.build();
    if (this.G.length === 0) return false;
    this.sId = this.nextQuery();
    this.sMask = mask;
    this.sBest = maxT;
    this.sFound = -1;
    for (const t of this.large) this.testRay(t, ox, oy, oz, dx, dy, dz);

    // Clip the ray to the grid, then walk the cells it passes through (3D DDA).
    let t0 = 0, t1 = maxT;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    let inside = true;
    for (let a = 0; a < 3 && inside; a++) {
      const lo = this.min[a as 0 | 1 | 2], hi = this.max[a as 0 | 1 | 2];
      if (Math.abs(d[a]!) < 1e-12) {
        if (o[a]! < lo || o[a]! > hi) inside = false;
      } else {
        const ta = (lo - o[a]!) / d[a]!, tb = (hi - o[a]!) / d[a]!;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
        if (t0 > t1) inside = false;
      }
    }
    if (inside) {
      let ix = this.ix(ox + dx * t0), iy = this.iy(oy + dy * t0), iz = this.iz(oz + dz * t0);
      const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
      const c = this.cell;
      let tx = Math.abs(dx) < 1e-12 ? Infinity : (this.min[0] + (ix + (dx > 0 ? 1 : 0)) * c - ox) / dx;
      let ty = Math.abs(dy) < 1e-12 ? Infinity : (this.min[1] + (iy + (dy > 0 ? 1 : 0)) * c - oy) / dy;
      let tz = Math.abs(dz) < 1e-12 ? Infinity : (this.min[2] + (iz + (dz > 0 ? 1 : 0)) * c - oz) / dz;
      const stepX = Math.abs(dx) < 1e-12 ? Infinity : c / Math.abs(dx);
      const stepY = Math.abs(dy) < 1e-12 ? Infinity : c / Math.abs(dy);
      const stepZ = Math.abs(dz) < 1e-12 ? Infinity : c / Math.abs(dz);
      for (;;) {
        const k = this.key(ix, iy, iz);
        for (let i = this.cellStart[k]!, end = this.cellStart[k + 1]!; i < end; i++) this.testRay(this.cellItems[i]!, ox, oy, oz, dx, dy, dz);
        const next = Math.min(tx, ty, tz);
        if (this.sBest <= next || next > t1) break;
        if (tx <= ty && tx <= tz) { ix += sx; tx += stepX; if (ix < 0 || ix >= this.nx) break; }
        else if (ty <= tz) { iy += sy; ty += stepY; if (iy < 0 || iy >= this.ny) break; }
        else { iz += sz; tz += stepZ; if (iz < 0 || iz >= this.nz) break; }
      }
    }
    const found = this.sFound, best = this.sBest;
    if (found < 0) return false;
    out.t = best;
    out.x = ox + dx * best; out.y = oy + dy * best; out.z = oz + dz * best;
    let nx = this.N[found * 3]!, ny = this.N[found * 3 + 1]!, nz = this.N[found * 3 + 2]!;
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    out.nx = nx; out.ny = ny; out.nz = nz;
    out.group = this.G[found]!;
    return true;
  }

  private testSphere(t: number, cx: number, cy: number, cz: number): void {
    if (this.stamp[t] === this.sId) return;
    this.stamp[t] = this.sId;
    if ((this.groups[this.G[t]!]!.layer & this.sMask) === 0) return;
    const d2 = this.closestOnTriangle(t, cx, cy, cz);
    if (d2 < this.sBest) {
      this.sBest = d2;
      this.sFound = t;
      this.bx = this.qx; this.by = this.qy; this.bz = this.qz;
    }
  }

  private testRay(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    if (this.stamp[t] === this.sId) return;
    this.stamp[t] = this.sId;
    if ((this.groups[this.G[t]!]!.layer & this.sMask) === 0) return;
    const hit = this.rayTriangle(t, ox, oy, oz, dx, dy, dz);
    if (hit >= 0 && hit <= this.sBest) {
      this.sBest = hit;
      this.sFound = t;
    }
  }

  private nextQuery(): number {
    if (this.query >= 0xffffffff) {
      this.stamp.fill(0);
      this.query = 0;
    }
    return ++this.query;
  }

  private ix(x: number): number {
    const i = Math.floor((x - this.min[0]) / this.cell);
    return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
  }

  private iy(y: number): number {
    const i = Math.floor((y - this.min[1]) / this.cell);
    return i < 0 ? 0 : i >= this.ny ? this.ny - 1 : i;
  }

  private iz(z: number): number {
    const i = Math.floor((z - this.min[2]) / this.cell);
    return i < 0 ? 0 : i >= this.nz ? this.nz - 1 : i;
  }

  private key(ix: number, iy: number, iz: number): number {
    return (iz * this.ny + iy) * this.nx + ix;
  }

  /** Closest point on triangle t to p (Ericson, Real-Time Collision Detection §5.1.5). Returns the squared distance. */
  private closestOnTriangle(t: number, px: number, py: number, pz: number): number {
    const V = this.V, o = t * 9;
    const ax = V[o]!, ay = V[o + 1]!, az = V[o + 2]!;
    const abx = V[o + 3]! - ax, aby = V[o + 4]! - ay, abz = V[o + 5]! - az;
    const acx = V[o + 6]! - ax, acy = V[o + 7]! - ay, acz = V[o + 8]! - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let v = 0, w = 0;
    if (!(d1 <= 0 && d2 <= 0)) {
      const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) {
        v = 1;
      } else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          v = d1 / (d1 - d3);
        } else {
          const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
          const d5 = abx * cpx + aby * cpy + abz * cpz;
          const d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) {
            w = 1;
          } else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) {
              w = d2 / (d2 - d6);
            } else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                w = (d4 - d3) / (d4 - d3 + (d5 - d6));
                v = 1 - w;
              } else {
                const denom = 1 / (va + vb + vc);
                v = vb * denom;
                w = vc * denom;
              }
            }
          }
        }
      }
    }
    this.qx = ax + abx * v + acx * w;
    this.qy = ay + aby * v + acy * w;
    this.qz = az + abz * v + acz * w;
    const dx = px - this.qx, dy = py - this.qy, dz = pz - this.qz;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Möller–Trumbore, two-sided. Returns the ray parameter or -1. */
  private rayTriangle(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const V = this.V, o = t * 9;
    const ax = V[o]!, ay = V[o + 1]!, az = V[o + 2]!;
    const e1x = V[o + 3]! - ax, e1y = V[o + 4]! - ay, e1z = V[o + 5]! - az;
    const e2x = V[o + 6]! - ax, e2y = V[o + 7]! - ay, e2z = V[o + 8]! - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) return -1;
    const inv = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return -1;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return -1;
    const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return hit >= 0 ? hit : -1;
  }
}
