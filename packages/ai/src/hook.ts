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
 */
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
  /** The most recent model action, or null before the first model step. */
  readonly lastAction: NpcAction | null;
  /**
   * Advances the NPC by `dt` frame seconds with the current observation.
   * Steps the model at most `MAX_STEPS_PER_TICK` times per call (3), so a
   * long frame can never spiral into catch-up steps. Returns the current
   * action — the latest model output, or a zero-velocity idle action before
   * the first step — so the player always has a velocity to integrate.
   * Steps within one call share the frame's observation.
   */
  tick(dt: number, obs: NpcObservation): Promise<NpcAction>;
  /** Clears the accumulator and the last action, and resets the model. */
  reset(): void;
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
    async tick(dt: number, obs: NpcObservation): Promise<NpcAction> {
      if (!Number.isFinite(dt) || dt < 0) {
        throw new Error(`tick dt must be a finite number >= 0, got ${dt}`);
      }
      acc += dt;
      let steps = 0;
      while (acc >= tickDt && steps < MAX_STEPS_PER_TICK) {
        // A model step is already running: keep the last action and let the
        // pending step run on the next call instead of overlapping updates.
        if (inFlight) break;
        acc -= tickDt;
        steps++;
        inFlight = true;
        try {
          lastAction = await model.update(obs, tickDt);
        } finally {
          inFlight = false;
        }
      }
      // The per-call step cap was hit: drop the leftover time instead of
      // carrying it into the next call, so a long frame cannot spiral.
      if (steps >= MAX_STEPS_PER_TICK && acc >= tickDt) acc = 0;
      return (
        lastAction ?? {
          state: model.state,
          velocity: [0, 0, 0],
          passBall: false,
          holdingBall: false,
          target: obs.ball.position,
        }
      );
    },
    reset(): void {
      acc = 0;
      lastAction = null;
      model.reset();
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
