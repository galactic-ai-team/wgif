import { describe, expect, it } from 'vitest';
import { GRAVITY, ballisticVelocity, newBall, stepBall, wake, type BallParams } from '../src/sim/ball.js';
import { LAYER_ALL, LAYER_PROP, StaticColliders } from '../src/sim/colliders.js';
import type { Vec3 } from '../src/sim/vec.js';

const TICK = 1 / 120;
const ball: BallParams = { radius: 0.12, restitution: 0.75, friction: 0.6 };

function floorWorld(): StaticColliders {
  const world = new StaticColliders();
  world.addBox('floor', [-30, -1, -30], [30, 0, 30]);
  return world;
}

describe('ball physics', () => {
  it('falls under gravity', () => {
    const b = newBall([0, 10, 0]);
    for (let i = 0; i < 120; i++) stepBall(b, ball, floorWorld(), TICK, LAYER_ALL);
    // Semi-implicit Euler lands within a step's worth of error of g·t²/2.
    expect(10 - b.pos[1]).toBeCloseTo(GRAVITY / 2, 1);
    expect(b.vel[1]).toBeCloseTo(-GRAVITY, 6);
  });

  it('bounces off the floor with the declared restitution', () => {
    const world = floorWorld();
    const b = newBall([0, 2.12, 0]);
    const bounces: number[] = [];
    let apex = 0, rising = false;
    const apexes: number[] = [];
    for (let i = 0; i < 600; i++) {
      stepBall(b, ball, world, TICK, LAYER_ALL, { onBounce: (_g, speed) => bounces.push(speed) });
      if (b.vel[1] > 0) { rising = true; apex = Math.max(apex, b.pos[1]); }
      else if (rising) { apexes.push(apex - ball.radius); rising = false; apex = 0; }
      expect(b.pos[1]).toBeGreaterThanOrEqual(ball.radius - 1e-9);
    }
    expect(bounces[0]).toBeCloseTo(Math.sqrt(2 * GRAVITY * 2), 1);
    // Drop height 2 m: each apex is e² times the one before.
    expect(apexes[0]! / 2).toBeCloseTo(0.75 ** 2, 1);
    expect(apexes[1]! / apexes[0]!).toBeCloseTo(0.75 ** 2, 1);
  });

  it('settles on the floor and goes to sleep', () => {
    const world = floorWorld();
    const b = newBall([0, 1.5, 0]);
    b.vel = [1.5, 0, 0.5];
    let ticks = 0;
    while (!b.resting && ticks < 120 * 30) { stepBall(b, ball, world, TICK, LAYER_ALL); ticks++; }
    expect(b.resting).toBe(true);
    expect(ticks).toBeLessThan(120 * 15);
    expect(b.pos[1]).toBeCloseTo(ball.radius, 6);
    expect(b.vel).toEqual([0, 0, 0]);
    const at = [...b.pos];
    for (let i = 0; i < 240; i++) stepBall(b, ball, world, TICK, LAYER_ALL);
    expect(b.pos).toEqual(at);
    wake(b);
    b.vel = [0, 3, 0];
    stepBall(b, ball, world, TICK, LAYER_ALL);
    expect(b.pos[1]).toBeGreaterThan(at[1]!);
  });

  it('rolls in a straight line across a floor built from several triangles', () => {
    const world = new StaticColliders();
    // Four tiles meeting at the origin: eight coplanar triangles with edges under the path.
    for (const [x, z] of [[-10, -10], [0, -10], [-10, 0], [0, 0]] as const) world.addBox(`tile${x}${z}`, [x, -0.2, z], [x + 10, 0, z + 10]);
    const b = newBall([-6, ball.radius, -5.9]);
    b.vel = [4, 0, 4];
    let ticks = 0;
    while (!b.resting && ticks < 120 * 30) { stepBall(b, ball, world, TICK, LAYER_ALL); ticks++; }
    expect(b.resting).toBe(true);
    // Still on the diagonal it started on, and it travelled roughly v²/(2·μ·g).
    expect(b.pos[2] - b.pos[0]).toBeCloseTo(0.1, 3);
    const travelled = Math.hypot(b.pos[0] + 6, b.pos[2] + 5.9);
    expect(travelled).toBeGreaterThan(0.8 * (32 / (2 * 0.1 * GRAVITY)));
    expect(travelled).toBeLessThan(1.05 * (32 / (2 * 0.1 * GRAVITY)));
  });

  it('never tunnels through thin geometry, even at top speed', () => {
    const world = floorWorld();
    world.addBox('backboard', [5, 0, -2], [5.02, 4, 2]);
    for (const speed of [5, 12, 20, 29, 60]) {
      for (const offset of [0, 0.013, 0.031, 0.05]) {
        const b = newBall([4 - offset, 1.5, 0.3]);
        b.vel = [speed, 2, 0];
        for (let i = 0; i < 240; i++) {
          stepBall(b, ball, world, TICK, LAYER_ALL);
          expect(b.pos[0]).toBeLessThanOrEqual(5 - ball.radius + 1e-6);
        }
        expect(b.vel[0]).toBeLessThanOrEqual(0);
      }
    }
  });

  it('bounces lower off a collider group with a restitution scale, and ignores masked layers', () => {
    const drop = (restitution: number | undefined, mask: number): number => {
      const world = new StaticColliders();
      world.addBox('floor', [-5, -1, -5], [5, 0, 5], restitution === undefined ? {} : { layer: LAYER_PROP, restitution });
      const b = newBall([0, 2, 0]);
      let apex = 0;
      for (let i = 0; i < 240; i++) {
        stepBall(b, ball, world, TICK, mask);
        if (b.vel[1] > 0) apex = Math.max(apex, b.pos[1]);
      }
      return apex;
    };
    expect(drop(0.5, LAYER_ALL)).toBeLessThan(drop(undefined, LAYER_ALL) * 0.5);
    expect(drop(0.5, 1)).toBe(0); // the prop layer is masked out: the ball falls straight through
  });

  it('loses sliding speed to friction at a bounce but keeps most of it', () => {
    const world = floorWorld();
    const b = newBall([0, 1, 0]);
    b.vel = [6, 0, 0];
    let after = 0;
    for (let i = 0; i < 120 && after === 0; i++) stepBall(b, ball, world, TICK, LAYER_ALL, { onBounce: () => (after = 1) });
    expect(b.vel[0]).toBeGreaterThan(6 * 0.55);
    expect(b.vel[0]).toBeLessThan(6);
  });

  it('is deterministic', () => {
    const run = (): Vec3 => {
      const world = floorWorld();
      world.addBox('box', [2, 0, -1], [3, 1, 1]);
      const b = newBall([0, 2, 0.2]);
      b.vel = [5, 3, 0.4];
      for (let i = 0; i < 600; i++) stepBall(b, ball, world, TICK, LAYER_ALL);
      return [...b.pos] as Vec3;
    };
    expect(run()).toEqual(run());
  });

  it('solves a lob that lands where it was aimed', () => {
    const from: Vec3 = [0, 2, 0], to: Vec3 = [7, 3.05, 1];
    const b = newBall(from);
    b.vel = ballisticVelocity(from, to, 1.2);
    const empty = new StaticColliders();
    for (let i = 0; i < 144; i++) stepBall(b, ball, empty, TICK, LAYER_ALL);
    expect(b.pos[0]).toBeCloseTo(7, 6);
    expect(b.pos[2]).toBeCloseTo(1, 6);
    expect(b.pos[1]).toBeCloseTo(3.05, 1);
  });
});
