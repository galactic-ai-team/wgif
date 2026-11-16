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

  reset(): void {
    this.armed = false;
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
