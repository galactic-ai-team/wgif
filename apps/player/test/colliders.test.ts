import { describe, expect, it } from 'vitest';
import { LAYER_ALL, LAYER_PROP, LAYER_SOLID, StaticColliders, newContact, newRayHit } from '../src/sim/colliders.js';

/** Small deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSoup(count: number, size: number, extent: number, seed: number): number[][] {
  const r = rng(seed);
  const tris: number[][] = [];
  for (let i = 0; i < count; i++) {
    const c = [r() * extent, r() * extent, r() * extent];
    const tri: number[] = [];
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) tri.push(c[k]! + (r() - 0.5) * size);
    tris.push(tri);
  }
  return tris;
}

describe('StaticColliders.closest', () => {
  it('reports the surface point, normal and overlap for a sphere resting in a floor', () => {
    const world = new StaticColliders();
    world.addBox('floor', [-5, -1, -5], [5, 0, 5]);
    const c = newContact();
    expect(world.closest(1, 0.08, 2, 0.12, LAYER_SOLID, c)).toBe(true);
    expect(c.depth).toBeCloseTo(0.04, 12);
    expect([c.nx, c.ny, c.nz]).toEqual([0, 1, 0]);
    expect([c.x, c.y, c.z]).toEqual([1, 0, 2]);
    expect(world.groups[c.group]?.name).toBe('floor');
    expect(world.closest(1, 0.2, 2, 0.12, LAYER_SOLID, c)).toBe(false);
    expect(world.closest(100, 0.05, 2, 0.12, LAYER_SOLID, c)).toBe(false);
  });

  it('pushes out of edges and corners along the true closest direction', () => {
    const world = new StaticColliders();
    world.addBox('block', [0, 0, 0], [1, 1, 1]);
    const c = newContact();
    // Above the +X/+Y edge: the closest point is on the edge, the normal is diagonal.
    expect(world.closest(1.05, 1.05, 0.5, 0.12, LAYER_SOLID, c)).toBe(true);
    expect(c.x).toBeCloseTo(1, 12);
    expect(c.y).toBeCloseTo(1, 12);
    expect(c.nx).toBeCloseTo(Math.SQRT1_2, 9);
    expect(c.ny).toBeCloseTo(Math.SQRT1_2, 9);
    expect(c.depth).toBeCloseTo(0.12 - Math.hypot(0.05, 0.05), 12);
  });

  it('finds the true closest point on a triangle (checked against dense sampling)', () => {
    const r = rng(7);
    for (let n = 0; n < 200; n++) {
      const tri = Array.from({ length: 9 }, () => (r() - 0.5) * 4);
      const p = [(r() - 0.5) * 6, (r() - 0.5) * 6, (r() - 0.5) * 6] as const;
      const world = new StaticColliders();
      if (world.addMesh('t', tri).triangles === 0) continue;
      const c = newContact();
      expect(world.closest(p[0], p[1], p[2], 100, LAYER_SOLID, c)).toBe(true);
      const got = 100 - c.depth;
      let best = Infinity;
      const S = 60;
      for (let i = 0; i <= S; i++) {
        for (let j = 0; j <= S - i; j++) {
          const u = i / S, v = j / S, w = 1 - u - v;
          const d = Math.hypot(
            tri[0]! * w + tri[3]! * u + tri[6]! * v - p[0],
            tri[1]! * w + tri[4]! * u + tri[7]! * v - p[1],
            tri[2]! * w + tri[5]! * u + tri[8]! * v - p[2],
          );
          best = Math.min(best, d);
        }
      }
      expect(got).toBeLessThanOrEqual(best + 1e-9);
      expect(got).toBeGreaterThan(best - 0.12); // sampling is coarse; the exact answer is never much lower
      expect(Math.hypot(c.x - p[0], c.y - p[1], c.z - p[2])).toBeCloseTo(got, 9);
    }
  });

  it('gives the same answer with the grid as a brute-force scan', () => {
    const soup = randomSoup(400, 0.8, 12, 11);
    const world = new StaticColliders();
    world.addMesh('soup', soup.flat());
    world.addBox('floor', [-2, -1, -2], [14, 0, 14]); // big triangles take the "large" path
    const singles = [...soup, ...boxTriangles([-2, -1, -2], [14, 0, 14])].map((t) => {
      const w = new StaticColliders();
      w.addMesh('one', t);
      return w;
    });
    const r = rng(3);
    const a = newContact(), b = newContact();
    let hits = 0;
    for (let n = 0; n < 500; n++) {
      const p = [r() * 12, r() * 12 - 0.5, r() * 12] as const;
      const radius = 0.1 + r() * 0.6;
      let depth = -Infinity;
      for (const w of singles) if (w.closest(p[0], p[1], p[2], radius, LAYER_SOLID, b)) depth = Math.max(depth, b.depth);
      const hit = world.closest(p[0], p[1], p[2], radius, LAYER_SOLID, a);
      expect(hit).toBe(depth > -Infinity);
      if (hit) {
        hits++;
        expect(a.depth).toBeCloseTo(depth, 9);
      }
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('honours layers and per-group restitution', () => {
    const world = new StaticColliders();
    world.addBox('floor', [-5, -1, -5], [5, 0, 5]);
    const rim = world.addBox('rim', [-0.1, 1, -0.1], [0.1, 1.02, 0.1], { layer: LAYER_PROP, restitution: 0.7 });
    const c = newContact();
    expect(world.closest(0, 1.1, 0, 0.12, LAYER_SOLID, c)).toBe(false);
    expect(world.closest(0, 1.1, 0, 0.12, LAYER_PROP, c)).toBe(true);
    expect(world.closest(0, 1.1, 0, 0.12, LAYER_ALL, c)).toBe(true);
    expect(c.group).toBe(rim.id);
    expect(world.groups[c.group]?.restitution).toBe(0.7);
    expect(world.triangleCount).toBe(24);
  });

  it('drops degenerate and non-finite triangles and survives an empty world', () => {
    const world = new StaticColliders();
    const c = newContact(), h = newRayHit();
    expect(world.closest(0, 0, 0, 1, LAYER_ALL, c)).toBe(false);
    expect(world.raycast(0, 1, 0, 0, -1, 0, 10, LAYER_ALL, h)).toBe(false);
    const g = world.addMesh('bad', [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, NaN, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(g.triangles).toBe(1);
    expect(world.closest(0.2, 0.01, 0.2, 0.1, LAYER_ALL, c)).toBe(true);
  });
});

function boxTriangles(min: [number, number, number], max: [number, number, number]): number[][] {
  const w = new StaticColliders();
  w.addBox('b', min, max);
  // Re-derive the same 12 triangles the helper adds.
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const p = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const out: number[][] = [];
  for (let t = 0; t < i.length; t += 3) out.push([0, 1, 2].flatMap((k) => [p[i[t + k]! * 3]!, p[i[t + k]! * 3 + 1]!, p[i[t + k]! * 3 + 2]!]));
  expect(w.triangleCount).toBe(out.length);
  return out;
}

describe('StaticColliders.raycast', () => {
  it('hits the first surface and reports a normal facing the ray', () => {
    const world = new StaticColliders();
    world.addBox('floor', [-5, -1, -5], [5, 0, 5]);
    world.addBox('table', [-1, 0.9, -1], [1, 1, 1]);
    const h = newRayHit();
    expect(world.raycast(0.2, 3, 0.3, 0, -1, 0, 10, LAYER_SOLID, h)).toBe(true);
    expect(h.t).toBeCloseTo(2, 12);
    expect(h.y).toBeCloseTo(1, 12);
    expect(h.ny).toBe(1);
    expect(world.groups[h.group]?.name).toBe('table');
    expect(world.raycast(3, 3, 3, 0, -1, 0, 10, LAYER_SOLID, h)).toBe(true);
    expect(h.y).toBeCloseTo(0, 12);
    // From underneath, the normal flips to face the ray.
    expect(world.raycast(0, 0.5, 0, 0, 1, 0, 10, LAYER_SOLID, h)).toBe(true);
    expect(h.y).toBeCloseTo(0.9, 12);
    expect(h.ny).toBe(-1);
    // Too short, or pointing away.
    expect(world.raycast(0, 3, 0, 0, -1, 0, 1.5, LAYER_SOLID, h)).toBe(false);
    expect(world.raycast(0, 3, 0, 0, 1, 0, 50, LAYER_SOLID, h)).toBe(false);
  });

  it('works from outside the grid and for axis-parallel and slanted rays', () => {
    const world = new StaticColliders();
    world.addBox('wall', [4, 0, -3], [4.2, 3, 3]);
    world.addBox('floor', [-5, -1, -5], [5, 0, 5]);
    const h = newRayHit();
    expect(world.raycast(-50, 1, 0, 1, 0, 0, 100, LAYER_SOLID, h)).toBe(true);
    expect(h.x).toBeCloseTo(4, 9);
    expect(h.nx).toBe(-1);
    const d = Math.SQRT1_2;
    expect(world.raycast(0, 2, 0, d, -d, 0, 100, LAYER_SOLID, h)).toBe(true);
    expect(h.y).toBeCloseTo(0, 9);
    expect(h.x).toBeCloseTo(2, 9);
    expect(world.raycast(-50, 10, 0, 1, 0, 0, 100, LAYER_SOLID, h)).toBe(false);
  });

  it('agrees with a brute-force scan on random rays', () => {
    const soup = randomSoup(500, 3, 10, 21);
    const world = new StaticColliders();
    world.addMesh('soup', soup.flat());
    const singles = soup.map((t) => {
      const w = new StaticColliders();
      w.addMesh('one', t);
      return w;
    });
    const r = rng(5);
    const a = newRayHit(), b = newRayHit();
    let hits = 0;
    for (let n = 0; n < 600; n++) {
      const o = [r() * 14 - 2, r() * 14 - 2, r() * 14 - 2] as const;
      const d = [r() - 0.5, r() - 0.5, r() - 0.5];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!);
      const [dx, dy, dz] = [d[0]! / l, d[1]! / l, d[2]! / l];
      let best = Infinity;
      for (const w of singles) if (w.raycast(o[0], o[1], o[2], dx, dy, dz, 30, LAYER_SOLID, b)) best = Math.min(best, b.t);
      const hit = world.raycast(o[0], o[1], o[2], dx, dy, dz, 30, LAYER_SOLID, a);
      expect(hit).toBe(best < Infinity);
      if (hit) {
        hits++;
        expect(a.t).toBeCloseTo(best, 9);
      }
    }
    expect(hits).toBeGreaterThan(100);
  });
});
