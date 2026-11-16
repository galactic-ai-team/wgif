import type { ModelEntry } from '@wgif/format';
import type { NpcAction, NpcModel, NpcObservation, Vec3 } from './types.js';
import { DEFAULT_COURT_BOUNDS, DEFAULT_HOME } from './types.js';
import {
  assertOnnxSignature,
  ModelSignatureError,
  observationToFeatures,
  ONNX_ACTION_FEATURES,
  ONNX_DEAD_ZONE_MS,
  ONNX_INPUT_NAME,
  ONNX_MAX_SPEED,
  ONNX_OBS_FEATURES,
  ONNX_OUTPUT_NAME,
} from './features.js';
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

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

interface OrtTensor {
  readonly data: Float32Array | number[];
  readonly dims?: readonly number[];
  readonly type?: string;
}

interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}

/**
 * The ONNX NPC via ONNX Runtime Web — Node-side verification only. The player
 * runs the same .onnx file through the hand-rolled JS MLP evaluator
 * (src/jsmlp.ts), so no WASM ships in the player bundle (runtime-WASM budget
 * is 0 B, PR #3). This class stays as the independent cross-check: the two
 * evaluators must agree on every observation (see test/ai.test.ts), and it is
 * the only place onnxruntime-web is imported. It is NOT exported from the
 * package entry point, so the player bundle can never pull it in.
 *
 * The model is a distilled clone of the rules rebounder, trained on synthetic
 * data from the rules policy (see scripts/train_rebounder_mlp.py). It is
 * stateless — the held flags in the observation carry the state — and fully
 * on-device: ONNX Runtime Web, WASM, CPU, one thread (deterministic).
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
    try {
      assertOnnxSignature(descriptor);
    } catch (e) {
      if (e instanceof ModelSignatureError) throw new OnnxModelError(e.message);
      throw e;
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
    // Session contract check: run one probe inference with the exact input the
    // descriptor promises ([1, 14] float32, all zeros) and verify the live
    // session returns a [1, 3] float32 action. A graph whose input shape/dtype
    // or output disagrees fails here, at load, instead of on the first real
    // tick mid-game.
    let probeOut: Record<string, OrtTensor>;
    try {
      const probe = new ort.Tensor('float32', new Float32Array(ONNX_OBS_FEATURES.length), [1, ONNX_OBS_FEATURES.length]);
      probeOut = await session.run({ [ONNX_INPUT_NAME]: probe });
    } catch (e) {
      throw new OnnxModelError(`onnx model "${descriptor.id}" rejected the declared input ([1, 14] float32): ${(e as Error).message}`);
    }
    const probeAction = probeOut[ONNX_OUTPUT_NAME];
    if (!probeAction) {
      throw new OnnxModelError(`onnx model "${descriptor.id}" returned no "${ONNX_OUTPUT_NAME}" output on the probe inference`);
    }
    if (probeAction.type !== undefined && probeAction.type !== 'float32') {
      throw new OnnxModelError(`onnx model "${descriptor.id}" returns "${ONNX_OUTPUT_NAME}" as ${probeAction.type}, expected float32`);
    }
    if (probeAction.dims !== undefined) {
      if (probeAction.dims.length !== 2 || probeAction.dims[0] !== 1 || probeAction.dims[1] !== ONNX_ACTION_FEATURES.length) {
        throw new OnnxModelError(
          `onnx model "${descriptor.id}" returns "${ONNX_OUTPUT_NAME}" with shape [${probeAction.dims.join(', ')}], expected [1, ${ONNX_ACTION_FEATURES.length}]`,
        );
      }
    }
    if (probeAction.data.length !== ONNX_ACTION_FEATURES.length) {
      throw new OnnxModelError(`onnx model "${descriptor.id}" returned a short action tensor (${probeAction.data.length} values, expected ${ONNX_ACTION_FEATURES.length})`);
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
    let out: Record<string, OrtTensor>;
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
