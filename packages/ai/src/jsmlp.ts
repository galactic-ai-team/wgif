import type { ModelEntry } from '@wgif/format';
import type { NpcAction, NpcModel, NpcObservation, Vec3 } from './types.js';
import { DEFAULT_COURT_BOUNDS, DEFAULT_HOME } from './types.js';
import {
  assertOnnxSignature,
  ModelSignatureError,
  observationToFeatures,
  ONNX_DEAD_ZONE_MS,
  ONNX_DIST_TO_BALL_IDX,
  ONNX_MAX_SPEED,
  ONNX_OUT_OF_BOUNDS_IDX,
  ONNX_PICKUP_RADIUS_M,
} from './features.js';
import { validateObservation } from './rules.js';

export class JsMlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsMlpError';
  }
}

/**
 * The hand-rolled JS MLP evaluator (Option A, Phase One): evaluates the
 * rebounder's ONNX file with plain JavaScript — no onnxruntime-web, no WASM,
 * no COOP/COEP question. It reads the six trained tensors straight out of
 * the .onnx container and runs the same forward pass the training script
 * defines (Gemm + tanh, Gemm + tanh, Gemm): the file stays the single source
 * of truth, and the evaluator is small enough to ship in the player bundle.
 *
 * Fail-closed by design: the weights must be float32 tensors with exactly
 * the shapes below, and the descriptor must promise the evaluator's
 * signature (see features.ts). Anything else throws JsMlpError and the
 * loader falls back to the rules twin.
 */
interface Weights {
  W1: Float32Array;
  b1: Float32Array;
  W2: Float32Array;
  b2: Float32Array;
  W3: Float32Array;
  b3: Float32Array;
}

/** The six trained tensors, each with its exact expected shape. */
const WEIGHTS: Array<[keyof Weights, readonly number[]]> = [
  ['W1', [14, 32]],
  ['b1', [32]],
  ['W2', [32, 32]],
  ['b2', [32]],
  ['W3', [32, 3]],
  ['b3', [3]],
];

// --- Minimal protobuf reader (only what an ONNX TensorProto needs) ---

function readVarint(buf: Uint8Array, p: number): [number, number] {
  let v = 0;
  let shift = 0;
  for (;;) {
    if (p >= buf.length) throw new JsMlpError('truncated protobuf in onnx model');
    const b = buf[p++]!;
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [v, p];
    shift += 7;
    if (shift > 28) throw new JsMlpError('varint too long in onnx model');
  }
}

/** Reads one protobuf field at p. Returns [fieldNo, wireType, valueStart, valueEnd, nextPos]. */
function readField(buf: Uint8Array, p: number): [number, number, number, number, number] {
  const [tag, p1] = readVarint(buf, p);
  const wire = tag & 7;
  if (wire === 0) {
    const [, p2] = readVarint(buf, p1);
    return [tag >> 3, wire, p1, p2, p2];
  }
  if (wire === 2) {
    const [len, p2] = readVarint(buf, p1);
    const end = p2 + len;
    if (end > buf.length) throw new JsMlpError('truncated protobuf in onnx model');
    return [tag >> 3, wire, p2, end, end];
  }
  throw new JsMlpError(`unsupported protobuf wire type ${wire} in onnx model`);
}

/** Reads the little-endian float32s in [start, end). */
function readFloats(buf: Uint8Array, start: number, end: number): Float32Array {
  const count = (end - start) / 4;
  if (!Number.isInteger(count)) throw new JsMlpError('float data is not a whole number of float32s');
  const out = new Float32Array(count);
  const view = new DataView(buf.buffer, buf.byteOffset + start, end - start);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

interface TensorProto {
  name: string;
  dtype: number;
  dims: number[];
  values: Float32Array;
}

/** Parses one TensorProto (an initializer): name, dtype, dims, float values. */
function parseTensor(buf: Uint8Array, start: number, end: number): TensorProto {
  let name = '';
  let dtype = 0;
  const dims: number[] = [];
  let raw: Float32Array | undefined;
  let packed: Float32Array | undefined;
  let p = start;
  while (p < end) {
    const [no, wire, vs, ve, next] = readField(buf, p);
    // TensorProto field numbers (onnx.proto): dims = 1, data_type = 2,
    // float_data = 4 (packed), name = 8, raw_data = 9. dims may be packed
    // (wire 2) or one varint per element (wire 0) — accept both.
    if (no === 2 && wire === 0) {
      [dtype] = readVarint(buf, vs);
    } else if (no === 1 && wire === 0) {
      const [v] = readVarint(buf, vs);
      dims.push(v);
    } else if (no === 1 && wire === 2) {
      let q = vs;
      while (q < ve) {
        const [v, q2] = readVarint(buf, q);
        dims.push(v);
        q = q2;
      }
    } else if (no === 4 && wire === 2) {
      packed = readFloats(buf, vs, ve);
    } else if (no === 8 && wire === 2) {
      name = new TextDecoder().decode(buf.subarray(vs, ve));
    } else if (no === 9 && wire === 2) {
      raw = readFloats(buf, vs, ve);
    }
    p = next;
  }
  const values = raw ?? packed;
  if (values === undefined) throw new JsMlpError(`onnx tensor "${name || '?'}" has no float data`);
  const expected = dims.reduce((a, d) => a * d, 1);
  if (values.length !== expected) throw new JsMlpError(`onnx tensor "${name || '?'}" has ${values.length} values for shape [${dims.join(', ')}]`);
  return { name, dtype, dims, values };
}

/**
 * Reads the six rebounder weights out of an .onnx file: ModelProto field 7 is
 * the graph, GraphProto field 5 repeats the initializers. Verifies every
 * tensor is float32 with exactly the expected shape.
 */
function readWeights(bytes: Uint8Array): Weights {
  let graph: [number, number] | undefined;
  let p = 0;
  while (p < bytes.length) {
    const [no, wire, vs, ve, next] = readField(bytes, p);
    if (no === 7 && wire === 2) {
      graph = [vs, ve];
      break;
    }
    p = next;
  }
  if (!graph) throw new JsMlpError('onnx model has no graph');
  const found = new Map<string, TensorProto>();
  let q = graph[0];
  while (q < graph[1]) {
    const [no, wire, vs, ve, next] = readField(bytes, q);
    if (no === 5 && wire === 2) {
      const t = parseTensor(bytes, vs, ve);
      if (t.name) found.set(t.name, t);
    }
    q = next;
  }
  const out = {} as Weights;
  for (const [name, shape] of WEIGHTS) {
    const t = found.get(name);
    if (!t) throw new JsMlpError(`onnx model is missing weight "${name}"`);
    if (t.dtype !== 1) throw new JsMlpError(`weight "${name}" has dtype ${t.dtype}, expected float32 (1)`);
    if (t.dims.length !== shape.length || t.dims.some((d, i) => d !== shape[i]))
      throw new JsMlpError(`weight "${name}" has shape [${t.dims.join(', ')}], expected [${shape.join(', ')}]`);
    out[name] = t.values;
  }
  return out;
}

/** y = x @ W + b, W row-major [rows, cols]; tanh applied when `tanh` is set. */
function affine(x: Float32Array, w: Float32Array, b: Float32Array, rows: number, cols: number, tanh: boolean): Float32Array {
  const out = new Float32Array(cols);
  for (let j = 0; j < cols; j++) {
    let s = b[j]!;
    for (let i = 0; i < rows; i++) s += x[i]! * w[i * cols + j]!;
    out[j] = tanh ? Math.tanh(s) : s;
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * The rebounder NPC as a pure-JS MLP: same weights, same features, same
 * action shaping as the ONNX Runtime path (src/onnx.ts), so the two
 * evaluators agree on every observation. Stateless — the held flags in the
 * observation carry the state.
 *
 * One thing the network does NOT output is the pickup decision: its action
 * is [vx, vz, pass_logit], so `holdingBall` is derived here. It is true
 * while the ball is already held, and it is asserted when the loose ball is
 * within the pickup radius — that is the model's pickup decision, mirroring
 * the rules model's `ball_near` (pickupRadius), and the player adapter's
 * reach check is the second gate. Without the proximity term the NPC would
 * walk to the ball and stand on it forever: `holdingBall` would only ever
 * become true after a pickup the adapter never performs.
 */
export class JsMlpNpc implements NpcModel {
  readonly id: string;
  readonly runtime = 'onnx' as const;
  readonly descriptor: ModelEntry;
  private weights: Weights;
  private home: Vec3;
  private bounds: typeof DEFAULT_COURT_BOUNDS;
  private pickupRadius: number;
  /** Display-only state, from the last action computed (starts 'onnx'). */
  private lastState = 'onnx';

  private constructor(descriptor: ModelEntry, weights: Weights, home: Vec3, bounds = DEFAULT_COURT_BOUNDS, pickupRadius = ONNX_PICKUP_RADIUS_M) {
    this.descriptor = descriptor;
    this.id = descriptor.id;
    this.weights = weights;
    this.home = home;
    this.bounds = bounds;
    this.pickupRadius = pickupRadius;
  }

  /** Display-only state, from the last action (`chase` / `carry` / `pass`). */
  get state(): string {
    return this.lastState;
  }

  reset(): void {
    // Stateless: nothing to reset, except the display state.
    this.lastState = 'onnx';
  }

  static async load(descriptor: ModelEntry, bytes: Uint8Array, home: Vec3 = DEFAULT_HOME, bounds = DEFAULT_COURT_BOUNDS, pickupRadius = ONNX_PICKUP_RADIUS_M): Promise<JsMlpNpc> {
    if (descriptor.runtime !== 'onnx') {
      throw new JsMlpError(`model "${descriptor.id}" is not an onnx model (runtime is "${descriptor.runtime}")`);
    }
    try {
      assertOnnxSignature(descriptor);
    } catch (e) {
      if (e instanceof ModelSignatureError) throw new JsMlpError(e.message);
      throw e;
    }
    let weights: Weights;
    try {
      weights = readWeights(bytes);
    } catch (e) {
      throw new JsMlpError(`could not read onnx weights for "${descriptor.id}": ${(e as Error).message}`);
    }
    return new JsMlpNpc(descriptor, weights, home, bounds, pickupRadius);
  }

  async update(obs: NpcObservation, dt: number): Promise<NpcAction> {
    validateObservation(obs);
    if (!Number.isFinite(dt) || dt < 0) {
      throw new JsMlpError('invalid tick: dt must be a finite number >= 0');
    }
    const x = observationToFeatures(obs, this.home, this.bounds);
    const h1 = affine(x, this.weights.W1, this.weights.b1, 14, 32, true);
    const h2 = affine(h1, this.weights.W2, this.weights.b2, 32, 32, true);
    const out = affine(h2, this.weights.W3, this.weights.b3, 32, 3, false);
    const vx = clamp(Number(out[0]), -ONNX_MAX_SPEED, ONNX_MAX_SPEED);
    const vz = clamp(Number(out[1]), -ONNX_MAX_SPEED, ONNX_MAX_SPEED);
    const passBall = Number(out[2]) > 0.5;
    // The pickup decision: already holding it, or the loose ball is within
    // reach on the court. Out-of-bounds balls are never picked up — the rules
    // model gives up on those by design, and the network was trained on that
    // policy, so the proximity term must not override it.
    const holdingBall =
      obs.ball.heldBy === 'rebounder' ||
      (obs.ball.heldBy === null && Number(x[ONNX_OUT_OF_BOUNDS_IDX]) === 0 && Number(x[ONNX_DIST_TO_BALL_IDX]) <= this.pickupRadius);
    const state = passBall ? 'pass' : holdingBall ? 'carry' : 'chase';
    this.lastState = state;
    const target = holdingBall ? obs.player.position : obs.ball.position;
    const speed = Math.hypot(vx, vz);
    const velocity: Vec3 = speed < ONNX_DEAD_ZONE_MS ? [0, 0, 0] : [vx, 0, vz];
    return { state, velocity, passBall, holdingBall, target };
  }
}
