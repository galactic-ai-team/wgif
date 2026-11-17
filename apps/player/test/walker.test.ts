import { describe, expect, it } from 'vitest';
import { StaticColliders } from '../src/sim/colliders.js';
import { Walker, type MoveInput } from '../src/sim/walker.js';

const TICK = 1 / 120;
const AHEAD: MoveInput = { forward: 1, right: 0, run: false };

function arena(): StaticColliders {
  const world = new StaticColliders();
  world.addBox('floor', [-20, -1, -20], [20, 0, 20]);
  return world;
}

function walk(w: Walker, seconds: number, input: MoveInput = AHEAD): void {
  for (let i = 0; i < Math.round(seconds / TICK); i++) w.step(TICK, input);
}

describe('walker', () => {
  it('follows three.js camera conventions for yaw and pitch', () => {
    const w = new Walker(arena());
    expect(w.forward).toEqual([-0, 0, -1]);
    expect(w.right).toEqual([1, 0, -0]);
    expect(w.up.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 1, 0]);
    w.look(Math.PI / 2, 0);
    expect(w.forward[0]).toBeCloseTo(-1, 12);
    expect(w.forward[2]).toBeCloseTo(0, 12);
    w.spawn([0, 1.7, 0], [3, 1.7, 0]);
    expect(w.forward[0]).toBeCloseTo(1, 12);
    w.lookAt([0, 100, 0]);
    expect(w.pitch).toBeLessThan(Math.PI / 2);
    expect(w.forward[1]).toBeGreaterThan(0.99);
  });

  it('stands on the ground and walks at walking speed, faster when running', () => {
    const w = new Walker(arena());
    w.spawn([0, 1.7, 5]);
    expect(w.feet[1]).toBeCloseTo(0, 9);
    expect(w.grounded).toBe(true);
    walk(w, 1);
    expect(w.feet[2]).toBeCloseTo(1, 6);
    expect(w.eye[1]).toBeCloseTo(1.7, 9);
    walk(w, 1, { forward: 1, right: 0, run: true });
    expect(w.feet[2]).toBeCloseTo(-7, 6);
    // Diagonal input is normalised, analog input scales the speed.
    w.spawn([0, 1.7, 0]);
    walk(w, 1, { forward: 1, right: 1, run: false });
    expect(Math.hypot(w.feet[0], w.feet[2])).toBeCloseTo(4, 6);
    w.spawn([0, 1.7, 0]);
    walk(w, 1, { forward: 0.25, right: 0, run: false });
    expect(w.feet[2]).toBeCloseTo(-1, 6);
  });

  it('is stopped by a wall and slides along it', () => {
    const world = arena();
    world.addBox('wall', [-10, 0, -3.2], [10, 3, -3]);
    const w = new Walker(world);
    w.spawn([0, 1.7, 0]);
    walk(w, 3);
    expect(w.feet[2]).toBeCloseTo(-3 + w.radius, 3);
    // Walking into the wall at 45° keeps the sideways part of the motion.
    w.look(-Math.PI / 4, 0);
    const x0 = w.feet[0];
    walk(w, 1);
    expect(w.feet[2]).toBeCloseTo(-3 + w.radius, 3);
    expect(w.feet[0] - x0).toBeCloseTo(4 * Math.SQRT1_2, 1);
  });

  it('cannot squeeze through a thin pole or into a corner', () => {
    const world = arena();
    world.addBox('pole', [-0.1, 0, -4.1], [0.1, 4, -3.9]);
    const w = new Walker(world);
    w.spawn([0, 1.7, 0]);
    walk(w, 3);
    expect(w.feet[2]).toBeGreaterThan(-3.9 + w.radius - 1e-3);
    world.addBox('wallA', [3, 0, -10], [3.2, 3, 10]);
    world.addBox('wallB', [-10, 0, -8.2], [10, 3, -8]);
    w.spawn([1, 1.7, -6], [5, 1.7, -10]);
    walk(w, 4, { forward: 1, right: 0, run: true });
    expect(w.feet[0]).toBeLessThanOrEqual(3 - w.radius + 1e-3);
    expect(w.feet[2]).toBeGreaterThanOrEqual(-8 + w.radius - 1e-3);
  });

  it('steps up low ledges, is blocked by tall ones, and climbs stairs', () => {
    const world = arena();
    world.addBox('kerb', [-5, 0, -4], [5, 0.3, -2]);
    world.addBox('crate', [-5, 0, -8], [5, 0.9, -6]);
    const w = new Walker(world);
    w.spawn([0, 1.7, 0]);
    walk(w, 0.6);
    expect(w.feet[1]).toBeCloseTo(0.3, 6);
    walk(w, 2);
    expect(w.feet[1]).toBeCloseTo(0, 6); // stepped back down behind the kerb
    expect(w.feet[2]).toBeCloseTo(-6 + w.radius, 2); // and stopped at the crate
    const stairs = arena();
    for (let i = 0; i < 6; i++) stairs.addBox(`step${i}`, [-2, 0, -3 - i * 0.5 - 10], [2, 0.25 * (i + 1), -3 - i * 0.5]);
    const c = new Walker(stairs);
    c.spawn([0, 1.7, 0]);
    walk(c, 1.6);
    expect(c.feet[1]).toBeCloseTo(1.5, 6);
    expect(c.grounded).toBe(true);
  });

  it('falls off a high ledge and lands', () => {
    const world = arena();
    world.addBox('stage', [-5, 0, 0], [5, 2, 10]);
    const w = new Walker(world);
    w.spawn([0, 3.7, 1]);
    expect(w.feet[1]).toBeCloseTo(2, 9);
    walk(w, 0.3);
    expect(w.grounded).toBe(false);
    expect(w.feet[1]).toBeLessThan(2);
    walk(w, 1);
    expect(w.grounded).toBe(true);
    expect(w.feet[1]).toBeCloseTo(0, 9);
  });

  it('stays inside the declared bounds', () => {
    const w = new Walker(arena(), { bounds: { min: [-17, 0, -10], max: [17, 6, 10] } });
    w.spawn([0, 1.7, 9.5]);
    walk(w, 10, { forward: -1, right: 1, run: true });
    expect(w.feet[0]).toBe(17);
    expect(w.feet[2]).toBe(10);
  });

  it('returns to safe ground after walking off the world', () => {
    const world = new StaticColliders();
    world.addBox('island', [-2, -1, -2], [2, 0, 2]);
    const w = new Walker(world);
    w.spawn([0, 1.7, 0]);
    walk(w, 1);
    expect(w.grounded).toBe(false);
    expect(w.feet[2]).toBeLessThan(-2);
    walk(w, 4, { forward: 0, right: 0, run: false });
    expect(w.grounded).toBe(true);
    expect(Math.abs(w.feet[2])).toBeLessThanOrEqual(2.01);
    expect(w.feet[1]).toBeCloseTo(0, 6);
  });

  it('treats a world without colliders as a flat floor', () => {
    const w = new Walker(new StaticColliders(), { eyeHeight: 1.6 });
    w.spawn([1, 1.6, 2]);
    walk(w, 1);
    expect(w.feet[0]).toBe(1);
    expect(w.feet[1]).toBe(0);
    expect(w.feet[2]).toBeCloseTo(-2, 9);
    expect(w.grounded).toBe(true);
  });
});

describe('walker vectors', () => {
  it('writes the same vectors into caller-owned arrays as the getters return', () => {
    const w = new Walker(arena());
    for (const [yaw, pitch] of [[0, 0], [0.7, 0.3], [-2.1, -1.2], [3, 1.4]] as const) {
      w.yaw = yaw;
      w.pitch = pitch;
      const out: [number, number, number] = [9, 9, 9];
      expect(w.eyeInto(out)).toBe(out);
      expect(out).toEqual(w.eye);
      expect(w.forwardInto([0, 0, 0])).toEqual(w.forward);
      expect(w.rightInto([0, 0, 0])).toEqual(w.right);
      const up = w.upInto([0, 0, 0]);
      w.up.forEach((v, i) => expect(up[i]).toBeCloseTo(v, 12));
    }
  });
});
