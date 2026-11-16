import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packWgif, unpackWgif, utf8, type ModelEntry, type WgifFiles } from '@wgif/format';
import {
  createNpcHook,
  createNpcHookFromModel,
  MAX_STEPS_PER_TICK,
  type BallObservation,
  type NpcAction,
  type NpcModel,
  type NpcObservation,
  type Vec3,
} from '../src/index.js';

const rulesPath = fileURLToPath(new URL('../../../examples/court/models/rebounder.rules.json', import.meta.url));
const onnxPath = fileURLToPath(new URL('../../../examples/court/models/rebounder-mlp.onnx', import.meta.url));
const rulesBytes = new Uint8Array(readFileSync(rulesPath));
const onnxBytes = new Uint8Array(readFileSync(onnxPath));

const rulesDescriptor: ModelEntry = {
  id: 'rebounder-rules',
  path: 'models/rebounder.rules.json',
  runtime: 'rules',
  purpose: 'rebounder',
  version: '0.1.0',
  tickHz: 10,
  deterministic: true,
  seed: 7,
  license: 'CC-BY-4.0',
};

const onnxDescriptor: ModelEntry = {
  id: 'rebounder-mlp',
  path: 'models/rebounder-mlp.onnx',
  runtime: 'onnx',
  purpose: 'rebounder',
  version: '0.1.0',
  inputs: [{ name: 'obs', shape: [1, 14], dtype: 'float32', description: 'See ONNX_OBS_FEATURES in src/features.ts.' }],
  outputs: [{ name: 'action', shape: [1, 3], dtype: 'float32', description: '[vx, vz, pass_logit].' }],
  tickHz: 10,
  deterministic: true,
  seed: 7,
  license: 'CC-BY-4.0',
  fallback: 'rebounder-rules',
};

function obs(over: { timeSec?: number; ball?: Partial<BallObservation>; player?: { position?: Vec3 }; self?: { position?: Vec3 } } = {}): NpcObservation {
  return {
    timeSec: over.timeSec ?? 0,
    ball: {
      position: over.ball?.position ?? [9, 0.12, 1.2],
      velocity: over.ball?.velocity ?? [0, 0, 0],
      heldBy: over.ball?.heldBy ?? null,
    },
    player: { position: over.player?.position ?? [0, 0, 9.5] },
    self: { position: over.self?.position ?? [0, 0, 6] },
  };
}

/** A recording stand-in for a real model: counts updates, returns a canned action. */
class RecordingModel implements NpcModel {
  readonly id = 'recording';
  readonly runtime: 'rules' | 'onnx' = 'rules';
  readonly descriptor = rulesDescriptor;
  state = 'idle';
  updates = 0;
  resets = 0;
  /** When set, update() waits for this deferred instead of resolving at once. */
  gate: { promise: Promise<NpcAction>; resolve: (a: NpcAction) => void } | null = null;
  /** When set, the next update() throws this error instead of returning. */
  failNext: Error | null = null;

  canned: NpcAction = {
    state: 'chase',
    velocity: [1, 0, 0],
    passBall: false,
    holdingBall: false,
    target: [9, 0, 1.2],
  };

  async update(_obs: NpcObservation, _dt: number): Promise<NpcAction> {
    this.updates++;
    this.state = this.canned.state;
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (this.gate) return this.gate.promise;
    return this.canned;
  }

  reset(): void {
    this.resets++;
    this.state = 'idle';
  }

  defer(): void {
    let resolve!: (a: NpcAction) => void;
    const promise = new Promise<NpcAction>((r) => {
      resolve = r;
    });
    this.gate = { promise, resolve };
  }
}

describe('per-tick npc hook', () => {
  it('steps the model at tickHz and returns the idle action before the first step', async () => {
    const model = new RecordingModel();
    const hook = createNpcHookFromModel(model, 10);
    const before = await hook.tick(0.05, obs());
    expect(before.action.velocity).toEqual([0, 0, 0]);
    expect(before.action.target).toEqual([9, 0.12, 1.2]);
    expect(before.stepped).toBe(false);
    expect(before.step).toBe(0);
    expect(model.updates).toBe(0);
    expect(hook.lastAction).toBeNull();

    // Ten 0.05 s frames = 0.5 s = exactly 5 model steps at 10 Hz.
    for (let i = 0; i < 10; i++) await hook.tick(0.05, obs());
    expect(model.updates).toBe(5);
    expect(hook.lastAction?.state).toBe('chase');
    expect(hook.state).toBe('chase');
    expect(hook.step).toBe(5);
    // A further 0.01 s frame is below one tick: no step, last action kept, not fresh.
    const kept = await hook.tick(0.01, obs());
    expect(model.updates).toBe(5);
    expect(kept.stepped).toBe(false);
    expect(kept.step).toBe(5);
    expect(kept.action).toBe(hook.lastAction);
  });

  it('caps steps per call and drops leftover time so a long frame cannot spiral', async () => {
    const model = new RecordingModel();
    const hook = createNpcHookFromModel(model, 10);
    // One 0.5 s frame would be 5 steps; the hook runs at most MAX_STEPS_PER_TICK.
    const big = await hook.tick(0.5, obs());
    expect(model.updates).toBe(MAX_STEPS_PER_TICK);
    expect(MAX_STEPS_PER_TICK).toBe(3);
    expect(big.stepped).toBe(true);
    expect(big.step).toBe(3);
    // The leftover 0.2 s is dropped, not carried: 0.09 s more is still below a tick.
    await hook.tick(0.09, obs());
    expect(model.updates).toBe(3);
    // And 0.02 s more completes a tick (0.02, not 0.01: 0.09 + 0.01 is a
    // hair under 0.1 in binary floating point, so it would not step).
    const last = await hook.tick(0.02, obs());
    expect(model.updates).toBe(4);
    expect(last.step).toBe(4);
  });

  it('never overlaps model updates: a tick during a running step keeps the last action', async () => {
    const model = new RecordingModel();
    model.defer();
    const hook = createNpcHookFromModel(model, 10);
    const first = hook.tick(0.1, obs());
    // The first step is still in flight; a second tick must not start another.
    const second = await hook.tick(0.1, obs());
    expect(model.updates).toBe(1);
    expect(second.action.velocity).toEqual([0, 0, 0]);
    expect(second.stepped).toBe(false);
    // Resolve the in-flight step, then the pending time runs the next step.
    model.gate!.resolve(model.canned);
    expect((await first).action.state).toBe('chase');
    expect((await first).stepped).toBe(true);
    model.gate = null;
    await hook.tick(0.01, obs());
    expect(model.updates).toBeGreaterThanOrEqual(2);
    expect(hook.lastAction?.state).toBe('chase');
  });

  it('a one-shot passBall is fresh only on a stepped tick, never from a stale action', async () => {
    const model = new RecordingModel();
    model.canned = { ...model.canned, passBall: true };
    const hook = createNpcHookFromModel(model, 10);
    // First step: fresh pass event.
    const fresh = await hook.tick(0.1, obs());
    expect(fresh.stepped).toBe(true);
    expect(fresh.step).toBe(1);
    expect(fresh.action.passBall).toBe(true);
    // No step ran on this frame — the action still carries passBall: true
    // (it is the last action), but stepped is false, so a consumer that
    // applies events only when stepped === true will not re-fire the pass.
    const stale = await hook.tick(0.01, obs());
    expect(stale.stepped).toBe(false);
    expect(stale.step).toBe(1);
    expect(stale.action.passBall).toBe(true);
    expect(model.updates).toBe(1);
  });

  it('a pending update resolving after reset is discarded', async () => {
    const model = new RecordingModel();
    model.defer();
    const hook = createNpcHookFromModel(model, 10);
    const pending = hook.tick(0.1, obs());
    expect(model.updates).toBe(1);
    // Reset while the step is still in flight.
    hook.reset();
    expect(hook.lastAction).toBeNull();
    expect(hook.step).toBe(0);
    model.gate!.resolve(model.canned);
    model.gate = null;
    const result = await pending;
    // The late result was discarded: no committed step, idle action.
    expect(result.stepped).toBe(false);
    expect(result.step).toBe(0);
    expect(result.action.velocity).toEqual([0, 0, 0]);
    expect(hook.lastAction).toBeNull();
    expect(hook.step).toBe(0);
    // The hook is still usable: the next tick steps fresh.
    const next = await hook.tick(0.1, obs());
    expect(next.stepped).toBe(true);
    expect(next.step).toBe(1);
    expect(model.updates).toBe(2);
  });

  it('a pending update resolving after dispose is discarded, and tick after dispose never steps', async () => {
    const model = new RecordingModel();
    model.defer();
    const hook = createNpcHookFromModel(model, 10);
    const pending = hook.tick(0.1, obs());
    hook.dispose();
    model.gate!.resolve(model.canned);
    model.gate = null;
    const result = await pending;
    expect(result.stepped).toBe(false);
    expect(result.step).toBe(0);
    expect(hook.lastAction).toBeNull();
    // tick() after dispose is a no-op: no model step, idle action.
    const after = await hook.tick(0.1, obs());
    expect(after.stepped).toBe(false);
    expect(after.action.velocity).toEqual([0, 0, 0]);
    expect(model.updates).toBe(1);
  });

  it('a rejected model step propagates and the hook stays usable', async () => {
    const model = new RecordingModel();
    model.failNext = new Error('model exploded');
    const hook = createNpcHookFromModel(model, 10);
    await expect(hook.tick(0.1, obs())).rejects.toThrow('model exploded');
    expect(hook.lastAction).toBeNull();
    expect(hook.step).toBe(0);
    // The next tick retries and commits normally.
    const next = await hook.tick(0.1, obs());
    expect(next.stepped).toBe(true);
    expect(next.step).toBe(1);
    expect(hook.lastAction?.state).toBe('chase');
  });

  it('reset clears the accumulator and the last action and resets the model', async () => {
    const model = new RecordingModel();
    const hook = createNpcHookFromModel(model, 10);
    await hook.tick(0.2, obs());
    expect(model.updates).toBe(2);
    hook.reset();
    expect(hook.lastAction).toBeNull();
    expect(hook.state).toBe('idle');
    expect(hook.step).toBe(0);
    expect(model.resets).toBe(1);
    // 0.05 s after a reset is below one tick again.
    await hook.tick(0.05, obs());
    expect(model.updates).toBe(2);
  });

  it('rejects bad dt and bad tickHz', async () => {
    const model = new RecordingModel();
    const hook = createNpcHookFromModel(model, 10);
    await expect(hook.tick(-0.1, obs())).rejects.toThrow(/finite number >= 0/);
    await expect(hook.tick(Number.NaN, obs())).rejects.toThrow(/finite number >= 0/);
    expect(() => createNpcHookFromModel(model, 0)).toThrow(/positive finite/);
    expect(() => createNpcHookFromModel(model, -5)).toThrow(/positive finite/);
  });
});

describe('createNpcHook from a world', () => {
  function worldFiles(models: ModelEntry[], extra: WgifFiles = {}): { manifest: Parameters<typeof packWgif>[0]; files: WgifFiles } {
    return {
      manifest: {
        wgif: '0.1',
        id: 'test.world.hook',
        title: 'Test world with hook',
        creator: { name: 'Galactic AI Team' },
        created: '2026-11-15T00:00:00Z',
        mode: 'editable',
        entry: { scene: 'world.glb', preview: 'preview.png' },
        models,
        requires: ['scene.glb', 'runtime.rules'],
      },
      files: {
        'world.glb': utf8('glTF-fake-binary'),
        'preview.png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        'models/rebounder.rules.json': rulesBytes,
        'models/rebounder-mlp.onnx': onnxBytes,
        ...extra,
      },
    };
  }

  it('loads rules-first when the manifest lists rules first', async () => {
    const { manifest, files } = worldFiles([rulesDescriptor, onnxDescriptor]);
    const hook = await createNpcHook(await unpackWgif(await packWgif(manifest, files)), 'rebounder');
    expect(hook.runtime).toBe('rules');
    expect(hook.usedFallback).toBe(false);
    expect(hook.tickHz).toBe(10);
    const result = await hook.tick(0.1, obs());
    expect(result.stepped).toBe(true);
    expect(result.step).toBe(1);
    expect(result.action.state).toBe('chase');
    expect(hook.lastAction?.state).toBe('chase');
  });

  it('loads the JS MLP when the manifest lists onnx first — no wasm involved', async () => {
    const { manifest, files } = worldFiles([onnxDescriptor, rulesDescriptor]);
    const hook = await createNpcHook(await unpackWgif(await packWgif(manifest, files)), 'rebounder');
    expect(hook.runtime).toBe('onnx');
    expect(hook.usedFallback).toBe(false);
    // The JS MLP agrees with the rules model within a tick: same state here.
    const result = await hook.tick(0.1, obs());
    expect(result.stepped).toBe(true);
    expect(result.action.state).toBe('chase');
  });

  it('falls back to the rules twin through the hook when the onnx file is corrupt', async () => {
    const { manifest, files } = worldFiles([onnxDescriptor, rulesDescriptor], { 'models/rebounder-mlp.onnx': utf8('not an onnx model') });
    const hook = await createNpcHook(await unpackWgif(await packWgif(manifest, files)), 'rebounder');
    expect(hook.runtime).toBe('rules');
    expect(hook.usedFallback).toBe(true);
    expect(hook.warnings.length).toBeGreaterThan(0);
    const result = await hook.tick(0.1, obs());
    expect(result.stepped).toBe(true);
    expect(result.action.state).toBe('chase');
  });

  it('rejects an unknown purpose', async () => {
    const { manifest, files } = worldFiles([rulesDescriptor, onnxDescriptor]);
    await expect(createNpcHook(await unpackWgif(await packWgif(manifest, files)), 'crowd')).rejects.toThrow(/no model/i);
  });
});
