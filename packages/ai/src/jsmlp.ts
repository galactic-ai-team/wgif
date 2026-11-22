import type { ModelEntry } from '@wgif/format';
import type { NpcAction, NpcModel, NpcObservation, Vec3 } from './types.js';
import { DEFAULT_COURT_BOUNDS, DEFAULT_HOME } from './types.js';
import {
  assertOnnxSignature,
  ModelSignatureError,
  observationToFeatures,
  ONNX_DEAD_ZONE_MS,
  ONNX_DIST_TO_BALL_IDX,
  ONNX_INPUT_NAME,
  ONNX_MAX_SPEED,
  ONNX_OUTPUT_NAME,
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
  // Fixed 64-bit and 32-bit values (an AttributeProto's float is fixed32).
  if (wire === 1 || wire === 5) {
    const end = p1 + (wire === 1 ? 8 : 4);
    if (end > buf.length) throw new JsMlpError('truncated protobuf in onnx model');
    return [tag >> 3, wire, p1, end, end];
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

// --- The graph and its I/O (SPEC §6: validated against the descriptor before inference) ---

/** onnx.proto TensorProto.DataType FLOAT. */
const ONNX_FLOAT = 1;
/** Gemm attributes this evaluator honours, at the values it computes with (y = x @ W + b). */
const GEMM_ATTRIBUTES: Readonly<Record<string, number>> = { alpha: 1, beta: 1, transA: 0, transB: 0 };
/** The graph the evaluator implements, node by node. Its weights are checked by readWeights(). */
const GRAPH: ReadonlyArray<{ op: 'Gemm' | 'Tanh'; weights?: readonly [keyof Weights, keyof Weights] }> = [
  { op: 'Gemm', weights: ['W1', 'b1'] },
  { op: 'Tanh' },
  { op: 'Gemm', weights: ['W2', 'b2'] },
  { op: 'Tanh' },
  { op: 'Gemm', weights: ['W3', 'b3'] },
];

interface ValueInfo {
  name: string;
  elemType: number;
  /** dim_value, or the dim_param name for a symbolic dimension. */
  dims: (number | string)[];
}

interface NodeInfo {
  op: string;
  domain: string;
  inputs: string[];
  outputs: string[];
  /** Numeric attributes by name; null for a value this check does not read (a string, a tensor, a list). */
  attributes: Map<string, number | null>;
}

interface GraphInfo {
  nodes: NodeInfo[];
  inputs: ValueInfo[];
  outputs: ValueInfo[];
  initializers: Set<string>;
  /** Version imported for the default (ai.onnx) domain, or null when it is not imported. */
  opset: number | null;
}

const decodeText = (buf: Uint8Array, start: number, end: number): string => new TextDecoder().decode(buf.subarray(start, end));

/** Calls `visit` for every field of the message in [start, end). */
function eachField(buf: Uint8Array, start: number, end: number, visit: (no: number, wire: number, vs: number, ve: number) => void): void {
  let p = start;
  while (p < end) {
    const [no, wire, vs, ve, next] = readField(buf, p);
    visit(no, wire, vs, ve);
    p = next;
  }
}

/** ValueInfoProto: name = 1, type = 2 (TypeProto: tensor_type = 1 (elem_type = 1, shape = 2 (dim = 1 (dim_value = 1, dim_param = 2)))). */
function parseValueInfo(buf: Uint8Array, start: number, end: number): ValueInfo {
  const info: ValueInfo = { name: '', elemType: 0, dims: [] };
  eachField(buf, start, end, (no, wire, vs, ve) => {
    if (no === 1 && wire === 2) info.name = decodeText(buf, vs, ve);
    else if (no === 2 && wire === 2) {
      eachField(buf, vs, ve, (tno, twire, ts, te) => {
        if (tno !== 1 || twire !== 2) return; // only tensor types are meaningful here
        eachField(buf, ts, te, (kno, kwire, ks, ke) => {
          if (kno === 1 && kwire === 0) [info.elemType] = readVarint(buf, ks);
          else if (kno === 2 && kwire === 2) {
            eachField(buf, ks, ke, (dno, dwire, ds, de) => {
              if (dno !== 1 || dwire !== 2) return;
              let dim: number | string = '?';
              eachField(buf, ds, de, (vno, vwire, vs2, ve2) => {
                if (vno === 1 && vwire === 0) [dim] = readVarint(buf, vs2);
                else if (vno === 2 && vwire === 2) dim = decodeText(buf, vs2, ve2);
              });
              info.dims.push(dim);
            });
          }
        });
      });
    }
  });
  return info;
}

/** NodeProto: input = 1, output = 2, op_type = 4, attribute = 5 (name = 1, f = 2, i = 3), domain = 7. */
function parseNode(buf: Uint8Array, start: number, end: number): NodeInfo {
  const node: NodeInfo = { op: '', domain: '', inputs: [], outputs: [], attributes: new Map() };
  eachField(buf, start, end, (no, wire, vs, ve) => {
    if (wire !== 2) return;
    if (no === 1) node.inputs.push(decodeText(buf, vs, ve));
    else if (no === 2) node.outputs.push(decodeText(buf, vs, ve));
    else if (no === 4) node.op = decodeText(buf, vs, ve);
    else if (no === 7) node.domain = decodeText(buf, vs, ve);
    else if (no === 5) {
      let name = '';
      let value: number | null = null;
      eachField(buf, vs, ve, (ano, awire, as, ae) => {
        if (ano === 1 && awire === 2) name = decodeText(buf, as, ae);
        else if (ano === 2 && awire === 5) value = new DataView(buf.buffer, buf.byteOffset + as, 4).getFloat32(0, true);
        else if (ano === 3 && awire === 0) [value] = readVarint(buf, as);
      });
      node.attributes.set(name, value);
    }
  });
  return node;
}

/** ModelProto: opset_import = 8 (domain = 1, version = 2), graph = 7 (node = 1, initializer = 5, input = 11, output = 12). */
function readGraph(bytes: Uint8Array): GraphInfo {
  const info: GraphInfo = { nodes: [], inputs: [], outputs: [], initializers: new Set(), opset: null };
  const found: { graph: [number, number] | null } = { graph: null };
  eachField(bytes, 0, bytes.length, (no, wire, vs, ve) => {
    if (no === 7 && wire === 2) found.graph = [vs, ve];
    else if (no === 8 && wire === 2) {
      let domain = '';
      let version = 0;
      eachField(bytes, vs, ve, (ono, owire, os, oe) => {
        if (ono === 1 && owire === 2) domain = decodeText(bytes, os, oe);
        else if (ono === 2 && owire === 0) [version] = readVarint(bytes, os);
      });
      if (domain === '' || domain === 'ai.onnx') info.opset = version;
    }
  });
  if (!found.graph) throw new JsMlpError('onnx model has no graph');
  const [gs, ge] = found.graph;
  eachField(bytes, gs, ge, (no, wire, vs, ve) => {
    if (wire !== 2) return;
    if (no === 1) info.nodes.push(parseNode(bytes, vs, ve));
    else if (no === 5) info.initializers.add(parseTensor(bytes, vs, ve).name);
    else if (no === 11) info.inputs.push(parseValueInfo(bytes, vs, ve));
    else if (no === 12) info.outputs.push(parseValueInfo(bytes, vs, ve));
  });
  return info;
}

const same = (dims: (number | string)[], shape: readonly number[] | undefined): boolean =>
  !!shape && dims.length === shape.length && dims.every((d, i) => d === shape[i]);

/**
 * SPEC §6: before inference, the ONNX graph and its tensor signature must agree with the
 * descriptor. The evaluator only reads the weights, so a file with the same six weights but a
 * different graph (another activation, transposed weights, an extra node) or different inputs
 * and outputs would run as if it were the rebounder — and disagree with any real ONNX runtime.
 * Refuses all of that: exactly one graph input and one output, named, typed and shaped as the
 * descriptor declares, and exactly Gemm → Tanh → Gemm → Tanh → Gemm on the declared weights.
 */
export function assertSupportedGraph(bytes: Uint8Array, descriptor: ModelEntry): void {
  const g = readGraph(bytes);
  const declaredIn = descriptor.inputs?.find((f) => f.name === ONNX_INPUT_NAME);
  const declaredOut = descriptor.outputs?.find((f) => f.name === ONNX_OUTPUT_NAME);
  const fail = (why: string): never => {
    throw new JsMlpError(`onnx model "${descriptor.id}": ${why}`);
  };
  if (g.opset === null || g.opset < 7) fail(`the graph needs the default ONNX opset 7 or later (has ${g.opset ?? 'none'})`);
  const inputs = g.inputs.filter((i) => !g.initializers.has(i.name));
  if (inputs.length !== 1) fail(`the graph has ${inputs.length} inputs, the descriptor declares one ("${ONNX_INPUT_NAME}")`);
  const input = inputs[0]!;
  if (input.name !== ONNX_INPUT_NAME || input.elemType !== ONNX_FLOAT || !same(input.dims, declaredIn?.shape))
    fail(`graph input "${input.name}" (type ${input.elemType}, [${input.dims.join(', ')}]) does not match the declared "${ONNX_INPUT_NAME}" float32 [${declaredIn?.shape?.join(', ') ?? '?'}]`);
  if (g.outputs.length !== 1) fail(`the graph has ${g.outputs.length} outputs, the descriptor declares one ("${ONNX_OUTPUT_NAME}")`);
  const output = g.outputs[0]!;
  if (output.name !== ONNX_OUTPUT_NAME || output.elemType !== ONNX_FLOAT || !same(output.dims, declaredOut?.shape))
    fail(`graph output "${output.name}" (type ${output.elemType}, [${output.dims.join(', ')}]) does not match the declared "${ONNX_OUTPUT_NAME}" float32 [${declaredOut?.shape?.join(', ') ?? '?'}]`);
  if (g.nodes.length !== GRAPH.length) fail(`the graph has ${g.nodes.length} nodes; this evaluator runs exactly Gemm, Tanh, Gemm, Tanh, Gemm`);
  let flowing = input.name;
  GRAPH.forEach((want, k) => {
    const node = g.nodes[k]!;
    const where = `node ${k + 1} (${node.op || '?'})`;
    if (node.op !== want.op || (node.domain !== '' && node.domain !== 'ai.onnx')) fail(`${where} should be ${want.op}`);
    const expected = want.weights ? [flowing, ...want.weights] : [flowing];
    if (node.inputs.length !== expected.length || node.inputs.some((n, i) => n !== expected[i])) fail(`${where} takes [${node.inputs.join(', ')}], expected [${expected.join(', ')}]`);
    if (node.outputs.length !== 1 || !node.outputs[0]) fail(`${where} must have exactly one output`);
    for (const [name, value] of node.attributes) {
      if (want.op !== 'Gemm' || !(name in GEMM_ATTRIBUTES) || value !== GEMM_ATTRIBUTES[name]) fail(`${where} has attribute ${name} = ${value ?? '(not a number)'}, which this evaluator does not compute`);
    }
    flowing = node.outputs[0]!;
    if (k < GRAPH.length - 1 && (g.initializers.has(flowing) || flowing === output.name)) fail(`${where} writes "${flowing}", which is not an intermediate value`);
  });
  if (flowing !== output.name) fail(`the last node writes "${flowing}", not the graph output "${output.name}"`);
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
    // The weights alone do not say what the file computes: the graph has to be the one this
    // evaluator runs, with the declared inputs and outputs (SPEC §6), or it is not run at all.
    assertSupportedGraph(bytes, descriptor);
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
