import type { ModelEntry } from '@wgif/format';
import type { NpcAction, NpcModel, NpcObservation, Vec3 } from './types.js';
import { DEFAULT_COURT_BOUNDS, DEFAULT_HOME } from './types.js';
import { validateObservation } from './rules.js';

export class OnnxRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnnxRuntimeUnavailableError';
  }
}

export class OnnxModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnnxModelError';
  }
}

/**
 * Feature order of the ONNX `obs` tensor ([1, 14], float32). This order is the
 * contract between the training script (packages/ai/scripts/train_rebounder_mlp.py),
 * the descriptor (manifest.models[].inputs) and this loader. Change it in all
 * three places, never one. Relative positions are self-relative, meters,
 * clamped to [-20, 20]; velocities are clamped to [-6, 6].
 */
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

interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>;
}

/**
 * The ONNX NPC: a distilled clone of the rules rebounder, trained on synthetic
 * data from the rules policy (see scripts/train_rebounder_mlp.py). It is
 * stateless — the held flags in the observation carry the state — and fully
 * on-device: ONNX Runtime Web, WASM, CPU, one thread (deterministic).
 *
 * The runtime is an *optional* dependency: onnxruntime-web is a devDependency
 * of @wgif/ai and is loaded lazily, only when an onnx model is actually used.
 * If it cannot be loaded, load() throws OnnxRuntimeUnavailableError and the
 * caller falls back to the model's rules twin (see loader.ts). The player
 * bundle never pays for the runtime unless a world uses it.
 */
export class OnnxNpc implements NpcModel {
  readonly id: string;
  readonly runtime = 'onnx' as const;
  readonly descriptor: ModelEntry;
  private session: OrtSession;
  private home: Vec3;
  private bounds: typeof DEFAULT_COURT_BOUNDS;

  private constructor(descriptor: ModelEntry, session: OrtSession, home: Vec3, bounds: typeof DEFAULT_COURT_BOUNDS) {
    this.descriptor = descriptor;
    this.id = descriptor.id;
    this.session = session;
    this.home = home;
    this.bounds = bounds;
  }

  /** Display-only state, derived from the observation (the graph itself is stateless). */
  get state(): string {
    return 'onnx';
  }

  reset(): void {
    // Stateless: nothing to reset. Kept for the NpcModel interface.
  }

  static async load(descriptor: ModelEntry, bytes: Uint8Array, home: Vec3 = DEFAULT_HOME, bounds = DEFAULT_COURT_BOUNDS): Promise<OnnxNpc> {
    if (descriptor.runtime !== 'onnx') {
      throw new OnnxModelError(`model "${descriptor.id}" is not an onnx model (runtime is "${descriptor.runtime}")`);
    }
    let ort: typeof import('onnxruntime-web');
    try {
      ort = await import('onnxruntime-web');
    } catch {
      throw new OnnxRuntimeUnavailableError(
        'onnxruntime-web could not be loaded. Install it (npm i onnxruntime-web) or use the rules fallback model.',
      );
    }
    try {
      // One thread: no cross-thread float reduction, so the same inputs give the same outputs.
      if (ort.env?.wasm) ort.env.wasm.numThreads = 1;
    } catch {
      /* the node build may not expose env.wasm; inference stays single-threaded there */
    }
    let session: OrtSession;
    try {
      const created = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      session = created as unknown as OrtSession;
    } catch (e) {
      throw new OnnxModelError(`could not load onnx model "${descriptor.id}": ${(e as Error).message}`);
    }
    if (!session.inputNames.includes(ONNX_INPUT_NAME)) {
      throw new OnnxModelError(`onnx model "${descriptor.id}" has no "${ONNX_INPUT_NAME}" input (has: ${session.inputNames.join(', ')})`);
    }
    if (!session.outputNames.includes(ONNX_OUTPUT_NAME)) {
      throw new OnnxModelError(`onnx model "${descriptor.id}" has no "${ONNX_OUTPUT_NAME}" output (has: ${session.outputNames.join(', ')})`);
    }
    return new OnnxNpc(descriptor, session, home, bounds);
  }

  async update(obs: NpcObservation, dt: number): Promise<NpcAction> {
    validateObservation(obs);
    if (!Number.isFinite(dt) || dt < 0) {
      throw new OnnxModelError('invalid tick: dt must be a finite number >= 0');
    }
    const features = observationToFeatures(obs, this.home, this.bounds);
    let ort: typeof import('onnxruntime-web');
    try {
      ort = await import('onnxruntime-web');
    } catch {
      throw new OnnxRuntimeUnavailableError('onnxruntime-web could not be loaded');
    }
    const feeds = { [ONNX_INPUT_NAME]: new ort.Tensor('float32', features, [1, ONNX_OBS_FEATURES.length]) };
    let out: Record<string, { data: Float32Array | number[] }>;
    try {
      out = await this.session.run(feeds);
    } catch (e) {
      throw new OnnxModelError(`onnx inference failed for "${this.id}": ${(e as Error).message}`);
    }
    const action = out[ONNX_OUTPUT_NAME];
    if (!action || action.data.length < ONNX_ACTION_FEATURES.length) {
      throw new OnnxModelError(`onnx model "${this.id}" returned a short action tensor`);
    }
    const vx = clamp(Number(action.data[0]), -ONNX_MAX_SPEED, ONNX_MAX_SPEED);
    const vz = clamp(Number(action.data[1]), -ONNX_MAX_SPEED, ONNX_MAX_SPEED);
    const passBall = Number(action.data[2]) > 0.5;
    const holdingBall = obs.ball.heldBy === 'rebounder';
    const state = passBall ? 'pass' : holdingBall ? 'carry' : 'chase';
    const target = holdingBall ? obs.player.position : obs.ball.position;
    const speed = Math.hypot(vx, vz);
    const velocity: Vec3 = speed < ONNX_DEAD_ZONE_MS ? [0, 0, 0] : [vx, 0, vz];
    return { state, velocity, passBall, holdingBall, target };
  }
}
