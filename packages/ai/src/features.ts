import type { ModelEntry } from '@wgif/format';
import type { NpcObservation, Vec3 } from './types.js';
import { DEFAULT_COURT_BOUNDS } from './types.js';

/**
 * The shared feature contract for the rebounder ONNX model. This is the one
 * place the contract lives: the training script
 * (packages/ai/scripts/train_rebounder_mlp.py), the descriptor
 * (manifest.models[].inputs/outputs) and both evaluators (the JS MLP in
 * src/jsmlp.ts, used by the player, and the ONNX Runtime path in src/onnx.ts,
 * used for Node-side verification) all read it from here. Change it in all
 * four places, never one.
 */

/** Feature order of the ONNX `obs` tensor ([1, 14], float32). */
export const ONNX_OBS_FEATURES = [
  'ball_dx',
  'ball_dz',
  'ball_vx',
  'ball_vz',
  'player_dx',
  'player_dz',
  'home_dx',
  'home_dz',
  'held_by_self',
  'held_by_player',
  'ball_out_of_bounds',
  'dist_to_ball',
  'dist_to_player',
  'dist_to_home',
] as const;

/** `action` tensor ([1, 3], float32): [vx, vz, pass_logit]. Pass fires when pass_logit > 0.5. */
export const ONNX_ACTION_FEATURES = ['vx', 'vz', 'pass_logit'] as const;

export const ONNX_INPUT_NAME = 'obs';
export const ONNX_OUTPUT_NAME = 'action';
export const ONNX_MAX_SPEED = 6;
/** Indices into the obs feature vector, by name — the evaluators read these instead of hardcoding positions. */
export const ONNX_OUT_OF_BOUNDS_IDX = ONNX_OBS_FEATURES.indexOf('ball_out_of_bounds');
export const ONNX_DIST_TO_BALL_IDX = ONNX_OBS_FEATURES.indexOf('dist_to_ball');
/**
 * Pickup reach (m) for the ONNX evaluators' pickup decision, matching the
 * rules model's default (rules.ts). The loader passes the rules twin's
 * `pickupRadius` when the world has one; this is the no-twin default.
 */
export const ONNX_PICKUP_RADIUS_M = 0.45;
/**
 * Speed dead-zone (m/s). The network's output noise floor is ~0.1-0.4 m/s, so
 * below this the NPC is effectively stationary — the same idea as the rules
 * model's arrive radius, which outputs exactly 0 near a target. The slowest
 * real command is the 1.5 m/s return-home walk, so the dead-zone never kills
 * a genuine movement.
 */
export const ONNX_DEAD_ZONE_MS = 0.4;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Builds the [1, 14] feature vector for an observation. Pure and deterministic. */
export function observationToFeatures(obs: NpcObservation, home: Vec3, bounds = DEFAULT_COURT_BOUNDS): Float32Array {
  const [sx, , sz] = obs.self.position;
  const ballOut =
    obs.ball.position[0] < bounds.min[0] ||
    obs.ball.position[0] > bounds.max[0] ||
    obs.ball.position[2] < bounds.min[2] ||
    obs.ball.position[2] > bounds.max[2];
  const dist = Math.hypot(obs.ball.position[0] - sx, obs.ball.position[1] - obs.self.position[1], obs.ball.position[2] - sz);
  const distPlayer = Math.hypot(
    obs.player.position[0] - sx,
    obs.player.position[1] - obs.self.position[1],
    obs.player.position[2] - sz,
  );
  const distHome = Math.hypot(home[0] - sx, home[1] - obs.self.position[1], home[2] - sz);
  return new Float32Array([
    clamp(obs.ball.position[0] - sx, -20, 20),
    clamp(obs.ball.position[2] - sz, -20, 20),
    clamp(obs.ball.velocity[0], -ONNX_MAX_SPEED, ONNX_MAX_SPEED),
    clamp(obs.ball.velocity[2], -ONNX_MAX_SPEED, ONNX_MAX_SPEED),
    clamp(obs.player.position[0] - sx, -20, 20),
    clamp(obs.player.position[2] - sz, -20, 20),
    clamp(home[0] - sx, -20, 20),
    clamp(home[2] - sz, -20, 20),
    obs.ball.heldBy === 'rebounder' ? 1 : 0,
    obs.ball.heldBy === 'player' ? 1 : 0,
    ballOut ? 1 : 0,
    clamp(dist, 0, 20),
    clamp(distPlayer, 0, 20),
    clamp(distHome, 0, 20),
  ]);
}

export class ModelSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSignatureError';
  }
}

/**
 * The descriptor must promise exactly the signature the evaluators run: one
 * `obs` input ([1, 14], float32) and one `action` output ([1, 3], float32).
 * Anything else is a different model, not this NPC — fail closed at load
 * instead of feeding a shape the model never promised. Callers wrap the
 * error in their own type (OnnxModelError / JsMlpError).
 */
export function assertOnnxSignature(descriptor: ModelEntry): void {
  const suffix = 'this evaluator runs obs [1, 14] float32 -> action [1, 3] float32';
  const input = descriptor.inputs?.find((f) => f.name === ONNX_INPUT_NAME);
  if (!input) throw new ModelSignatureError(`onnx model "${descriptor.id}" declares no "${ONNX_INPUT_NAME}" input; ${suffix}`);
  if (input.dtype !== 'float32' || input.shape?.length !== 2 || input.shape[0] !== 1 || input.shape[1] !== ONNX_OBS_FEATURES.length)
    throw new ModelSignatureError(
      `onnx model "${descriptor.id}" declares "${ONNX_INPUT_NAME}" as ${input.dtype ?? 'untyped'} [${input.shape?.join(', ') ?? '?'}]; ${suffix}`,
    );
  const output = descriptor.outputs?.find((f) => f.name === ONNX_OUTPUT_NAME);
  if (!output) throw new ModelSignatureError(`onnx model "${descriptor.id}" declares no "${ONNX_OUTPUT_NAME}" output; ${suffix}`);
  if (output.dtype !== 'float32' || output.shape?.length !== 2 || output.shape[0] !== 1 || output.shape[1] !== ONNX_ACTION_FEATURES.length)
    throw new ModelSignatureError(
      `onnx model "${descriptor.id}" declares "${ONNX_OUTPUT_NAME}" as ${output.dtype ?? 'untyped'} [${output.shape?.join(', ') ?? '?'}]; ${suffix}`,
    );
}
