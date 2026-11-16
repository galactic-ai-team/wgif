import type { WgifWorld } from '@wgif/format';
import type { NpcAction, NpcModel, NpcObservation } from './types.js';
import { loadModelFromWorld } from './loader.js';

/**
 * The per-tick NPC hook: the thing the player calls every animation frame.
 * It owns the model, the tick-rate scheduling and the last action; the player
 * owns the scene (positions, marker, ball) and integrates the action's
 * velocity between ticks. This is the Phase One hook for the rebounder NPC;
 * it is purpose-generic — `createNpcHook(world, purpose)` loads whatever the
 * manifest lists first for that purpose.
 *
 * Selection is rules-first by manifest order: the loader tries descriptors in
 * manifest order, and an ONNX model runs through the hand-rolled JS MLP
 * evaluator (no WASM, no onnxruntime-web). An ONNX model that cannot load
 * falls back to its declared same-purpose rules twin, and the hook reports
 * that in `usedFallback`. The hook never claims general `runtime.onnx`
 * support — the JS MLP is an optional optimization for small MLPs, not a
 * general ONNX runtime (see docs/CAPABILITIES.md).
 *
 * Lifecycle: movement velocity is persistent (the player integrates the last
 * action's velocity every frame), but gameplay events are one-shot — they
 * are fresh only on a tick where the model actually stepped, which is what
 * `TickResult.stepped` / `step` say. A model update that is still pending
 * when the hook is reset or disposed resolves into nothing: its result is
 * discarded, so a detached or reset NPC can never be moved by a stale step.
 */
export interface TickResult {
  /** The action to integrate this frame. Velocity is persistent: it stays the last model output between steps. */
  action: NpcAction;
  /** True only when the model stepped during this tick() call. One-shot gameplay events (passBall) are fresh only then — a stale action must never be re-applied as a new event. */
  stepped: boolean;
  /** Monotonically increasing count of committed model steps (restarts at 0 after reset). */
  step: number;
}

export interface NpcHook {
  /** The runtime actually driving the NPC ('rules' or 'onnx'). */
  readonly runtime: 'rules' | 'onnx';
  /** True when the requested model could not run and its declared fallback is in use. */
  readonly usedFallback: boolean;
  /** Tick rate of the model that is actually running (descriptor tickHz, default 10). */
  readonly tickHz: number;
  /** Non-fatal load notes (e.g. an ONNX model that fell back to rules). */
  readonly warnings: readonly string[];
  /** The model's display-only state (e.g. 'chase', 'carry'). */
  readonly state: string;
  /** The most recent model action, or null before the first committed step. */
  readonly lastAction: NpcAction | null;
  /** Count of committed model steps (restarts at 0 after reset). */
  readonly step: number;
  /**
   * Advances the NPC by `dt` frame seconds with the current observation.
   * Steps the model at most `MAX_STEPS_PER_TICK` times per call (3), so a
   * long frame can never spiral into catch-up steps. Returns the current
   * action plus whether a step was committed (`stepped`) and the step
   * sequence number (`step`), so the caller can tell a fresh gameplay event
   * from a repeated stale action. Steps within one call share the frame's
   * observation. A rejected model step propagates to the caller (the hook
   * stays usable; the caller decides whether to disable the NPC).
   */
  tick(dt: number, obs: NpcObservation): Promise<TickResult>;
  /** Clears the accumulator and the last action, restarts the step sequence, and resets the model. A model step pending at reset time resolves into nothing. */
  reset(): void;
  /** Invalidates pending model steps and stops the hook stepping. tick() after dispose returns the last action with stepped: false and never steps the model again. */
  dispose(): void;
}

/** Maximum model steps per tick() call — bounds catch-up after a long frame. */
export const MAX_STEPS_PER_TICK = 3;

export interface NpcHookMeta {
  runtime: 'rules' | 'onnx';
  usedFallback: boolean;
  warnings: readonly string[];
}

/**
 * Builds a hook around an already-loaded model. Used by `createNpcHook` and
 * directly by tests with a recording model to assert step timing.
 */
export function createNpcHookFromModel(model: NpcModel, tickHz: number, meta?: Partial<NpcHookMeta>): NpcHook {
  if (!Number.isFinite(tickHz) || tickHz <= 0) {
    throw new Error(`tickHz must be a positive finite number, got ${tickHz}`);
  }
  const runtime = meta?.runtime ?? model.runtime;
  const usedFallback = meta?.usedFallback ?? false;
  const warnings = meta?.warnings ?? [];
  const tickDt = 1 / tickHz;
  let acc = 0;
  let inFlight = false;
  let lastAction: NpcAction | null = null;
  let stepCount = 0;
  // Generation: bumped by reset()/dispose(). A model step captures the
  // generation before it awaits, and only commits its result if the
  // generation is unchanged — so a step that resolves after a reset or a
  // dispose can never move a detached or reset NPC.
  let generation = 0;
  let disposedFlag = false;

  const idleAction = (obs: NpcObservation): NpcAction => ({
    state: model.state,
    velocity: [0, 0, 0],
    passBall: false,
    holdingBall: false,
    target: obs.ball.position,
  });

  return {
    runtime,
    usedFallback,
    tickHz,
    warnings,
    get state(): string {
      return model.state;
    },
    get lastAction(): NpcAction | null {
      return lastAction;
    },
    get step(): number {
      return stepCount;
    },
    async tick(dt: number, obs: NpcObservation): Promise<TickResult> {
      if (!Number.isFinite(dt) || dt < 0) {
        throw new Error(`tick dt must be a finite number >= 0, got ${dt}`);
      }
      // A disposed hook never steps again; it keeps reporting the last action.
      if (disposedFlag) {
        return { action: lastAction ?? idleAction(obs), stepped: false, step: stepCount };
      }
      acc += dt;
      let steps = 0;
      let committed = 0;
      while (acc >= tickDt && steps < MAX_STEPS_PER_TICK) {
        // A model step is already running: keep the last action and let the
        // pending step run on the next call instead of overlapping updates.
        if (inFlight) break;
        if (disposedFlag) break;
        acc -= tickDt;
        steps++;
        const gen = generation;
        inFlight = true;
        try {
          const action = await model.update(obs, tickDt);
          // The hook was reset or disposed while this step was pending: the
          // result is stale, so it is discarded, not committed.
          if (gen === generation) {
            lastAction = action;
            stepCount++;
            committed++;
          }
        } finally {
          inFlight = false;
        }
      }
      // The per-call step cap was hit: drop the leftover time instead of
      // carrying it into the next call, so a long frame cannot spiral.
      if (steps >= MAX_STEPS_PER_TICK && acc >= tickDt) acc = 0;
      return { action: lastAction ?? idleAction(obs), stepped: committed > 0, step: stepCount };
    },
    reset(): void {
      generation++;
      acc = 0;
      lastAction = null;
      stepCount = 0;
      model.reset();
    },
    dispose(): void {
      generation++;
      disposedFlag = true;
    },
  };
}

/** Loads the best model for a purpose and wraps it in a per-tick hook. */
export async function createNpcHook(world: WgifWorld, purpose = 'rebounder'): Promise<NpcHook> {
  const loaded = await loadModelFromWorld(world, purpose);
  return createNpcHookFromModel(loaded.model, loaded.tickHz, {
    runtime: loaded.runtime,
    usedFallback: loaded.usedFallback,
    warnings: loaded.warnings,
  });
}
