import { newContact, type StaticColliders } from './colliders.js';
import type { Vec3 } from './vec.js';

/** Light ballistic physics for a sphere (the basketball): gravity, bounces, rolling friction, sleep. */

export const GRAVITY = 9.81;
/** Approach speeds below this do not bounce, so a ball settles instead of buzzing on the floor. */
const DEAD_BOUNCE_SPEED = 0.6;
/** Fraction of sliding speed a bounce can take away at most (a hollow sphere that starts to roll keeps 3/5). */
const NO_SLIP_LOSS = 0.4;
const SLEEP_SPEED = 0.08;
const SLEEP_AFTER = 0.4;
const MAX_SPEED = 30;
const MAX_SUBSTEPS = 16;

export interface BallParams {
  radius: number;
  /** Bounciness on a plain surface, 0..1. A collider group can scale it down (see ColliderOptions.restitution). */
  restitution: number;
  /** Coulomb friction used at bounces, 0..1. */
  friction: number;
  /** Rolling resistance as a fraction of gravity. */
  rollingFriction?: number;
}

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  /** True while the ball touches walkable ground. */
  grounded: boolean;
  /** True once the ball has stopped; a sleeping ball costs nothing until something wakes it. */
  resting: boolean;
  restTime: number;
}

export interface BallHooks {
  /** A bounce: which collider group was hit and how fast the ball was approaching it. */
  onBounce?(group: number, speed: number): void;
  /** Every substep, with the centre before and after. Triggers sweep these segments. */
  onMove?(prev: Vec3, cur: Vec3): void;
}

export const newBall = (pos: Vec3): BallState => ({ pos: [pos[0], pos[1], pos[2]], vel: [0, 0, 0], grounded: false, resting: false, restTime: 0 });

export function wake(ball: BallState): void {
  ball.resting = false;
  ball.restTime = 0;
}

const contact = newContact();
const prev: Vec3 = [0, 0, 0];

/**
 * Advances a ball by dt seconds. The step is split so the ball never moves more than 0.4 radii at
 * once, which is what keeps it from tunnelling through thin geometry such as a rim or a backboard.
 */
export function stepBall(ball: BallState, params: BallParams, world: StaticColliders, dt: number, mask: number, hooks: BallHooks = {}): void {
  if (ball.resting || dt <= 0) return;
  const { pos, vel } = ball;
  const r = params.radius;
  const rolling = (params.rollingFriction ?? 0.1) * GRAVITY;
  const speed = Math.hypot(vel[0], vel[1], vel[2]) + GRAVITY * dt;
  const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil((speed * dt) / (0.4 * r))));
  const h = dt / steps;
  let grounded = false;

  for (let s = 0; s < steps; s++) {
    prev[0] = pos[0]; prev[1] = pos[1]; prev[2] = pos[2];
    vel[1] -= GRAVITY * h;
    const v = Math.hypot(vel[0], vel[1], vel[2]);
    if (v > MAX_SPEED) {
      const k = MAX_SPEED / v;
      vel[0] *= k; vel[1] *= k; vel[2] *= k;
    }
    pos[0] += vel[0] * h; pos[1] += vel[1] * h; pos[2] += vel[2] * h;

    grounded = false;
    // Deepest contact first, then look again: that way a ball resting on flat ground made of
    // several triangles never gets a sideways kick from a neighbouring triangle's edge.
    for (let i = 0; i < 4 && world.closest(pos[0], pos[1], pos[2], r, mask, contact); i++) {
      const { nx, ny, nz } = contact;
      pos[0] += nx * contact.depth; pos[1] += ny * contact.depth; pos[2] += nz * contact.depth;
      if (ny > 0.6) grounded = true;
      const vn = vel[0] * nx + vel[1] * ny + vel[2] * nz;
      if (vn >= 0) continue;
      const approach = -vn;
      const bounce = approach > DEAD_BOUNCE_SPEED;
      const e = bounce ? params.restitution * (world.groups[contact.group]?.restitution ?? 1) : 0;
      const jn = (1 + e) * approach;
      vel[0] += nx * jn; vel[1] += ny * jn; vel[2] += nz * jn;
      if (bounce) {
        const tx = vel[0] - nx * (e * approach), ty = vel[1] - ny * (e * approach), tz = vel[2] - nz * (e * approach);
        const slide = Math.hypot(tx, ty, tz);
        if (slide > 1e-6) {
          const loss = Math.min(params.friction * jn, NO_SLIP_LOSS * slide) / slide;
          vel[0] -= tx * loss; vel[1] -= ty * loss; vel[2] -= tz * loss;
        }
        hooks.onBounce?.(contact.group, approach);
      }
    }

    if (grounded) {
      const roll = Math.hypot(vel[0], vel[2]);
      if (roll > 0) {
        const k = Math.max(0, roll - rolling * h) / roll;
        vel[0] *= k; vel[2] *= k;
      }
    }
    hooks.onMove?.(prev, pos);
  }

  ball.grounded = grounded;
  if (grounded && Math.hypot(vel[0], vel[1], vel[2]) < SLEEP_SPEED) {
    ball.restTime += dt;
    if (ball.restTime >= SLEEP_AFTER) {
      ball.resting = true;
      vel[0] = vel[1] = vel[2] = 0;
    }
  } else {
    ball.restTime = 0;
  }
}

/** Launch velocity that carries a ball from `from` to `to` in `flightSec` of free flight. */
export function ballisticVelocity(from: Vec3, to: Vec3, flightSec: number): Vec3 {
  const t = Math.max(flightSec, 1e-3);
  return [(to[0] - from[0]) / t, (to[1] - from[1]) / t + 0.5 * GRAVITY * t, (to[2] - from[2]) / t];
}
