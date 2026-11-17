import { describe, expect, it } from 'vitest';
import { CylinderTrigger } from '../src/sim/trigger.js';
import type { Vec3 } from '../src/sim/vec.js';

const rim = () => new CylinderTrigger('rim', { center: [12.425, 3.05, 0], radius: 0.225, height: 0.1 });

/** Feeds a polyline through the trigger and counts how often it fires. */
function run(trigger: CylinderTrigger, path: Vec3[]): number {
  let fired = 0;
  for (let i = 1; i < path.length; i++) if (trigger.sweep(path[i - 1]!, path[i]!)) fired++;
  return fired;
}

describe('CylinderTrigger (enterFromAbove)', () => {
  it('fires once when the target drops through, top to bottom', () => {
    const steps: Vec3[] = [];
    for (let y = 3.5; y > 2.6; y -= 0.03) steps.push([12.45, y, 0.02]);
    expect(run(rim(), steps)).toBe(1);
  });

  it('fires for a single segment that crosses both faces', () => {
    expect(run(rim(), [[12.4, 3.4, 0], [12.4, 2.8, 0]])).toBe(1);
  });

  it('does not fire from below, from the side or outside the radius', () => {
    expect(run(rim(), [[12.4, 2.6, 0], [12.4, 3.0, 0], [12.4, 3.4, 0]])).toBe(0);
    expect(run(rim(), [[11.9, 3.05, 0], [12.4, 3.05, 0], [12.9, 3.05, 0]])).toBe(0);
    expect(run(rim(), [[12.9, 3.4, 0], [12.9, 3.0, 0], [12.9, 2.6, 0]])).toBe(0);
    // Comes in from above but outside the ring, then slides under it.
    expect(run(rim(), [[12.9, 3.2, 0], [12.7, 3.05, 0], [12.45, 2.9, 0]])).toBe(0);
  });

  it('does not count an in-and-out', () => {
    const t = rim();
    expect(run(t, [[12.4, 3.2, 0], [12.4, 3.06, 0]])).toBe(0);
    expect(t.entered).toBe(true);
    expect(run(t, [[12.4, 3.06, 0], [12.4, 3.3, 0]])).toBe(0);
    expect(t.entered).toBe(false);
    // Entering, then leaving sideways between the faces.
    expect(run(t, [[12.4, 3.2, 0], [12.4, 3.06, 0], [12.9, 3.04, 0], [12.9, 2.5, 0]])).toBe(0);
  });

  it('can fire again on the next pass and can be reset mid-pass', () => {
    const t = rim();
    const drop: Vec3[] = [[12.4, 3.4, 0], [12.4, 3.06, 0], [12.4, 2.8, 0]];
    expect(run(t, drop)).toBe(1);
    expect(run(t, drop)).toBe(1);
    t.sweep([12.4, 3.4, 0], [12.4, 3.06, 0]);
    t.reset();
    expect(t.sweep([12.4, 3.06, 0], [12.4, 2.8, 0])).toBe(false);
  });
});
