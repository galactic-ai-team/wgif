import { GRAVITY } from './ball.js';
import { LAYER_SOLID, newContact, newRayHit, type StaticColliders } from './colliders.js';
import { clamp, type Vec3 } from './vec.js';
import type { Bounds } from './walker.js';

/**
 * A drivable vehicle (interactions.json `interactions[]` entry with `"type": "vehicle"`, see
 * docs/notes/vehicle-component.md): simple arcade physics, not a tyre model.
 *
 * - Throttle accelerates up to `maxSpeed` (or `reverseSpeed` backwards); throttle against the motion
 *   and the brake slow it down; with no input it coasts down on drag.
 * - Steering is a bicycle model (yaw rate = speed * tan(steer) / wheelBase), with less lock at speed.
 * - The body rides the ground: the floor height is sampled under the front and rear axles, so it
 *   climbs ramps and pitches with them, and falls when it drives off an edge.
 * - Walls and obstacles are three spheres along the body: steep contacts push it out and bounce
 *   the speed back; gentle slopes are floor. The play-area bounds keep it inside the world.
 *
 * Yaw follows the walker's convention: yaw 0 faces -Z and positive yaw turns left.
 * Deterministic: no clock, DOM or randomness.
 */
export interface VehicleParams {
  maxSpeed: number;
  reverseSpeed: number;
  accel: number;
  brake: number;
  /** Coasting deceleration with no throttle, m/s². */
  drag: number;
  /** Front-wheel lock at a standstill, radians. */
  maxSteer: number;
  /** How fast the wheel turns toward the lock, radians/s. */
  steerRate: number;
  wheelBase: number;
  /** Collision sphere radius (about half the body width). */
  radius: number;
  /** Body length; the collision spheres sit at the front, middle and back. */
  length: number;
}

export const DEFAULT_VEHICLE: VehicleParams = {
  maxSpeed: 16, reverseSpeed: 5, accel: 7, brake: 16, drag: 4, maxSteer: 0.55, steerRate: 3, wheelBase: 2.6, radius: 0.85, length: 4.2,
};

/** Analog driver input: throttle -1..1 (negative = reverse), steer -1..1 (positive = right), brake. */
export interface DriveInput {
  throttle: number;
  steer: number;
  brake: boolean;
}

export const IDLE_DRIVE: Readonly<DriveInput> = Object.freeze({ throttle: 0, steer: 0, brake: false });
/** A vehicle nobody drives: brakes on, wheel straight. Getting out stops the car where it is. */
export const PARKED: Readonly<DriveInput> = Object.freeze({ throttle: 0, steer: 0, brake: true });

/** The ground is anything at least this flat (cosine of the slope). Steeper contacts are walls. */
const FLOOR_NY = 0.6;
/** Ground is looked for from this far above the body, so it can climb onto a ramp. */
const PROBE_UP = 1.2;
const PROBE_DOWN = 3;
const FALL_LIMIT = 40;
/** What is left of the speed after hitting a wall head-on (negative: it bounces back a little). */
const BOUNCE = -0.25;

const contact = newContact();
const ray = newRayHit();

export class Vehicle {
  /** Ground point under the middle of the body. */
  readonly pos: Vec3;
  readonly prev: Vec3;
  yaw: number;
  prevYaw: number;
  /** Nose up is positive, from the ground under the axles. */
  pitch = 0;
  prevPitch = 0;
  /** Signed speed along the heading, m/s. */
  speed = 0;
  /** Current front-wheel angle, radians (positive = left). */
  steer = 0;
  /** Wheel rotation, radians, for drawing. */
  wheelSpin = 0;
  vy = 0;
  grounded = true;
  /** Set when the last step pushed the body off a wall or the bounds. */
  bumped = false;
  readonly spawn: Vec3;
  readonly spawnYaw: number;

  constructor(
    readonly id: string,
    private readonly world: StaticColliders,
    readonly params: VehicleParams,
    spawn: Vec3,
    yaw: number,
    private readonly bounds: Bounds | null = null,
    readonly wheelRadius = 0.34,
  ) {
    this.spawn = [spawn[0], spawn[1], spawn[2]];
    this.spawnYaw = yaw;
    this.pos = [spawn[0], spawn[1], spawn[2]];
    this.prev = [spawn[0], spawn[1], spawn[2]];
    this.yaw = this.prevYaw = yaw;
    this.settle();
  }

  /** Unit heading on the ground plane. */
  get forward(): Vec3 {
    return [-Math.sin(this.yaw), 0, -Math.cos(this.yaw)];
  }

  /** Back to the spawn point, stopped. */
  reset(): void {
    this.pos[0] = this.spawn[0]; this.pos[1] = this.spawn[1]; this.pos[2] = this.spawn[2];
    this.yaw = this.spawnYaw;
    this.speed = this.steer = this.vy = 0;
    this.settle();
    this.prev[0] = this.pos[0]; this.prev[1] = this.pos[1]; this.prev[2] = this.pos[2];
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
  }

  /** True while it is going anywhere (for the renderer's idle check). */
  get moving(): boolean {
    return Math.abs(this.speed) > 1e-3 || !this.grounded || Math.abs(this.steer) > 1e-4;
  }

  step(dt: number, input: DriveInput): void {
    const p = this.params;
    this.prev[0] = this.pos[0]; this.prev[1] = this.pos[1]; this.prev[2] = this.pos[2];
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    this.bumped = false;

    // Speed.
    const throttle = clamp(input.throttle, -1, 1);
    let v = this.speed;
    const slow = (rate: number): number => (v > 0 ? Math.max(0, v - rate * dt) : Math.min(0, v + rate * dt));
    if (input.brake) v = slow(p.brake);
    else if (throttle > 0.01) v = v < -0.05 ? slow(p.brake) : Math.min(p.maxSpeed, v + p.accel * throttle * dt);
    else if (throttle < -0.01) v = v > 0.05 ? slow(p.brake) : Math.max(-p.reverseSpeed, v + p.accel * throttle * dt);
    else v = slow(p.drag);
    if (!this.grounded) v = this.speed; // no grip in the air
    this.speed = v;

    // Steering: less lock at speed so a full turn at top speed is not a spin.
    const lock = p.maxSteer * (1 - 0.55 * Math.min(1, Math.abs(v) / p.maxSpeed));
    const target = -clamp(input.steer, -1, 1) * lock;
    const ds = target - this.steer, maxDs = p.steerRate * dt;
    this.steer += clamp(ds, -maxDs, maxDs);
    if (this.grounded) this.yaw += (v * Math.tan(this.steer) / p.wheelBase) * dt;

    // Move.
    const f = this.forward;
    this.pos[0] += f[0] * v * dt;
    this.pos[2] += f[2] * v * dt;
    this.wheelSpin += (v * dt) / this.wheelRadius;

    this.collide();
    this.clampToBounds();
    this.ride(dt);
  }

  /** Pushes the body out of walls and obstacles. */
  private collide(): void {
    const p = this.params, f = this.forward, r = p.radius;
    const reach = Math.max(0, p.length / 2 - r);
    for (let pass = 0; pass < 2; pass++) {
      for (const o of [reach, 0, -reach]) {
        const cx = this.pos[0] + f[0] * o, cz = this.pos[2] + f[2] * o, cy = this.pos[1] + r + 0.08;
        if (!this.world.closest(cx, cy, cz, r, LAYER_SOLID, contact)) continue;
        if (contact.ny > FLOOR_NY) continue; // floor or a ramp: ride() handles it
        const h = Math.hypot(contact.nx, contact.nz);
        if (h < 1e-6) continue;
        const nx = contact.nx / h, nz = contact.nz / h;
        this.pos[0] += nx * contact.depth;
        this.pos[2] += nz * contact.depth;
        // Only motion into the wall bounces; scraping along it keeps most of the speed.
        const into = (f[0] * nx + f[2] * nz) * Math.sign(this.speed);
        if (into < -0.3) {
          this.speed *= into < -0.7 ? BOUNCE : 0.6;
          this.bumped = true;
        }
      }
    }
  }

  private clampToBounds(): void {
    const b = this.bounds;
    if (!b) return;
    const r = this.params.radius;
    for (const axis of [0, 2] as const) {
      const lo = b.min[axis] + r, hi = b.max[axis] - r;
      if (this.pos[axis] < lo || this.pos[axis] > hi) {
        this.pos[axis] = clamp(this.pos[axis], lo, hi);
        this.speed *= BOUNCE;
        this.bumped = true;
      }
    }
  }

  /** Height of the floor under (x, z), looking down from just above the body, or null. */
  private floorAt(x: number, z: number): number | null {
    if (!this.world.raycast(x, this.pos[1] + PROBE_UP, z, 0, -1, 0, PROBE_UP + PROBE_DOWN, LAYER_SOLID, ray)) return null;
    return ray.ny > FLOOR_NY ? ray.y : null;
  }

  /** Follows the ground under both axles (ramps pitch the body), or falls. */
  private ride(dt: number): void {
    const f = this.forward, half = this.params.wheelBase / 2;
    const front = this.floorAt(this.pos[0] + f[0] * half, this.pos[2] + f[2] * half);
    const rear = this.floorAt(this.pos[0] - f[0] * half, this.pos[2] - f[2] * half);
    const ground = front !== null && rear !== null ? (front + rear) / 2 : (front ?? rear);
    if (ground !== null && this.pos[1] - ground <= 0.05 + Math.max(0, -this.vy) * dt) {
      this.pos[1] = ground;
      this.vy = 0;
      this.grounded = true;
      if (front !== null && rear !== null) this.pitch = Math.atan2(front - rear, this.params.wheelBase);
      return;
    }
    this.grounded = false;
    this.vy -= GRAVITY * dt;
    this.pos[1] += this.vy * dt;
    if (ground !== null && this.pos[1] < ground) {
      this.pos[1] = ground;
      this.vy = 0;
      this.grounded = true;
    }
    if (this.pos[1] < this.spawn[1] - FALL_LIMIT) this.reset();
  }

  /** Puts the body on the ground where it stands. */
  private settle(): void {
    const g = this.floorAt(this.pos[0], this.pos[2]);
    if (g !== null) this.pos[1] = g;
    this.ride(0);
  }
}
