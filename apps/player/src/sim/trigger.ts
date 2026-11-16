import type { Vec3 } from './vec.js';

export interface CylinderShape {
  /** Centre of the cylinder. Its axis is vertical (+Y). */
  center: Vec3;
  radius: number;
  height: number;
}

/**
 * A vertical cylinder trigger with `enterFromAbove` semantics, as used by hoop rims.
 *
 * The event fires when the target's centre comes in through the top face and goes on out through
 * the bottom face. Coming in from below, clipping the side, or dipping in and popping back out
 * (an in-and-out) does not count. Feed it every motion segment of the target; segments may be
 * longer than the cylinder is tall.
 */
export class CylinderTrigger {
  private armed = false;

  constructor(readonly id: string, readonly shape: CylinderShape) {}

  private inside = false;

  /** Forgets any pass in progress. `at`, when given, is where the target now is (so `enters` does not fire for an object placed inside). */
  reset(at?: Vec3): void {
    this.armed = false;
    this.inside = at ? this.contains(at) : false;
  }

  /** Is the point inside the cylinder (faces included)? */
  contains(p: Vec3): boolean {
    const { center, radius, height } = this.shape;
    const dx = p[0] - center[0], dz = p[2] - center[2];
    return Math.abs(p[1] - center[1]) <= height / 2 && dx * dx + dz * dz <= radius * radius;
  }

  /**
   * `enter` semantics: returns true when the segment prev → cur goes into the cylinder from
   * outside, through any face. Staying inside does not fire again; leaving re-arms it. A segment
   * that passes right through the volume within one step still counts.
   */
  enters(prev: Vec3, cur: Vec3): boolean {
    const was = this.inside;
    this.inside = this.contains(cur);
    return !was && this.segmentHits(prev, cur);
  }

  /** Does the segment prev → cur touch the cylinder's volume anywhere? */
  private segmentHits(prev: Vec3, cur: Vec3): boolean {
    const { center, radius, height } = this.shape;
    const top = center[1] + height / 2, bottom = center[1] - height / 2;
    const dy = cur[1] - prev[1];
    let t0 = 0, t1 = 1;
    if (Math.abs(dy) < 1e-12) {
      if (prev[1] < bottom || prev[1] > top) return false;
    } else {
      const ta = (bottom - prev[1]) / dy, tb = (top - prev[1]) / dy;
      t0 = Math.max(0, Math.min(ta, tb));
      t1 = Math.min(1, Math.max(ta, tb));
      if (t0 > t1) return false;
    }
    const ax = prev[0] - center[0], az = prev[2] - center[2];
    const dx = cur[0] - prev[0], dz = cur[2] - prev[2];
    const dd = dx * dx + dz * dz;
    const t = dd < 1e-12 ? t0 : Math.min(t1, Math.max(t0, -(ax * dx + az * dz) / dd));
    const px = ax + dx * t, pz = az + dz * t;
    return px * px + pz * pz <= radius * radius;
  }

  /** True while the target is inside after entering from above. */
  get entered(): boolean {
    return this.armed;
  }

  /** Returns true when the segment prev → cur completes a top-to-bottom pass. */
  sweep(prev: Vec3, cur: Vec3): boolean {
    const { center, radius, height } = this.shape;
    const top = center[1] + height / 2;
    const bottom = center[1] - height / 2;
    if (prev[1] > top && cur[1] <= top) this.armed = this.within(prev, cur, top);
    if (!this.armed) return false;
    if (cur[1] > top) {
      this.armed = false;
    } else if (prev[1] > bottom && cur[1] <= bottom) {
      this.armed = false;
      return this.within(prev, cur, bottom);
    } else {
      const dx = cur[0] - center[0], dz = cur[2] - center[2];
      if (dx * dx + dz * dz > radius * radius) this.armed = false;
    }
    return false;
  }

  /** Is the point where the segment crosses height y inside the cylinder's radius? */
  private within(prev: Vec3, cur: Vec3, y: number): boolean {
    const t = (prev[1] - y) / (prev[1] - cur[1]);
    const dx = prev[0] + (cur[0] - prev[0]) * t - this.shape.center[0];
    const dz = prev[2] + (cur[2] - prev[2]) * t - this.shape.center[2];
    return dx * dx + dz * dz <= this.shape.radius * this.shape.radius;
  }
}
