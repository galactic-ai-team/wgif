import { GRAVITY } from './ball.js';
import { LAYER_SOLID, newContact, newRayHit, type StaticColliders } from './colliders.js';
import { clamp, cross, type Vec3 } from './vec.js';

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface WalkerOptions {
  /** Eye height above the feet (interactions.json `camera.firstPersonHeight`). */
  eyeHeight?: number;
  radius?: number;
  /** Ledges up to this height are stepped onto. Anything taller is a wall. */
  stepHeight?: number;
  walkSpeed?: number;
  runSpeed?: number;
  /** Play area (interactions.json `camera.bounds`). Only X and Z are enforced. */
  bounds?: Bounds | null;
}

/** Movement for one step. `forward` and `right` are analog, -1..1, so a touch stick can walk slowly. */
export interface MoveInput {
  forward: number;
  right: number;
  run: boolean;
}

const MAX_PITCH = 1.45;
/** While walking, drops up to this height are followed without falling (stairs, kerbs). */
const SNAP_DOWN = 0.35;
const FALL_LIMIT = 30;

const contact = newContact();
const ray = newRayHit();

/**
 * First-person character controller: a vertical capsule that slides along walls, steps up small
 * ledges, follows the ground and falls off edges. Yaw and pitch follow three.js camera conventions
 * (yaw 0 looks down -Z, positive yaw turns left, positive pitch looks up).
 */
export class Walker {
  readonly feet: Vec3 = [0, 0, 0];
  yaw = 0;
  pitch = 0;
  vy = 0;
  grounded = false;
  readonly eyeHeight: number;
  readonly radius: number;
  readonly stepHeight: number;
  readonly walkSpeed: number;
  readonly runSpeed: number;
  bounds: Bounds | null;
  private readonly safe: Vec3 = [0, 0, 0];

  constructor(private readonly world: StaticColliders, opts: WalkerOptions = {}) {
    this.eyeHeight = opts.eyeHeight ?? 1.7;
    this.radius = opts.radius ?? 0.3;
    this.stepHeight = opts.stepHeight ?? 0.4;
    this.walkSpeed = opts.walkSpeed ?? 4;
    this.runSpeed = opts.runSpeed ?? 8;
    this.bounds = opts.bounds ?? null;
  }

  get eye(): Vec3 {
    return this.eyeInto([0, 0, 0]);
  }

  /** Unit view direction, including pitch. */
  get forward(): Vec3 {
    return this.forwardInto([0, 0, 0]);
  }

  get right(): Vec3 {
    return this.rightInto([0, 0, 0]);
  }

  get up(): Vec3 {
    return cross(this.right, this.forward);
  }

  // The *Into forms write into a vector the caller owns, for code that runs every frame.
  eyeInto(out: Vec3): Vec3 {
    out[0] = this.feet[0]; out[1] = this.feet[1] + this.eyeHeight; out[2] = this.feet[2];
    return out;
  }

  forwardInto(out: Vec3): Vec3 {
    const c = Math.cos(this.pitch);
    out[0] = -Math.sin(this.yaw) * c; out[1] = Math.sin(this.pitch); out[2] = -Math.cos(this.yaw) * c;
    return out;
  }

  rightInto(out: Vec3): Vec3 {
    out[0] = Math.cos(this.yaw); out[1] = 0; out[2] = -Math.sin(this.yaw);
    return out;
  }

  /** Up relative to the view, right × forward, which works out to (sin yaw · sin pitch, cos pitch, cos yaw · sin pitch). */
  upInto(out: Vec3): Vec3 {
    const sp = Math.sin(this.pitch);
    out[0] = Math.sin(this.yaw) * sp; out[1] = Math.cos(this.pitch); out[2] = Math.cos(this.yaw) * sp;
    return out;
  }

  /** Places the walker with its eye at `eye`, then drops it onto the ground below. */
  spawn(eye: Vec3, lookAt?: Vec3): void {
    this.feet[0] = eye[0]; this.feet[1] = eye[1] - this.eyeHeight; this.feet[2] = eye[2];
    this.vy = 0;
    this.grounded = true;
    if (lookAt) this.lookAt(lookAt);
    this.settle(0);
    this.safe[0] = this.feet[0]; this.safe[1] = this.feet[1]; this.safe[2] = this.feet[2];
  }

  look(dYaw: number, dPitch: number): void {
    this.yaw = (this.yaw + dYaw) % (Math.PI * 2);
    this.pitch = clamp(this.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
  }

  lookAt(target: Vec3): void {
    const eye = this.eye;
    const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
    if (Math.hypot(dx, dz) > 1e-6) this.yaw = Math.atan2(-dx, -dz);
    this.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -MAX_PITCH, MAX_PITCH);
  }

  step(dt: number, input: MoveInput): void {
    let f = clamp(input.forward, -1, 1), s = clamp(input.right, -1, 1);
    const m = Math.hypot(f, s);
    if (m > 1) { f /= m; s /= m; }
    const speed = (input.run ? this.runSpeed : this.walkSpeed) * dt;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const dx = (-sin * f + cos * s) * speed, dz = (-cos * f - sin * s) * speed;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (this.radius * 0.5)));
    for (let i = 0; i < steps; i++) {
      this.feet[0] += dx / steps;
      this.feet[2] += dz / steps;
      this.pushOut();
    }
    if (this.bounds) {
      this.feet[0] = clamp(this.feet[0], this.bounds.min[0], this.bounds.max[0]);
      this.feet[2] = clamp(this.feet[2], this.bounds.min[2], this.bounds.max[2]);
    }
    this.settle(dt);
  }

  /** Slides the capsule out of walls. Only moves horizontally; the ground is handled by settle(). */
  private pushOut(): void {
    const r = this.radius;
    const lo = this.feet[1] + this.stepHeight + r;
    const hi = Math.max(lo, this.feet[1] + this.eyeHeight + 0.1 - r);
    const levels = Math.max(1, Math.ceil((hi - lo) / r) + 1);
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (let i = 0; i < levels; i++) {
        const y = levels === 1 ? lo : lo + ((hi - lo) * i) / (levels - 1);
        if (!this.world.closest(this.feet[0], y, this.feet[2], r, LAYER_SOLID, contact)) continue;
        const ox = this.feet[0] - contact.x, oz = this.feet[2] - contact.z;
        const flat = Math.hypot(ox, oz);
        if (flat < 1e-6) continue; // directly above or below: a floor or a ceiling, not a wall
        const dy = y - contact.y;
        const need = Math.sqrt(Math.max(0, r * r - dy * dy)) - flat;
        if (need > 1e-6) {
          this.feet[0] += (ox / flat) * need;
          this.feet[2] += (oz / flat) * need;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /** Follows the ground: step up, snap down small drops, otherwise fall. */
  private settle(dt: number): void {
    if (this.world.triangleCount === 0) {
      // A world without colliders is one flat floor at spawn height.
      this.grounded = true;
      this.vy = 0;
      return;
    }
    const reach = this.stepHeight + (this.grounded ? SNAP_DOWN : 0) + Math.max(0, -this.vy * dt) + 0.02;
    const hit = this.world.raycast(this.feet[0], this.feet[1] + this.stepHeight, this.feet[2], 0, -1, 0, reach, LAYER_SOLID, ray) && ray.ny > 0.3;
    if (hit && (this.grounded || this.feet[1] <= ray.y)) {
      this.feet[1] = ray.y;
      this.vy = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
      this.vy -= GRAVITY * dt;
      this.feet[1] += this.vy * dt;
      if (hit && this.feet[1] <= ray.y) {
        this.feet[1] = ray.y;
        this.vy = 0;
        this.grounded = true;
      }
    }
    if (this.grounded) {
      this.safe[0] = this.feet[0]; this.safe[1] = this.feet[1]; this.safe[2] = this.feet[2];
    } else if (this.feet[1] < this.world.min[1] - FALL_LIMIT) {
      // Fell out of the world: go back to the last place we stood.
      this.feet[0] = this.safe[0]; this.feet[1] = this.safe[1]; this.feet[2] = this.safe[2];
      this.vy = 0;
      this.grounded = true;
    }
  }
}
