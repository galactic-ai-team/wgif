import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  JsMlpNpc,
  loadRulesModel,
  type ModelEntry,
  type NpcAction,
  type NpcObservation,
  type Vec3,
} from '../src/index.js';

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

/**
 * The court's two rebounder models, run side by side on one fixed shot grid.
 *
 * The grid is 200 observations sampled from the input space the NPC actually
 * sees around a shot, all drawn from a seeded PRNG (seed 7, the lane's seed)
 * so the measurement is exactly reproducible:
 *
 *   A  90  shot in flight — ball airborne, velocity toward the rim
 *   B  60  loose after the miss — 20 with the NPC inside pickup range
 *       (0.45 m) of the ball, 40 farther away
 *   C  30  held — 15 by the player (pre-shot), 15 by the rebounder
 *       (post-pickup; half of those near the player, a pass)
 *   D  20  out of bounds — ball clearly past a wall (0.6–2 m), NPC at it
 *
 * Agreement per input is behavioural: velocity direction (cosine > 0.9, or
 * both models ~still), passBall equal, and holdingBall equal. The state is
 * compared separately under the vocabulary mapping below, because the ONNX
 * model has no `idle` or `pickup` state: it reports `chase` where the rules
 * model waits at home and `carry` where the rules model picks the ball up.
 *
 * Two conventions are pinned, not papered over:
 *
 * - On a pass tick, holdingBall is not compared. The rules model's pass
 *   behaviour reports the ball as released (holdingBall false) while the
 *   ONNX model reports the pre-pass observation (holdingBall true). Both
 *   models agree passBall is true on that tick; the game acts on passBall.
 * - Phase D keeps the ball clearly out of bounds. A ball that is both
 *   within pickup range AND out of bounds (e.g. 0.3 m past the wall) hits
 *   a rules-machine ordering edge — `ball_near` is checked before
 *   `ball_out_of_bounds` in the chase state, so the rules model picks it
 *   up while the ONNX model does not. That edge is real and uncovered by
 *   this grid; it needs a rules-file decision, not a grid sample.
 */

const GRID_SEED = 7;
const GRID_SIZE = 200;
const RIM: Vec3 = [12.425, 3.05, 0];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GridInput {
  phase: string;
  obs: NpcObservation;
}

type AgreementCounts = { velocity: number; pass: number; holding: number; state: number; composite: number };

function buildShotGrid(seed: number): GridInput[] {
  const rnd = mulberry32(seed);
  const range = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)] as T;
  const out: GridInput[] = [];
  let t = 0;
  const obs = (ball: NpcObservation['ball'], player: Vec3, self: Vec3): NpcObservation => ({
    timeSec: (t += 0.1),
    ball,
    player: { position: player },
    self: { position: self },
  });
  const courtSelf = (): Vec3 => [range(-14, 14), 0, range(-8, 8)];
  const courtPlayer = (): Vec3 => [range(-14, 14), 0, range(-8, 8)];

  // A — shot in flight (90): ball airborne, velocity toward the rim.
  for (let i = 0; i < 90; i++) {
    const ballPos: Vec3 = [range(6, 14), range(1.5, 4), range(-4, 4)];
    const dx = RIM[0] - ballPos[0] + range(-2, 2);
    const dz = RIM[2] - ballPos[2] + range(-2, 2);
    const len = Math.hypot(dx, dz) || 1;
    const speed = range(3, 8);
    out.push({
      phase: 'A-flight',
      obs: obs(
        { position: ballPos, velocity: [(dx / len) * speed, range(-1, 1), (dz / len) * speed], heldBy: null },
        [range(6, 10), 0, range(-3, 3)],
        courtSelf(),
      ),
    });
  }

  // B — loose after the miss (60): 20 near the NPC (pickup range), 40 far.
  for (let i = 0; i < 60; i++) {
    const near = i < 20;
    const ballPos: Vec3 = [range(-14, 16), 0.12, range(-8, 8)];
    const rolling = rnd() < 0.5;
    const angle = range(0, Math.PI * 2);
    const rollSpeed = rolling ? range(0.2, 2) : 0;
    let self: Vec3;
    if (near) {
      const h = range(0.05, 0.4);
      self = [ballPos[0] + Math.cos(angle) * h, 0, ballPos[2] + Math.sin(angle) * h];
    } else {
      do {
        self = courtSelf();
      } while (Math.hypot(self[0] - ballPos[0], self[2] - ballPos[2]) < 2);
    }
    out.push({
      phase: near ? 'B-loose-near' : 'B-loose-far',
      obs: obs(
        { position: ballPos, velocity: [Math.cos(angle) * rollSpeed, 0, Math.sin(angle) * rollSpeed], heldBy: null },
        courtPlayer(),
        self,
      ),
    });
  }

  // C — held (30): 15 by the player (pre-shot), 15 by the rebounder (post-pickup).
  for (let i = 0; i < 30; i++) {
    const bySelf = i >= 15;
    const player: Vec3 = [range(6, 10), 0, range(-3, 3)];
    const self = courtSelf();
    let ballPos: Vec3;
    if (bySelf) {
      ballPos = [self[0], 0.9, self[2]];
      // Half the self-held cases are near the player (a pass), half far.
      if (i % 2 === 0) {
        const a = range(0, Math.PI * 2);
        const d = range(0.5, 1.5);
        player[0] = self[0] + Math.cos(a) * d;
        player[2] = self[2] + Math.sin(a) * d;
      }
    } else {
      ballPos = [player[0], 0.9, player[2]];
    }
    out.push({
      phase: bySelf ? 'C-held-self' : 'C-held-player',
      obs: obs({ position: ballPos, velocity: [0, 0, 0], heldBy: bySelf ? 'rebounder' : 'player' }, player, self),
    });
  }

  // D — out of bounds (20): ball clearly past a wall, NPC at the wall.
  for (let i = 0; i < 20; i++) {
    const side = pick(['+x', '-x', '+z', '-z'] as const);
    let ballPos: Vec3;
    let self: Vec3;
    if (side === '+x') {
      ballPos = [range(17.6, 19), 0.12, range(-8, 8)];
      self = [17, 0, ballPos[2]];
    } else if (side === '-x') {
      ballPos = [range(-19, -17.6), 0.12, range(-8, 8)];
      self = [-17, 0, ballPos[2]];
    } else if (side === '+z') {
      ballPos = [range(-14, 14), 0.12, range(10.6, 12)];
      self = [ballPos[0], 0, 10];
    } else {
      ballPos = [range(-14, 14), 0.12, range(-12, -10.6)];
      self = [ballPos[0], 0, -10];
    }
    out.push({
      phase: 'D-out-of-bounds',
      obs: obs({ position: ballPos, velocity: [0, 0, 0], heldBy: null }, courtPlayer(), self),
    });
  }
  return out;
}

function velocityAgrees(a: NpcAction, b: NpcAction): boolean {
  const ma = Math.hypot(a.velocity[0], a.velocity[2]);
  const mb = Math.hypot(b.velocity[0], b.velocity[2]);
  if (Math.max(ma, mb) <= 0.1) return true;
  if (ma <= 0.1 || mb <= 0.1) return false;
  return (a.velocity[0] * b.velocity[0] + a.velocity[2] * b.velocity[2]) / (ma * mb) > 0.9;
}

/** The ONNX model has no `idle` or `pickup` state; map the rules vocabulary onto it. */
function mappedState(state: string): string {
  if (state === 'pickup') return 'carry';
  if (state === 'idle') return 'chase';
  return state;
}

async function runGrid(
  grid: GridInput[],
): Promise<{ actions: { rules: NpcAction; onnx: NpcAction }[]; counts: AgreementCounts }> {
  const rules = loadRulesModel(rulesDescriptor, rulesBytes);
  const mlp = await JsMlpNpc.load(onnxDescriptor, onnxBytes);
  const actions: { rules: NpcAction; onnx: NpcAction }[] = [];
  const counts: AgreementCounts = {
    composite: 0,
    velocity: 0,
    pass: 0,
    holding: 0,
    state: 0,
  };
  for (const { obs } of grid) {
    // The rules model is a state machine: prime it with one tick on the
    // observation, then read the settled second-tick action (the same
    // pattern the per-case agreement tests use). The ONNX model is
    // stateless, so one update is its answer.
    rules.reset();
    await rules.update(obs, 0.1);
    const r = await rules.update(obs, 0.1);
    const m = await mlp.update(obs, 0.1);
    const v = velocityAgrees(r, m);
    const p = r.passBall === m.passBall;
    // On a pass tick holdingBall is a convention, not behaviour: the rules
    // model reports the ball released, the ONNX model the pre-pass
    // observation. Both agree passBall is true; do not count it.
    const passTick = r.passBall || m.passBall;
    const h = passTick || r.holdingBall === m.holdingBall;
    const s = mappedState(r.state) === m.state;
    if (v) counts.velocity++;
    if (p) counts.pass++;
    if (h) counts.holding++;
    if (s) counts.state++;
    if (v && p && h) counts.composite++;
    actions.push({ rules: r, onnx: m });
  }
  return { actions, counts };
}

describe('rules twin vs JS MLP on the seeded shot grid', () => {
  it('agrees on the 200-input grid at the honest rate, and reports the measured %', async () => {
    const grid = buildShotGrid(GRID_SEED);
    expect(grid).toHaveLength(GRID_SIZE);
    const phases = grid.reduce<Record<string, number>>(
      (m, g) => ({ ...m, [g.phase]: (m[g.phase] ?? 0) + 1 }),
      {},
    );
    expect(phases).toEqual({
      'A-flight': 90,
      'B-loose-near': 20,
      'B-loose-far': 40,
      'C-held-player': 15,
      'C-held-self': 15,
      'D-out-of-bounds': 20,
    });

    const { counts } = await runGrid(grid);
    const pct = (n: number): string => `${((n / GRID_SIZE) * 100).toFixed(1)}%`;
    // Printed so the CI log carries the measurement, not just the verdict.
    console.log(
      `agreement on the ${GRID_SIZE}-input shot grid (seed ${GRID_SEED}): ` +
        `composite ${counts.composite}/${GRID_SIZE} (${pct(counts.composite)}), ` +
        `velocity ${pct(counts.velocity)}, passBall ${pct(counts.pass)}, ` +
        `holdingBall ${pct(counts.holding)}, mapped state ${pct(counts.state)}`,
    );
    // Measured on dev 4e94e48, Nov 16 2026 (PR #29 landed the ONNX-live
    // pickup fix): composite 88.5%, velocity 88.5%, passBall 100%,
    // holdingBall 100%, mapped state 100%. The floors sit a few points under
    // the measurement. holdingBall and mapped state went to 100% because the
    // JS MLP now asserts holdingBall on a loose ball within pickup range —
    // the fix works. The composite is still gated by velocity on the 20
    // B-loose-near inputs: the rules model stands still on the pickup tick
    // (velocity 0) while the stateless ONNX clone outputs the network's
    // toward-ball velocity. That is a limitation of the stateless clone, not
    // a missing fix — the same observation maps to chase-velocity on one tick
    // and pickup-stand-still on the next, depending on hidden state. Zeroing
    // the evaluator's velocity when it asserts a pickup would close it, but
    // that is a behaviour change to the live game, not a floor change.
    expect(counts.composite / GRID_SIZE).toBeGreaterThanOrEqual(0.86);
    expect(counts.state / GRID_SIZE).toBeGreaterThanOrEqual(0.97);
    expect(counts.pass / GRID_SIZE).toBeGreaterThanOrEqual(0.98);
  });

  it('replays deterministically: same seed, same grid, same outputs', async () => {
    const gridA = buildShotGrid(GRID_SEED);
    const gridB = buildShotGrid(GRID_SEED);
    expect(gridB).toEqual(gridA);

    const runA = await runGrid(gridA);
    const runB = await runGrid(gridB);
    expect(runB.actions).toEqual(runA.actions);
    expect(runB.counts).toEqual(runA.counts);
  });
});
