import type { WgifWorld } from '@wgif/format';
import type { NpcAction, NpcModel, NpcObservation } from './types.js';
import { loadDeclaredRulesFallback, loadModelFromWorld, type LoadedModel } from './loader.js';

/**
 * The per-tick NPC hook: the thing the player calls every animation frame.
 * It owns the model, the tick-rate scheduling and the last action; the player
 * owns the scene (positions, marker, ball) and integrates the action's
 * velocity between ticks. This is the Phase One hook for the rebounder NPC;
 * it is purpose-generic — `createNpcHook(world, purpose)` loads whatever the
 * manifest lists first for that purpose.
 *
 * Selection is manifest order by default, or the preferred runtime first
 * when the caller asks (`preferRuntime: 'onnx'`): the loader tries
 * descriptors in that order, and an ONNX model runs through the hand-rolled
 * JS MLP evaluator (no WASM, no onnxruntime-web). An ONNX model that cannot
 * load falls back to its declared same-purpose rules twin, and the hook
 * reports that in `usedFallback` — and if the running ONNX model fails
 * mid-game, the hook swaps to the rules twin and keeps stepping instead of
 * dying: rules are the terminal fallback. The hook never claims general
 * `runtime.onnx` support — the JS MLP is an optional optimization for small
 * MLPs, not a general ONNX runtime (see docs/CAPABILITIES.md).
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
   * observation. A rejected model step from a rules model propagates to the
   * caller (the hook stays usable; the caller decides whether to disable the
   * NPC); a rejected step from an ONNX model swaps to the rules fallback and
   * retries once, so only a failing rules model ever reaches the caller.
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

export interface NpcHookOptions {
  /**
   * Loads the fallback model when the running model fails mid-game. Wired by
   * `createNpcHook` to the world's rules twin; only ever used when the
   * running model is ONNX — rules are the terminal fallback, so a failing
   * rules model still propagates to the caller.
   */
  loadFallback?: () => Promise<LoadedModel>;
}

/**
 * Builds a hook around an already-loaded model. Used by `createNpcHook` and
 * directly by tests with a recording model to assert step timing.
 */
export function createNpcHookFromModel(model: NpcModel, tickHz: number, meta?: Partial<NpcHookMeta>, opts: NpcHookOptions = {}): NpcHook {
  if (!Number.isFinite(tickHz) || tickHz <= 0) {
    throw new Error(`tickHz must be a positive finite number, got ${tickHz}`);
  }
  // The running model can change exactly once: an ONNX model that fails
  // mid-game swaps to its rules twin and stays there (the failed model is
  // not retried, and reset() does not bring it back).
  let current = model;
  let runtime = meta?.runtime ?? model.runtime;
  let usedFallback = meta?.usedFallback ?? false;
  let currentTickHz = tickHz;
  let tickDt = 1 / tickHz;
  const warnings: string[] = [...(meta?.warnings ?? [])];
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
    state: current.state,
    velocity: [0, 0, 0],
    passBall: false,
    holdingBall: false,
    target: obs.ball.position,
  });

  /**
   * One model step, with the ONNX → rules swap. Returns null when a
   * reset/dispose landed mid-swap, so the stale result is never committed.
   */
  const stepOnce = async (obs: NpcObservation, gen: number): Promise<NpcAction | null> => {
    try {
      return await current.update(obs, tickDt);
    } catch (error) {
      if (current.runtime !== 'onnx' || !opts.loadFallback) throw error;
      const fallback = await opts.loadFallback();
      if (gen !== generation) return null;
      warnings.push(
        `onnx model "${current.id}" failed during evaluation (${(error as Error).message}); using fallback rules model "${fallback.model.id}"`,
        ...fallback.warnings,
      );
      current = fallback.model;
      runtime = fallback.runtime;
      usedFallback = true;
      currentTickHz = fallback.tickHz;
      tickDt = 1 / fallback.tickHz;
      return current.update(obs, tickDt);
    }
  };

  return {
    get runtime(): 'rules' | 'onnx' {
      return runtime;
    },
    get usedFallback(): boolean {
      return usedFallback;
    },
    get tickHz(): number {
      return currentTickHz;
    },
    get warnings(): readonly string[] {
      return warnings;
    },
    get state(): string {
      return current.state;
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
          const action = await stepOnce(obs, gen);
          // The hook was reset or disposed while this step was pending: the
          // result is stale, so it is discarded, not committed.
          if (action !== null && gen === generation) {
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
      current.reset();
    },
    dispose(): void {
      generation++;
      disposedFlag = true;
    },
  };
}

/** Loads the best model for a purpose and wraps it in a per-tick hook. */
export async function createNpcHook(world: WgifWorld, purpose = 'rebounder', opts: { preferRuntime?: 'rules' | 'onnx' } = {}): Promise<NpcHook> {
  const loaded = await loadModelFromWorld(world, purpose, opts);
  return createNpcHookFromModel(loaded.model, loaded.tickHz, {
    runtime: loaded.runtime,
    usedFallback: loaded.usedFallback,
    warnings: loaded.warnings,
  }, loaded.runtime === 'onnx' && loaded.model.descriptor.fallback
    ? { loadFallback: async () => loadDeclaredRulesFallback(world, loaded.model.descriptor) }
    : undefined);
}
