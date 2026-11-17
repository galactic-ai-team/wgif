import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exportWorld } from '../src/exporter.js';
import { parseInteractions } from '../src/interactions.js';
import { StaticColliders } from '../src/sim/colliders.js';
import { DEFAULT_VEHICLE, Vehicle, type DriveInput } from '../src/sim/vehicle.js';
import { open, run } from './helpers.js';

const TICK = 1 / 120;
const GAS: DriveInput = { throttle: 1, steer: 0, brake: false };
const COAST: DriveInput = { throttle: 0, steer: 0, brake: false };

function lot(extra?: (w: StaticColliders) => void): StaticColliders {
  const world = new StaticColliders();
  world.addBox('floor', [-60, -1, -60], [60, 0, 60]);
  extra?.(world);
  return world.build();
}

function drive(v: Vehicle, seconds: number, input: DriveInput): void {
  for (let i = 0; i < Math.round(seconds / TICK); i++) v.step(TICK, input);
}

/** A wedge ramp along -Z: rises from z = zStart to `height` over `length`, then a flat top. */
function ramp(world: StaticColliders, zStart: number, length: number, height: number, top: number): void {
  const x0 = -4, x1 = 4, z1 = zStart - length, z2 = z1 - top;
  // prettier-ignore
  const p = [x0, 0, zStart, x1, 0, zStart, x1, height, z1, x0, height, z1, x1, height, z2, x0, height, z2];
  world.addMesh('ramp', p, [0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5]);
}

describe('vehicle controller', () => {
  it('sits on the ground, accelerates along its heading (yaw 0 = -Z) and tops out at maxSpeed', () => {
    const v = new Vehicle('car', lot(), DEFAULT_VEHICLE, [0, 0.4, 0], 0);
    expect(v.pos[1]).toBeCloseTo(0, 6);
    expect(v.grounded).toBe(true);
    drive(v, 1, GAS);
    expect(v.speed).toBeCloseTo(DEFAULT_VEHICLE.accel, 1);
    expect(v.pos[2]).toBeLessThan(-3);
    expect(Math.abs(v.pos[0])).toBeLessThan(1e-9);
    drive(v, 5, GAS);
    expect(v.speed).toBe(DEFAULT_VEHICLE.maxSpeed);
    expect(v.wheelSpin).toBeGreaterThan(0);
  });

  it('brakes to a stop, then reverses on throttle back, and coasts down with no input', () => {
    const v = new Vehicle('car', lot(), DEFAULT_VEHICLE, [0, 0, 0], 0);
    drive(v, 2, GAS);
    drive(v, 2, { throttle: 0, steer: 0, brake: true });
    expect(v.speed).toBe(0);
    drive(v, 3, { throttle: -1, steer: 0, brake: false });
    expect(v.speed).toBe(-DEFAULT_VEHICLE.reverseSpeed);
    const z = v.pos[2];
    drive(v, 3, COAST);
    expect(v.speed).toBe(0);
    expect(v.pos[2]).toBeGreaterThan(z);
  });

  it('steers right with positive steer (yaw goes down), and turns tighter slowly than at speed', () => {
    const turn = (seconds: number, throttle: number): Vehicle => {
      const v = new Vehicle('car', lot(), DEFAULT_VEHICLE, [0, 0, 0], 0);
      drive(v, seconds, { throttle, steer: 1, brake: false });
      return v;
    };
    const v = turn(1.5, 1);
    expect(v.yaw).toBeLessThan(-0.3);
    expect(v.pos[0]).toBeGreaterThan(0);
    // Standing still, the wheel turns but the car does not.
    const still = new Vehicle('car', lot(), DEFAULT_VEHICLE, [0, 0, 0], 0);
    drive(still, 1, { throttle: 0, steer: 1, brake: true });
    expect(still.yaw).toBe(0);
    expect(still.steer).toBeLessThan(-0.4);
  });

  it('stops at a wall and bounces back a little instead of going through', () => {
    const world = lot((w) => w.addBox('wall', [-10, 0, -12.2], [10, 2, -12]));
    const v = new Vehicle('car', world, DEFAULT_VEHICLE, [0, 0, 0], 0);
    drive(v, 4, GAS);
    expect(v.pos[2]).toBeGreaterThan(-12 + DEFAULT_VEHICLE.length / 2 - 0.2);
    drive(v, 3, GAS);
    expect(v.pos[2]).toBeGreaterThan(-12);
    expect(v.pos[1]).toBeCloseTo(0, 6);
  });

  it('keeps inside the play-area bounds', () => {
    const v = new Vehicle('car', lot(), DEFAULT_VEHICLE, [0, 0, 0], Math.PI / 2, { min: [-10, -5, -10], max: [10, 5, 10] });
    drive(v, 5, GAS);
    expect(v.pos[0]).toBeGreaterThanOrEqual(-10 + DEFAULT_VEHICLE.radius - 1e-9);
    expect(v.bumped || Math.abs(v.speed) < DEFAULT_VEHICLE.maxSpeed).toBe(true);
  });

  it('climbs a ramp, pitching nose up, and never sinks through the floor', () => {
    const world = lot((w) => ramp(w, -6, 8, 1.2, 4));
    const v = new Vehicle('car', world, DEFAULT_VEHICLE, [0, 0, 0], 0);
    let minY = Infinity, maxPitch = 0;
    for (let i = 0; i < 240; i++) {
      v.step(TICK, { throttle: 0.6, steer: 0, brake: false });
      minY = Math.min(minY, v.pos[1]);
      maxPitch = Math.max(maxPitch, v.pitch);
    }
    expect(minY).toBeGreaterThanOrEqual(-1e-6);
    expect(maxPitch).toBeGreaterThan(0.08);
    // Over the top and off the far end: it falls back down to the floor and lands.
    drive(v, 1.5, GAS);
    expect(v.pos[2]).toBeLessThan(-20);
    expect(v.pos[1]).toBeCloseTo(0, 3);
    expect(v.grounded).toBe(true);
  });

  it('falls off the edge of the world and comes back on its spawn', () => {
    const world = new StaticColliders();
    world.addBox('floor', [-5, -1, -5], [5, 0, 5]);
    world.build();
    const v = new Vehicle('car', world, DEFAULT_VEHICLE, [0, 0, 0], 0);
    drive(v, 2, GAS);
    expect(v.grounded).toBe(false);
    drive(v, 4, COAST);
    expect(v.pos).toEqual([0, 0, 0]);
    expect(v.speed).toBe(0);
  });

  it('is deterministic', () => {
    const go = (): number[] => {
      const v = new Vehicle('car', lot((w) => ramp(w, -6, 8, 1.2, 4)), DEFAULT_VEHICLE, [0, 0, 0], 0.3);
      for (let i = 0; i < 600; i++) v.step(TICK, { throttle: 1, steer: Math.sin(i / 50), brake: i % 97 === 0 });
      return [...v.pos, v.yaw, v.speed];
    };
    expect(go()).toEqual(go());
  });
});

describe('vehicle interactions', () => {
  it('reads interactions[] entries of type vehicle, clamps their numbers, and still flags other free-form entries', () => {
    const { interactions, warnings } = parseInteractions({
      version: '0.1',
      interactions: [
        { type: 'vehicle', id: 'car', node: 'car', spawn: [1, 0, 2], yaw: 0.5, drive: { maxSpeed: 999 }, wheels: { front: ['fl', 'fr'], rear: ['rl'] } },
        { type: 'vehicle', node: 'nope' },
        { type: 'door', id: 'd' },
      ],
    });
    expect(interactions.vehicles).toHaveLength(1);
    const car = interactions.vehicles[0]!;
    expect(car).toMatchObject({ id: 'car', node: 'car', spawn: [1, 0, 2], yaw: 0.5, wheels: { front: ['fl', 'fr'], rear: ['rl'], radius: 0.34 } });
    expect(car.drive.maxSpeed).toBe(80);
    expect(car.drive.wheelBase).toBe(2.6);
    expect(warnings.some((w) => w.includes('a vehicle needs an id and a node'))).toBe(true);
    expect(interactions.unsupported).toEqual(['interactions[] (1 free-form entry) has no defined behaviour in v0.1']);
  });
});

describe('car.wgif', () => {
  const bytes = (): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL('../../../examples/worlds/car.wgif', import.meta.url))));

  it('opens with no warnings, the car on its turntable and its own node out of the colliders', async () => {
    const w = await open(bytes());
    expect(w.doc.warnings).toEqual([]);
    expect(w.built.warnings).toEqual([]);
    expect(w.doc.world.manifest.mode).toBe('editable');
    expect(w.built.solid).not.toContain('car');
    const car = w.runtime.vehicles.get('car')!;
    expect(car).toBeTruthy();
    expect(car.pos[1]).toBeCloseTo(0.015, 3); // on the turntable disc
    expect(w.scene.getObjectByName('wheel_fl')).toBeTruthy();
  });

  it('drives: forward moves the car, it stays on the lot, and getting out parks it', async () => {
    const w = await open(bytes());
    const rt = w.runtime;
    expect(rt.drive()?.id).toBe('car');
    const car = rt.driven!;
    rt.driveInput.throttle = 1;
    run(rt, 2);
    expect(car.pos[2]).toBeLessThan(-8);
    // Full throttle with the wheel turned for half a minute: it laps the lot and never leaves it or the floor.
    rt.driveInput.steer = 0.6;
    for (let t = 0; t < 30; t += 0.5) {
      run(rt, 0.5);
      expect(Math.abs(car.pos[0])).toBeLessThan(30);
      expect(Math.abs(car.pos[2])).toBeLessThan(30);
      expect(car.pos[1]).toBeGreaterThan(-0.01);
    }
    rt.drive(null);
    run(rt, 2);
    expect(car.speed).toBe(0);
  });

  it('exports an edited copy that still has its drivable car', async () => {
    const w = await open(bytes());
    const result = await exportWorld(w.doc, { ops: [{ op: 'spawn', position: [8, 1.7, -8], lookAt: [0, 0.7, 0] }], state: w.runtime.snapshot(), at: new Date('2026-11-16T23:00:00Z') });
    expect(result.kind).toBe('edit');
    const again = await open(result.bytes);
    expect(again.doc.warnings).toEqual([]);
    expect(again.doc.world.manifest.spawn?.position).toEqual([8, 1.7, -8]);
    expect(again.runtime.vehicles.get('car')).toBeTruthy();
  });
});
