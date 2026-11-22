import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packWgif, unpackWgif, utf8, type ModelEntry, type WgifFiles } from '@wgif/format';
import {
  JsMlpNpc,
  ONNX_OBS_FEATURES,
  loadModelFromWorld,
  loadRulesModel,
  observationToFeatures,
  parseRulesModel,
  RulesModelError,
  type BallObservation,
  type NpcObservation,
  type Vec3,
} from '../src/index.js';
import { OnnxNpc } from '../src/onnx.js';

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
  inputs: [{ name: 'obs', shape: [1, 14], dtype: 'float32', description: 'See ONNX_OBS_FEATURES in src/onnx.ts.' }],
  outputs: [{ name: 'action', shape: [1, 3], dtype: 'float32', description: '[vx, vz, pass_logit].' }],
  tickHz: 10,
  deterministic: true,
  seed: 7,
  license: 'CC-BY-4.0',
  fallback: 'rebounder-rules',
};

function obs(
  over: {
    timeSec?: number;
    ball?: Partial<BallObservation>;
    player?: { position?: Vec3 };
    self?: { position?: Vec3 };
  } = {},
): NpcObservation {
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

describe('rules model parsing (fail-closed)', () => {
  it('parses the court rebounder file', () => {
    const rules = parseRulesModel(rulesBytes);
    expect(rules.model).toBe('rebounder');
    expect(rules.initialState).toBe('idle');
    expect(Object.keys(rules.states).sort()).toEqual(['carry', 'chase', 'idle', 'pass', 'pickup']);
  });

  it('rejects unknown conditions, behaviours, targets and non-determinism', () => {
    const base = JSON.parse(new TextDecoder().decode(rulesBytes)) as Record<string, unknown>;
    const mutate = (fn: (m: Record<string, unknown>) => void): Uint8Array => {
      const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      fn(copy);
      return utf8(JSON.stringify(copy));
    };
    const states = (m: Record<string, unknown>) => m.states as Record<string, Record<string, Record<string, unknown>>>;
    const chase = (m: Record<string, unknown>) => states(m).chase!;
    const chaseOn = (m: Record<string, unknown>) => chase(m).on as unknown as { when: string; to: string }[];
    expect(() => parseRulesModel(mutate((m) => { chaseOn(m)[0]!.when = 'whenever'; }))).toThrow(RulesModelError);
    expect(() => parseRulesModel(mutate((m) => { chase(m).behavior!.type = 'dance'; }))).toThrow(RulesModelError);
    expect(() => parseRulesModel(mutate((m) => { chaseOn(m)[0]!.to = 'nowhere'; }))).toThrow(RulesModelError);
    expect(() => parseRulesModel(mutate((m) => { chase(m).behavior!.speed = 'warpSpeed'; }))).toThrow(RulesModelError);
    expect(() => parseRulesModel(mutate((m) => { m.deterministic = false; }))).toThrow(RulesModelError);
    expect(() => parseRulesModel(mutate((m) => { m.initialState = 'nowhere'; }))).toThrow(RulesModelError);
    expect(() => parseRulesModel(utf8('{not json'))).toThrow(RulesModelError);
  });

  it('rejects bad observations and bad ticks', async () => {
    const npc = loadRulesModel(rulesDescriptor, rulesBytes);
    await expect(npc.update(obs({ ball: { position: [Number.NaN, 0, 0] } }), 0.1)).rejects.toThrow(RulesModelError);
    await expect(npc.update(obs({ ball: { heldBy: 'referee' as never } }), 0.1)).rejects.toThrow(RulesModelError);
    await expect(npc.update(obs(), -1)).rejects.toThrow(RulesModelError);
  });
});

describe('rules rebounder behaviour', () => {
  it('chases a loose ball, picks it up, carries it and passes it back', async () => {
    const npc = loadRulesModel(rulesDescriptor, rulesBytes);
    const dt = 0.1;
    let self: Vec3 = [0, 0, 6];
    let ball: Vec3 = [9, 0.12, 1.2];
    let heldBy: 'player' | 'rebounder' | null = null;
    const player: Vec3 = [0, 0, 9.5];
    const seen: string[] = [];
    let passTick = -1;
    for (let tick = 0; tick < 300; tick++) {
      const action = await npc.update({ timeSec: tick * dt, ball: { position: ball, velocity: [0, 0, 0], heldBy }, player: { position: player }, self: { position: self } }, dt);
      if (seen.at(-1) !== action.state) seen.push(action.state);
      self = [self[0] + action.velocity[0] * dt, 0, self[2] + action.velocity[2] * dt];
      if (action.holdingBall) {
        heldBy = 'rebounder';
        ball = [self[0], 0.9, self[2]];
      } else if (action.passBall) {
        heldBy = 'player';
        ball = [player[0], 0.9, player[2]];
        passTick = tick;
      }
      if (passTick >= 0 && action.state === 'idle') break;
    }
    expect(passTick).toBeGreaterThan(0);
    expect(seen).toEqual(['chase', 'pickup', 'carry', 'pass', 'idle']);
    expect(heldBy).toBe('player');
  });

  it('is deterministic on a recorded input sequence', async () => {
    const script: NpcObservation[] = [];
    for (let i = 0; i < 40; i++) {
      script.push(obs({ timeSec: i * 0.1, ball: { position: [9 - i * 0.15, 0.12, 1.2 + i * 0.05] } }));
    }
    const run = async () => {
      const npc = loadRulesModel(rulesDescriptor, rulesBytes);
      const out = [];
      for (const o of script) out.push(await npc.update(o, 0.1));
      return out;
    };
    expect(await run()).toEqual(await run());
  });

  it('never leaves the court, even for a ball out of bounds', async () => {
    const npc = loadRulesModel(rulesDescriptor, rulesBytes);
    const dt = 0.1;
    let self: Vec3 = [0, 0, 6];
    for (let tick = 0; tick < 120; tick++) {
      const action = await npc.update(
        obs({ timeSec: tick * dt, ball: { position: [25, 0.12, 0], velocity: [0, 0, 0] }, self: { position: self } }),
        dt,
      );
      // The caller owns positions: integrate, then clamp to the court, the way
      // the player clamps the camera (apps/player/src/viewer.ts does the same).
      self = [
        Math.min(Math.max(self[0] + action.velocity[0] * dt, -17), 17),
        0,
        Math.min(Math.max(self[2] + action.velocity[2] * dt, -10), 10),
      ];
      expect(self[0]).toBeGreaterThanOrEqual(-17);
      expect(self[0]).toBeLessThanOrEqual(17);
      expect(self[2]).toBeGreaterThanOrEqual(-10);
      expect(self[2]).toBeLessThanOrEqual(10);
    }
    // An out-of-bounds ball is not chased forever: the NPC returns to idle.
    expect(npc.state).toBe('idle');
  });

  it('does not pick up a ball that is near but out of bounds', async () => {
    const npc = loadRulesModel(rulesDescriptor, rulesBytes);
    // Ball 0.3 m past the +x wall, NPC at the wall beside it: the ball is
    // inside pickup range (0.45 m) AND out of bounds. The chase state checks
    // ball_out_of_bounds before ball_near, so the NPC gives up instead of
    // picking up a ball it cannot legally reach.
    const out = obs({
      ball: { position: [17.3, 0.12, 0.5], velocity: [0, 0, 0] },
      self: { position: [17, 0, 0.5] },
    });
    const first = await npc.update(out, 0.1);
    expect(first.state).toBe('chase');
    const giveUp = await npc.update(out, 0.1);
    expect(giveUp.state).toBe('idle');
    expect(giveUp.holdingBall).toBe(false);
    expect(giveUp.passBall).toBe(false);
    // It walks home, not toward the out-of-bounds ball.
    expect(giveUp.velocity[0]).toBeLessThan(0);
    // Over more ticks it never picks the ball up.
    for (let tick = 0; tick < 8; tick++) {
      const action = await npc.update(out, 0.1);
      expect(action.state).not.toBe('pickup');
      expect(action.state).not.toBe('carry');
      expect(action.holdingBall).toBe(false);
    }

    // Control: the same geometry with the ball inside the court is picked up.
    const npc2 = loadRulesModel(rulesDescriptor, rulesBytes);
    const inBounds = obs({
      ball: { position: [16.7, 0.12, 0.5], velocity: [0, 0, 0] },
      self: { position: [17, 0, 0.5] },
    });
    await npc2.update(inBounds, 0.1);
    const pickup = await npc2.update(inBounds, 0.1);
    expect(pickup.state).toBe('pickup');
    expect(pickup.holdingBall).toBe(true);
  });

  it('chases at chase speed and carries at carry speed', async () => {
    const npc = loadRulesModel(rulesDescriptor, rulesBytes);
    const chase = await npc.update(obs(), 0.1);
    expect(chase.state).toBe('chase');
    expect(Math.hypot(chase.velocity[0], chase.velocity[2])).toBeCloseTo(5.0, 5);
    npc.reset();
    const carry = await npc.update(obs({ ball: { position: [0, 0.9, 6], heldBy: 'rebounder' }, self: { position: [0, 0, 6] } }), 0.1);
    expect(carry.state).toBe('carry');
    expect(Math.hypot(carry.velocity[0], carry.velocity[2])).toBeCloseTo(3.5, 5);
  });
});

describe('onnx rebounder', () => {
  it('builds the 14-feature observation vector in contract order', () => {
    expect(ONNX_OBS_FEATURES).toHaveLength(14);
    expect(ONNX_OBS_FEATURES[0]).toBe('ball_dx');
    expect(ONNX_OBS_FEATURES[12]).toBe('dist_to_player');
    const f = observationToFeatures(obs(), [0, 0, 6]);
    expect(f).toHaveLength(14);
    expect(f[0]).toBeCloseTo(9, 5); // ball_dx
    expect(f[1]).toBeCloseTo(-4.8, 5); // ball_dz
    expect(f[8]).toBe(0); // held_by_self
    expect(f[11]).toBeCloseTo(Math.hypot(9, 0.12, -4.8), 5); // dist_to_ball
    const far = observationToFeatures(obs({ ball: { position: [100, 0, 0] } }), [0, 0, 6]);
    expect(far[0]).toBe(20); // clamped
  });

  it('loads the trained model, is deterministic, and agrees with the rules model', async () => {
    const mlp = await OnnxNpc.load(onnxDescriptor, onnxBytes);
    const rules = loadRulesModel(rulesDescriptor, rulesBytes);
    const cases = [
      obs(),
      obs({ ball: { position: [3, 0.12, -2], velocity: [1, 0, 0] } }),
      obs({ ball: { position: [0.2, 0.9, 6.1], heldBy: 'rebounder' }, self: { position: [0, 0, 6] } }),
      obs({ ball: { position: [0, 0.9, 9.4], heldBy: 'rebounder' }, self: { position: [0, 0, 9] } }),
      obs({ ball: { position: [0, 0.9, 9.5], heldBy: 'player' } }),
      obs({ ball: { position: [25, 0.12, 0] } }),
    ];
    for (const o of cases) {
      const a = await mlp.update(o, 0.1);
      const b = await mlp.update(o, 0.1);
      expect(a).toEqual(b); // deterministic
      // The ONNX model clones one tick from the canonical state for the
      // observation; the rules machine may need a second tick to get there
      // (idle -> carry -> pass), so compare against the settled rules action.
      rules.reset();
      await rules.update(o, 0.1);
      const r = await rules.update(o, 0.1);
      const dot = a.velocity[0] * r.velocity[0] + a.velocity[2] * r.velocity[2];
      const mags = Math.hypot(a.velocity[0], a.velocity[2]) * Math.hypot(r.velocity[0], r.velocity[2]);
      if (mags > 0.1) expect(dot / mags).toBeGreaterThan(0.9); // same direction as the rules model
      expect(a.passBall).toBe(r.passBall);
    }
  });

  it('passes when holding the ball next to the player', async () => {
    const mlp = await OnnxNpc.load(onnxDescriptor, onnxBytes);
    const action = await mlp.update(
      obs({ ball: { position: [0, 0.9, 9], heldBy: 'rebounder' }, self: { position: [0, 0, 9] } }),
      0.1,
    );
    expect(action.passBall).toBe(true);
  });

  it('rejects models whose live session disagrees with the declared signature', async () => {
    const wrongShape = new Uint8Array(readFileSync(fileURLToPath(new URL('./fixtures/wrong-output-shape.onnx', import.meta.url))));
    await expect(OnnxNpc.load(onnxDescriptor, wrongShape)).rejects.toThrow(/shape \[1, 2\], expected \[1, 3\]/);
    const wrongDtype = new Uint8Array(readFileSync(fileURLToPath(new URL('./fixtures/wrong-input-dtype.onnx', import.meta.url))));
    await expect(OnnxNpc.load(onnxDescriptor, wrongDtype)).rejects.toThrow(/rejected the declared input/);
  });

  it('rejects a descriptor that does not promise the evaluator signature', async () => {
    const bad = { ...onnxDescriptor, inputs: [{ name: 'obs', shape: [1, 8], dtype: 'float32' as const }] };
    await expect(OnnxNpc.load(bad, onnxBytes)).rejects.toThrow(/declares "obs" as float32 \[1, 8\]/);
  });
});

describe('js mlp evaluator (Option A — the player runtime)', () => {
  const cases = [
    obs(),
    obs({ ball: { position: [3, 0.12, -2], velocity: [1, 0, 0] } }),
    obs({ ball: { position: [0.2, 0.9, 6.1], heldBy: 'rebounder' }, self: { position: [0, 0, 6] } }),
    obs({ ball: { position: [0, 0.9, 9.4], heldBy: 'rebounder' }, self: { position: [0, 0, 9] } }),
    obs({ ball: { position: [0, 0.9, 9.5], heldBy: 'player' } }),
    obs({ ball: { position: [25, 0.12, 0] } }),
    // Loose ball within pickup reach: the model decides to pick it up.
    obs({ ball: { position: [0.2, 0.12, 6.1] }, self: { position: [0, 0, 6] } }),
    // Loose ball within reach but out of bounds: never picked up.
    obs({ ball: { position: [17.3, 0.12, 0] }, self: { position: [17, 0, 0] } }),
  ];

  it('loads the trained model, is deterministic, and agrees with the rules model', async () => {
    const mlp = await JsMlpNpc.load(onnxDescriptor, onnxBytes);
    const rules = loadRulesModel(rulesDescriptor, rulesBytes);
    for (const o of cases) {
      const a = await mlp.update(o, 0.1);
      const b = await mlp.update(o, 0.1);
      expect(a).toEqual(b); // deterministic
      rules.reset();
      await rules.update(o, 0.1);
      const r = await rules.update(o, 0.1);
      const dot = a.velocity[0] * r.velocity[0] + a.velocity[2] * r.velocity[2];
      const mags = Math.hypot(a.velocity[0], a.velocity[2]) * Math.hypot(r.velocity[0], r.velocity[2]);
      if (mags > 0.1) expect(dot / mags).toBeGreaterThan(0.9); // same direction as the rules model
      expect(a.passBall).toBe(r.passBall);
    }
  });

  it('agrees with the onnx runtime evaluator on every observation', async () => {
    const js = await JsMlpNpc.load(onnxDescriptor, onnxBytes);
    const ort = await OnnxNpc.load(onnxDescriptor, onnxBytes);
    for (const o of cases) {
      const a = await js.update(o, 0.1);
      const b = await ort.update(o, 0.1);
      // JS does its accumulation in float64, ORT in float32 — allow 1e-4.
      expect(a.velocity[0]).toBeCloseTo(b.velocity[0], 4);
      expect(a.velocity[2]).toBeCloseTo(b.velocity[2], 4);
      expect(a.passBall).toBe(b.passBall);
      expect(a.state).toBe(b.state);
      expect(a.holdingBall).toBe(b.holdingBall);
    }
  });

  it('decides the pickup from proximity: a loose ball within reach is held, a far or out-of-bounds one is not', async () => {
    const mlp = await JsMlpNpc.load(onnxDescriptor, onnxBytes);
    const near = await mlp.update(obs({ ball: { position: [0.2, 0.12, 6.1] }, self: { position: [0, 0, 6] } }), 0.1);
    expect(near.holdingBall).toBe(true);
    expect(near.state).toBe('carry');
    const far = await mlp.update(obs({ ball: { position: [3, 0.12, -2] } }), 0.1);
    expect(far.holdingBall).toBe(false);
    expect(far.state).toBe('chase');
    const outOfBounds = await mlp.update(obs({ ball: { position: [17.3, 0.12, 0] }, self: { position: [17, 0, 0] } }), 0.1);
    expect(outOfBounds.holdingBall).toBe(false);
    // The display state follows the last action.
    expect(mlp.state).toBe('chase');
  });

  it('rejects models with missing or wrongly-shaped weights, and garbage bytes', async () => {
    const load = (name: string) =>
      JsMlpNpc.load(onnxDescriptor, new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))));
    await expect(load('wrong-output-shape.onnx')).rejects.toThrow(/missing weight "W1"/);
    await expect(load('wrong-input-dtype.onnx')).rejects.toThrow(/missing weight "W1"/);
    await expect(load('wrong-w3-shape.onnx')).rejects.toThrow(/weight "W3" has shape \[32, 2\], expected \[32, 3\]/);
    await expect(load('truncated.onnx')).rejects.toThrow(/could not read onnx weights/);
    await expect(JsMlpNpc.load(onnxDescriptor, new TextEncoder().encode('not an onnx model'))).rejects.toThrow(/could not read onnx weights/);
  });

  it('rejects a descriptor that does not promise the evaluator signature', async () => {
    const bad = { ...onnxDescriptor, inputs: [{ name: 'obs', shape: [1, 8], dtype: 'float32' as const }] };
    await expect(JsMlpNpc.load(bad, onnxBytes)).rejects.toThrow(/declares "obs" as float32 \[1, 8\]/);
  });
});

/**
 * A tiny ONNX writer: the court model rebuilt around its own six weights (copied byte for byte),
 * with its graph or inputs/outputs changed one thing at a time.
 */
interface OnnxNode { op: string; inputs: string[]; outputs: string[]; ints?: Record<string, number>; floats?: Record<string, number> }
interface OnnxValue { name: string; elem?: number; dims: number[] }

const Onnx = (() => {
  const cat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) out.set(p, (o += p.length) - p.length);
    return out;
  };
  const varint = (n: number): Uint8Array => {
    const b: number[] = [];
    do {
      b.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
      n >>>= 7;
    } while (n > 0);
    return Uint8Array.from(b);
  };
  const key = (no: number, wire: number): Uint8Array => varint((no << 3) | wire);
  const int = (no: number, n: number): Uint8Array => cat([key(no, 0), varint(n)]);
  const bytes = (no: number, b: Uint8Array): Uint8Array => cat([key(no, 2), varint(b.length), b]);
  const text = (no: number, s: string): Uint8Array => bytes(no, new TextEncoder().encode(s));
  const msg = (no: number, parts: Uint8Array[]): Uint8Array => bytes(no, cat(parts));
  const f32 = (no: number, x: number): Uint8Array => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, x, true);
    return cat([key(no, 5), b]);
  };

  /** The initializers (TensorProto, field 5 of the graph) of a model, verbatim. */
  const initializers = (model: Uint8Array): Uint8Array[] => {
    const out: Uint8Array[] = [];
    const fields = (s: number, e: number, visit: (no: number, vs: number, ve: number) => void): void => {
      let p = s;
      while (p < e) {
        let t = 0, sh = 0, x: number;
        do { x = model[p++]!; t |= (x & 0x7f) << sh; sh += 7; } while (x & 0x80);
        if ((t & 7) === 0) { do { x = model[p++]!; } while (x & 0x80); continue; }
        let len = 0;
        sh = 0;
        do { x = model[p++]!; len |= (x & 0x7f) << sh; sh += 7; } while (x & 0x80);
        visit(t >> 3, p, p + len);
        p += len;
      }
    };
    fields(0, model.length, (no, vs, ve) => {
      if (no === 7) fields(vs, ve, (gno, gs, ge) => { if (gno === 5) out.push(bytes(5, model.subarray(gs, ge))); });
    });
    return out;
  };

  const node = (n: OnnxNode): Uint8Array => msg(1, [
    ...n.inputs.map((s) => text(1, s)),
    ...n.outputs.map((s) => text(2, s)),
    text(4, n.op),
    ...Object.entries(n.ints ?? {}).map(([name, v]) => msg(5, [text(1, name), int(3, v), int(20, 2)])),
    ...Object.entries(n.floats ?? {}).map(([name, v]) => msg(5, [text(1, name), f32(2, v), int(20, 1)])),
  ]);
  const value = (no: number, v: OnnxValue): Uint8Array =>
    msg(no, [text(1, v.name), msg(2, [msg(1, [int(1, v.elem ?? 1), msg(2, v.dims.map((d) => msg(1, [int(1, d)])))])])]);

  const COURT: OnnxNode[] = [
    { op: 'Gemm', inputs: ['obs', 'W1', 'b1'], outputs: ['z1'] },
    { op: 'Tanh', inputs: ['z1'], outputs: ['a1'] },
    { op: 'Gemm', inputs: ['a1', 'W2', 'b2'], outputs: ['z2'] },
    { op: 'Tanh', inputs: ['z2'], outputs: ['a2'] },
    { op: 'Gemm', inputs: ['a2', 'W3', 'b3'], outputs: ['action'] },
  ];

  const model = (weights: Uint8Array[], o: { nodes?: OnnxNode[]; inputs?: OnnxValue[]; outputs?: OnnxValue[]; opset?: number } = {}): Uint8Array => {
    const graph = msg(7, [
      ...(o.nodes ?? COURT).map(node),
      text(2, 'rebounder'),
      ...weights,
      ...(o.inputs ?? [{ name: 'obs', dims: [1, 14] }]).map((v) => value(11, v)),
      ...(o.outputs ?? [{ name: 'action', dims: [1, 3] }]).map((v) => value(12, v)),
    ]);
    return cat([int(1, 7), msg(8, [int(2, o.opset ?? 13)]), graph]);
  };

  return { initializers, model, COURT };
})();

describe('js mlp graph check (SPEC §6: graph and signature agree with the descriptor before inference)', () => {
  const weights = Onnx.initializers(onnxBytes);
  const swap = (k: number, n: Partial<OnnxNode>): OnnxNode[] => Onnx.COURT.map((node, i) => (i === k ? { ...node, ...n } : node));

  it('runs the court model, and the same model rebuilt around its weights, identically', async () => {
    expect(weights).toHaveLength(6);
    const original = await JsMlpNpc.load(onnxDescriptor, onnxBytes);
    const rebuilt = await JsMlpNpc.load(onnxDescriptor, Onnx.model(weights));
    const o = obs({ ball: { position: [3, 0.12, -2], velocity: [1, 0, 0] } });
    expect(await rebuilt.update(o, 0.1)).toEqual(await original.update(o, 0.1));
  });

  it('refuses the same weights wired into another graph', async () => {
    const load = (bytes: Uint8Array) => JsMlpNpc.load(onnxDescriptor, bytes);
    await expect(load(Onnx.model(weights, { nodes: swap(1, { op: 'Relu' }) }))).rejects.toThrow(/node 2 \(Relu\) should be Tanh/);
    await expect(load(Onnx.model(weights, { nodes: swap(0, { ints: { transB: 1 } }) }))).rejects.toThrow(/attribute transB = 1/);
    await expect(load(Onnx.model(weights, { nodes: swap(4, { floats: { alpha: 0.5 } }) }))).rejects.toThrow(/attribute alpha = 0.5/);
    await expect(load(Onnx.model(weights, { nodes: swap(2, { inputs: ['a1', 'W3', 'b2'] }) }))).rejects.toThrow(/node 3 \(Gemm\) takes \[a1, W3, b2\], expected \[a1, W2, b2\]/);
    await expect(load(Onnx.model(weights, { nodes: [...Onnx.COURT.slice(0, 4), { op: 'Gemm', inputs: ['a2', 'W3', 'b3'], outputs: ['z3'] }, { op: 'Identity', inputs: ['z3'], outputs: ['action'] }] }))).rejects.toThrow(/has 6 nodes/);
    await expect(load(Onnx.model(weights, { opset: 6 }))).rejects.toThrow(/opset 7 or later \(has 6\)/);
  });

  it('refuses graph inputs and outputs that are not the declared ones', async () => {
    const load = (bytes: Uint8Array) => JsMlpNpc.load(onnxDescriptor, bytes);
    await expect(load(Onnx.model(weights, { inputs: [{ name: 'obs', dims: [1, 10] }] }))).rejects.toThrow(/graph input "obs" \(type 1, \[1, 10\]\) does not match the declared "obs" float32 \[1, 14\]/);
    await expect(load(Onnx.model(weights, { inputs: [{ name: 'obs', elem: 11, dims: [1, 14] }] }))).rejects.toThrow(/graph input "obs" \(type 11/);
    await expect(load(Onnx.model(weights, { inputs: [{ name: 'obs', dims: [1, 14] }, { name: 'extra', dims: [1, 1] }] }))).rejects.toThrow(/has 2 inputs/);
    const renamed = Onnx.COURT.map((n, i) => (i === 4 ? { ...n, outputs: ['act'] } : n));
    await expect(load(Onnx.model(weights, { nodes: renamed, outputs: [{ name: 'act', dims: [1, 3] }] }))).rejects.toThrow(/graph output "act"/);
    await expect(load(Onnx.model(weights, { outputs: [{ name: 'action', dims: [1, 4] }] }))).rejects.toThrow(/graph output "action" \(type 1, \[1, 4\]\)/);
  });

  it('a world whose onnx graph is not the evaluator\'s plays its rules twin instead', async () => {
    const manifest = {
      wgif: '0.1' as const, id: 'test.world.graph', title: 'Graph check', creator: { name: 'Galactic AI Team' }, created: '2026-11-22T00:00:00Z', mode: 'editable' as const,
      entry: { scene: 'world.glb', preview: 'preview.png' }, models: [onnxDescriptor, rulesDescriptor], requires: ['scene.glb', 'runtime.rules'],
    };
    const files = {
      'world.glb': utf8('glTF-fake-binary'), 'preview.png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      'models/rebounder.rules.json': rulesBytes, 'models/rebounder-mlp.onnx': Onnx.model(weights, { nodes: swap(3, { op: 'Sigmoid' }) }),
    };
    const loaded = await loadModelFromWorld(await unpackWgif(await packWgif(manifest, files)), 'rebounder');
    expect(loaded.runtime).toBe('rules');
    expect(loaded.usedFallback).toBe(true);
    expect(loaded.warnings.join(' ')).toMatch(/node 4 \(Sigmoid\) should be Tanh/);
  });
});

describe('loading models from a world', () => {
  function worldFiles(extra: WgifFiles = {}): { manifest: Parameters<typeof packWgif>[0]; files: WgifFiles } {
    return {
      manifest: {
        wgif: '0.1',
        id: 'test.world.ai',
        title: 'Test world with AI',
        creator: { name: 'Galactic AI Team' },
        created: '2026-11-15T00:00:00Z',
        mode: 'editable',
        entry: { scene: 'world.glb', preview: 'preview.png' },
        models: [onnxDescriptor, rulesDescriptor],
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

  it('a world with models validates and round-trips', async () => {
    const { manifest, files } = worldFiles();
    const world = await unpackWgif(await packWgif(manifest, files));
    expect(world.report.errors).toEqual([]);
    expect(world.report.ok).toBe(true);
    expect(world.manifest.models?.map((m) => m.id)).toEqual(['rebounder-mlp', 'rebounder-rules']);
  });

  it('loads the onnx model when the runtime is available', async () => {
    const { manifest, files } = worldFiles();
    const world = await unpackWgif(await packWgif(manifest, files));
    const loaded = await loadModelFromWorld(world, 'rebounder');
    expect(loaded.runtime).toBe('onnx');
    expect(loaded.usedFallback).toBe(false);
    const action = await loaded.model.update(obs(), 0.1);
    expect(action.state).toBe('chase');
  });

  it('falls back to the rules twin when the onnx file is corrupt', async () => {
    const { manifest, files } = worldFiles({ 'models/rebounder-mlp.onnx': utf8('not an onnx model') });
    const world = await unpackWgif(await packWgif(manifest, files));
    const loaded = await loadModelFromWorld(world, 'rebounder');
    expect(loaded.runtime).toBe('rules');
    expect(loaded.usedFallback).toBe(true);
    expect(loaded.warnings.length).toBeGreaterThan(0);
    const action = await loaded.model.update(obs(), 0.1);
    expect(action.state).toBe('chase');
  });

  it('falls back to the rules twin when the onnx model has the wrong shape', async () => {
    const wrongShape = new Uint8Array(readFileSync(fileURLToPath(new URL('./fixtures/wrong-output-shape.onnx', import.meta.url))));
    const { manifest, files } = worldFiles({ 'models/rebounder-mlp.onnx': wrongShape });
    const world = await unpackWgif(await packWgif(manifest, files));
    const loaded = await loadModelFromWorld(world, 'rebounder');
    expect(loaded.runtime).toBe('rules');
    expect(loaded.usedFallback).toBe(true);
    expect(loaded.warnings.join(' ')).toMatch(/missing weight "W1"/);
  });

  it('loads rules-first by default on a rules-first world, and onnx when preferred', async () => {
    const { manifest, files } = worldFiles();
    const rulesFirst = { ...manifest, models: [rulesDescriptor, onnxDescriptor] };
    const world = await unpackWgif(await packWgif(rulesFirst, files));
    const byDefault = await loadModelFromWorld(world, 'rebounder');
    expect(byDefault.runtime).toBe('rules');
    expect(byDefault.usedFallback).toBe(false);
    const preferred = await loadModelFromWorld(world, 'rebounder', { preferRuntime: 'onnx' });
    expect(preferred.runtime).toBe('onnx');
    expect(preferred.usedFallback).toBe(false);
  });

  it('falls back to rules when the preferred onnx model cannot load', async () => {
    const { manifest, files } = worldFiles({ 'models/rebounder-mlp.onnx': utf8('not an onnx model') });
    const rulesFirst = { ...manifest, models: [rulesDescriptor, onnxDescriptor] };
    const world = await unpackWgif(await packWgif(rulesFirst, files));
    const loaded = await loadModelFromWorld(world, 'rebounder', { preferRuntime: 'onnx' });
    expect(loaded.runtime).toBe('rules');
    expect(loaded.usedFallback).toBe(true);
    expect(loaded.warnings.length).toBeGreaterThan(0);
  });

  it('loads rules-only worlds, and throws for an unknown purpose', async () => {
    const { manifest, files } = worldFiles();
    const rulesOnly = { ...manifest, models: [rulesDescriptor] };
    const world = await unpackWgif(await packWgif(rulesOnly, files));
    const loaded = await loadModelFromWorld(world, 'rebounder');
    expect(loaded.runtime).toBe('rules');
    await expect(loadModelFromWorld(world, 'crowd')).rejects.toThrow(/no model with purpose/);
  });
});
