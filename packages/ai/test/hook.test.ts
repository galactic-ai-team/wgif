import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packWgif, unpackWgif, utf8, type ModelEntry, type WgifFiles } from '@wgif/format';
import {
  createNpcHook,
  createNpcHookFromModel,
  DEFAULT_COURT_BOUNDS,
  DEFAULT_HOME,
  loadRulesModel,
  MAX_STEPS_PER_TICK,
  type BallObservation,
  type LoadedModel,
  type NpcAction,
  type NpcModel,
  type NpcObservation,
  type Vec3,
} from '../src/index.js';

const courtWgifPath = fileURLToPath(new URL('../../../examples/court/court.wgif', import.meta.url));
const courtBytes = new Uint8Array(readFileSync(courtWgifPath));

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

  it('swaps a failing onnx model to the rules twin and keeps stepping', async () => {
    const throwing: NpcModel = {
      id: 'throwing-onnx',
      runtime: 'onnx',
      state: 'idle',
      descriptor: onnxDescriptor,
      async update(): Promise<NpcAction> {
        throw new Error('onnx eval exploded');
      },
      reset() {},
    };
    const fallback: LoadedModel = {
      model: loadRulesModel(rulesDescriptor, rulesBytes),
      runtime: 'rules',
      usedFallback: true,
      tickHz: 10,
      warnings: [],
    };
    const hook = createNpcHookFromModel(throwing, 10, { runtime: 'onnx' }, { loadFallback: async () => fallback });
    expect(hook.runtime).toBe('onnx');
    expect(hook.usedFallback).toBe(false);
    const result = await hook.tick(0.1, obs());
    expect(result.stepped).toBe(true);
    expect(result.step).toBe(1);
    expect(result.action.state).toBe('chase');
    expect(hook.runtime).toBe('rules');
    expect(hook.usedFallback).toBe(true);
    expect(hook.warnings.join(' ')).toMatch(/failed during evaluation/);
    // The swap sticks: the next step runs on rules, with no second swap.
    const next = await hook.tick(0.1, obs());
    expect(next.stepped).toBe(true);
    expect(next.step).toBe(2);
    expect(hook.runtime).toBe('rules');
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

  it('loads the onnx model first on a rules-first world when preferred', async () => {
    const { manifest, files } = worldFiles([rulesDescriptor, onnxDescriptor]);
    const hook = await createNpcHook(await unpackWgif(await packWgif(manifest, files)), 'rebounder', { preferRuntime: 'onnx' });
    expect(hook.runtime).toBe('onnx');
    expect(hook.usedFallback).toBe(false);
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

/**
 * Missed shot → fetch → pass, end to end through the hook, with player-style
 * integration (mirroring apps/player/src/ai.ts): the caller integrates the
 * persistent velocity, moves the ball while it is held, and applies the
 * one-shot pass only on a fresh stepped tick. The rules NPC already does
 * this — this test locks the requested behaviour in, so a regression in the
 * rules, the hook or the player wiring fails here first.
 */
describe('rebounder: missed shot → fetch → pass (end to end through the hook)', () => {
  const PLAYER: Vec3 = [0, 0, 9.5];
  const CARRY_HEIGHT = 0.9;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const dist2d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

  function makeRunner(hook: Awaited<ReturnType<typeof createNpcHook>>) {
    let selfPos: Vec3 = [...DEFAULT_HOME];
    let ballPos: Vec3 = [9, 0.12, 1.2];
    let heldBy: 'player' | 'rebounder' | null = null;
    let timeSec = 0;
    let passEvents = 0;
    const states: string[] = [];
    return {
      get selfPos() {
        return selfPos;
      },
      get ballPos() {
        return ballPos;
      },
      get heldBy() {
        return heldBy;
      },
      get passEvents() {
        return passEvents;
      },
      get states() {
        return states;
      },
      setBallLoose(at: Vec3) {
        ballPos = [...at];
        heldBy = null;
      },
      async step() {
        timeSec += 0.1;
        const result = await hook.tick(0.1, {
          timeSec,
          ball: { position: ballPos, velocity: [0, 0, 0], heldBy },
          player: { position: PLAYER },
          self: { position: selfPos },
        });
        const a = result.action;
        if (states[states.length - 1] !== a.state) states.push(a.state);
        selfPos = [
          clamp(selfPos[0] + a.velocity[0] * 0.1, DEFAULT_COURT_BOUNDS.min[0], DEFAULT_COURT_BOUNDS.max[0]),
          0,
          clamp(selfPos[2] + a.velocity[2] * 0.1, DEFAULT_COURT_BOUNDS.min[2], DEFAULT_COURT_BOUNDS.max[2]),
        ];
        if (a.holdingBall) {
          heldBy = 'rebounder';
          ballPos = [selfPos[0], CARRY_HEIGHT, selfPos[2]];
        }
        // One-shot event, only on a fresh step.
        if (result.stepped && a.passBall) {
          passEvents++;
          heldBy = 'player';
          ballPos = [PLAYER[0], CARRY_HEIGHT, PLAYER[2]];
        }
        return result;
      },
      /** Steps until a fresh pass fires (or the tick budget runs out). */
      async runUntilPass(maxTicks: number): Promise<number> {
        const before = passEvents;
        for (let t = 0; t < maxTicks; t++) {
          await this.step();
          if (passEvents > before) return t + 1;
        }
        return -1;
      },
    };
  }

  function expectStatesInOrder(states: string[], wanted: string[]) {
    // The runner records consecutive distinct states; filter to the wanted
    // ones and require exactly that order, with nothing extra in between.
    expect(states.filter((s) => wanted.includes(s))).toEqual(wanted);
  }

  it('walks to the ball after a missed shot and passes it back — twice', async () => {
    const hook = await createNpcHook(await unpackWgif(courtBytes), 'rebounder');
    expect(hook.runtime).toBe('rules');
    const run = makeRunner(hook);

    // The opening loose ball: the first fetch, proving the loop from spawn.
    const states0 = run.states.length;
    const openingTicks = await run.runUntilPass(200);
    expect(openingTicks).toBeGreaterThan(0);
    expect(run.passEvents).toBe(1);
    expect(run.heldBy).toBe('player');
    expect(run.ballPos).toEqual([PLAYER[0], CARRY_HEIGHT, PLAYER[2]]);
    expectStatesInOrder(run.states.slice(states0), ['chase', 'pickup', 'carry', 'pass']);

    // The NPC walks home after the pass; the pass must not re-fire while the
    // player holds the ball.
    for (let i = 0; i < 60; i++) await run.step();
    expect(run.passEvents).toBe(1);
    expect(hook.state).toBe('idle');
    expect(dist2d(run.selfPos, DEFAULT_HOME)).toBeLessThan(0.5);

    // Missed shot 1: the player shoots toward the home rim and misses; the
    // ball lands loose on the floor near the rim, in bounds.
    run.setBallLoose([11, 0.12, 2.5]);
    const states1 = run.states.length;
    const miss1Ticks = await run.runUntilPass(200);
    expect(miss1Ticks).toBeGreaterThan(0);
    expect(run.passEvents).toBe(2);
    expect(run.heldBy).toBe('player');
    expectStatesInOrder(run.states.slice(states1), ['chase', 'pickup', 'carry', 'pass']);
    for (let i = 0; i < 60; i++) await run.step();
    expect(run.passEvents).toBe(2);
    expect(hook.state).toBe('idle');

    // Missed shot 2: a long miss into the far corner — the longest walk.
    run.setBallLoose([-13, 0.12, -7]);
    const states2 = run.states.length;
    const miss2Ticks = await run.runUntilPass(400);
    expect(miss2Ticks).toBeGreaterThan(0);
    expect(run.passEvents).toBe(3);
    expect(run.heldBy).toBe('player');
    expectStatesInOrder(run.states.slice(states2), ['chase', 'pickup', 'carry', 'pass']);
  });
});
