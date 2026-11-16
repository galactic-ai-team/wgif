import type { ModelEntry } from '@wgif/format';
import type { NpcAction, NpcModel, NpcObservation, Vec3 } from './types.js';

export class RulesModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesModelError';
  }
}

export const KNOWN_CONDITIONS = [
  'always',
  'ball_loose',
  'ball_held_by_player',
  'ball_held_by_self',
  'ball_near',
  'near_player',
  'near_home',
  'ball_out_of_bounds',
] as const;
export type ConditionName = (typeof KNOWN_CONDITIONS)[number];

export type RulesBehavior =
  | { type: 'move'; target: 'ball' | 'player' | 'home'; speed: string | number }
  | { type: 'hold' }
  | { type: 'pass' };

export interface RulesState {
  description?: string;
  behavior: RulesBehavior;
  on: { when: ConditionName; to: string }[];
}

export interface RulesModel {
  version: string;
  model: string;
  deterministic: boolean;
  seed: number;
  tickHz: number;
  court: { bounds: { min: Vec3; max: Vec3 } };
  params: Record<string, number | Vec3>;
  states: Record<string, RulesState>;
  initialState: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);

function fail(message: string): never {
  throw new RulesModelError(`invalid rules model: ${message}`);
}

/**
 * Parses and validates a rules-model JSON file. Fail-closed: unknown conditions,
 * unknown behaviour types, transitions to missing states, unresolvable speed
 * references and non-deterministic declarations are all load errors, never
 * silent passes. A model that loads is guaranteed to run.
 */
export function parseRulesModel(bytes: Uint8Array): RulesModel {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (e) {
    throw new RulesModelError(`invalid rules model: not valid JSON (${(e as Error).message})`);
  }
  if (!isRecord(raw)) fail('top level must be an object');
  if (typeof raw.version !== 'string' || raw.version.length === 0) fail('version must be a non-empty string');
  if (typeof raw.model !== 'string' || raw.model.length === 0) fail('model must be a non-empty string');
  // Rules models are deterministic by construction (no randomness, no wall clock).
  // A file that claims otherwise is a bug in the file, not a runtime choice.
  if (raw.deterministic !== true) fail('deterministic must be true');
  if (!Number.isInteger(raw.seed) || (raw.seed as number) < 0 || (raw.seed as number) > 4294967295) {
    fail('seed must be a uint32 integer');
  }
  if (!isFiniteNumber(raw.tickHz) || (raw.tickHz as number) < 1 || (raw.tickHz as number) > 60) {
    fail('tickHz must be a number in [1, 60]');
  }
  if (!isRecord(raw.court) || !isRecord(raw.court.bounds) || !isVec3(raw.court.bounds.min) || !isVec3(raw.court.bounds.max)) {
    fail('court.bounds must be { min: vec3, max: vec3 }');
  }
  const { min, max } = raw.court.bounds;
  if (!(min[0] < max[0] && min[2] < max[2] && min[1] <= max[1])) fail('court.bounds min must be below max on x and z');
  if (!isRecord(raw.params)) fail('params must be an object');
  for (const [k, v] of Object.entries(raw.params)) {
    if (!isFiniteNumber(v) && !isVec3(v)) fail(`params.${k} must be a finite number or a vec3`);
  }
  if (!isRecord(raw.states) || Object.keys(raw.states).length === 0) fail('states must be a non-empty object');
  if (typeof raw.initialState !== 'string' || !(raw.initialState in raw.states)) {
    fail('initialState must name one of states');
  }
  const states: Record<string, RulesState> = {};
  for (const [name, s] of Object.entries(raw.states)) {
    if (!isRecord(s)) fail(`states.${name} must be an object`);
    if (!isRecord(s.behavior) || typeof s.behavior.type !== 'string') fail(`states.${name}.behavior.type is required`);
    let behavior: RulesBehavior;
    if (s.behavior.type === 'move') {
      const target = s.behavior.target;
      if (target !== 'ball' && target !== 'player' && target !== 'home') {
        fail(`states.${name}.behavior.target must be "ball", "player" or "home"`);
      }
      const speed = s.behavior.speed;
      if (typeof speed === 'string') {
        const resolved = (raw.params as Record<string, unknown>)[speed];
        if (!isFiniteNumber(resolved)) fail(`states.${name}.behavior.speed "${speed}" is not a numeric param`);
      } else if (!isFiniteNumber(speed) || speed < 0) {
        fail(`states.${name}.behavior.speed must be a param name or a non-negative number`);
      }
      if (target === 'home' && !isVec3((raw.params as Record<string, unknown>).home)) {
        fail(`states.${name} moves to "home" but params.home is not a vec3`);
      }
      behavior = { type: 'move', target, speed: speed as string | number };
    } else if (s.behavior.type === 'hold') {
      behavior = { type: 'hold' };
    } else if (s.behavior.type === 'pass') {
      behavior = { type: 'pass' };
    } else {
      fail(`states.${name}.behavior.type "${s.behavior.type}" is unknown (want move, hold or pass)`);
    }
    if (!Array.isArray(s.on)) fail(`states.${name}.on must be an array`);
    const on: { when: ConditionName; to: string }[] = [];
    for (const t of s.on as unknown[]) {
      if (!isRecord(t) || typeof t.when !== 'string' || typeof t.to !== 'string') {
        fail(`states.${name}.on entries must be { when, to }`);
      }
      if (!(KNOWN_CONDITIONS as readonly string[]).includes(t.when)) {
        fail(`states.${name}.on when "${t.when}" is unknown (want one of ${KNOWN_CONDITIONS.join(', ')})`);
      }
      if (!(t.to in (raw.states as Record<string, unknown>))) {
        fail(`states.${name}.on to "${t.to}" is not a state`);
      }
      on.push({ when: t.when as ConditionName, to: t.to });
    }
    states[name] = { ...(typeof s.description === 'string' ? { description: s.description } : {}), behavior, on };
  }
  return {
    version: raw.version,
    model: raw.model,
    deterministic: true,
    seed: raw.seed as number,
    tickHz: raw.tickHz as number,
    court: { bounds: { min, max } },
    params: raw.params as Record<string, number | Vec3>,
    states,
    initialState: raw.initialState,
  };
}

/** Shared observation validation: observations must be finite, or the tick is a bug, not noise. */
export function validateObservation(obs: NpcObservation): void {
  const bad = (what: string): never => {
    throw new RulesModelError(`invalid observation: ${what} must be finite numbers`);
  };
  if (!isFiniteNumber(obs.timeSec) || obs.timeSec < 0) bad('timeSec');
  for (const [label, v] of [
    ['ball.position', obs.ball.position],
    ['ball.velocity', obs.ball.velocity],
    ['player.position', obs.player.position],
    ['self.position', obs.self.position],
  ] as const) {
    if (!isVec3(v)) bad(label);
  }
  if (obs.ball.heldBy !== null && obs.ball.heldBy !== 'player' && obs.ball.heldBy !== 'rebounder') {
    throw new RulesModelError('invalid observation: ball.heldBy must be "player", "rebounder" or null');
  }
}

function clampToBounds(p: Vec3, min: Vec3, max: Vec3): Vec3 {
  return [
    Math.min(Math.max(p[0], min[0]), max[0]),
    p[1],
    Math.min(Math.max(p[2], min[2]), max[2]),
  ];
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

interface EvalContext {
  ballDist: number;
  playerDist: number;
  homeDist: number;
  ballOutOfBounds: boolean;
  home: Vec3;
  pickupRadius: number;
  passRadius: number;
}

function context(obs: NpcObservation, rules: RulesModel): EvalContext {
  const { min, max } = rules.court.bounds;
  const home = rules.params.home as Vec3;
  const pickupRadius = rules.params.pickupRadius;
  const passRadius = rules.params.passRadius;
  return {
    ballDist: dist3(obs.self.position, obs.ball.position),
    playerDist: dist3(obs.self.position, obs.player.position),
    homeDist: dist3(obs.self.position, home),
    ballOutOfBounds:
      obs.ball.position[0] < min[0] || obs.ball.position[0] > max[0] || obs.ball.position[2] < min[2] || obs.ball.position[2] > max[2],
    home,
    pickupRadius: typeof pickupRadius === 'number' ? pickupRadius : 0.45,
    passRadius: typeof passRadius === 'number' ? passRadius : 1.6,
  };
}

function evaluateCondition(when: ConditionName, obs: NpcObservation, ctx: EvalContext): boolean {
  switch (when) {
    case 'always':
      return true;
    case 'ball_loose':
      return obs.ball.heldBy === null;
    case 'ball_held_by_player':
      return obs.ball.heldBy === 'player';
    case 'ball_held_by_self':
      return obs.ball.heldBy === 'rebounder';
    case 'ball_near':
      return ctx.ballDist <= ctx.pickupRadius;
    case 'near_player':
      return ctx.playerDist <= ctx.passRadius;
    case 'near_home':
      return ctx.homeDist <= 0.5;
    case 'ball_out_of_bounds':
      return ctx.ballOutOfBounds;
  }
}

function holdingIn(state: string): boolean {
  return state === 'pickup' || state === 'carry';
}

/**
 * The rules NPC: a pure deterministic interpreter for a rules-model file.
 * No randomness, no wall clock, no I/O. `update` takes the world as it is and
 * returns what the NPC does this tick; the caller owns positions and physics.
 */
export class RulesNpc implements NpcModel {
  readonly id: string;
  readonly runtime = 'rules' as const;
  readonly descriptor: ModelEntry;
  readonly rules: RulesModel;
  private current: string;

  constructor(descriptor: ModelEntry, rules: RulesModel) {
    this.descriptor = descriptor;
    this.rules = rules;
    this.id = descriptor.id;
    this.current = rules.initialState;
  }

  get state(): string {
    return this.current;
  }

  reset(): void {
    this.current = this.rules.initialState;
  }

  async update(obs: NpcObservation, dt: number): Promise<NpcAction> {
    validateObservation(obs);
    if (!isFiniteNumber(dt) || dt < 0) {
      throw new RulesModelError('invalid tick: dt must be a finite number >= 0');
    }
    const ctx = context(obs, this.rules);
    const from = this.rules.states[this.current]!;
    // Transitions are evaluated in file order; the first matching one wins.
    // At most one transition per tick, so a state is never skipped.
    let next = this.current;
    for (const t of from.on) {
      if (evaluateCondition(t.when, obs, ctx)) {
        next = t.to;
        break;
      }
    }
    this.current = next;
    const def = this.rules.states[next]!;
    const holdingBall = holdingIn(next);
    if (def.behavior.type === 'hold') {
      return { state: next, velocity: [0, 0, 0], passBall: false, holdingBall, target: null };
    }
    if (def.behavior.type === 'pass') {
      return { state: next, velocity: [0, 0, 0], passBall: true, holdingBall: false, target: obs.player.position };
    }
    // move: head for the target in the xz plane at the behaviour's speed.
    // The ball target is clamped to the court so the NPC waits at the boundary
    // instead of walking through the wall after a ball that rolled out.
    const { min, max } = this.rules.court.bounds;
    const rawTarget =
      def.behavior.target === 'ball'
        ? obs.ball.position
        : def.behavior.target === 'player'
          ? obs.player.position
          : ctx.home;
    const target = def.behavior.target === 'ball' ? clampToBounds(rawTarget, min, max) : rawTarget;
    const dx = target[0] - obs.self.position[0];
    const dz = target[2] - obs.self.position[2];
    const dist = Math.hypot(dx, dz);
    const arriveRadius = this.rules.params.arriveRadius;
    const arrive = typeof arriveRadius === 'number' ? arriveRadius : 0.05;
    const speed =
      typeof def.behavior.speed === 'string' ? (this.rules.params[def.behavior.speed] as number) : def.behavior.speed;
    if (dist <= arrive || speed <= 0) {
      return { state: next, velocity: [0, 0, 0], passBall: false, holdingBall, target };
    }
    let vx = (dx / dist) * speed;
    let vz = (dz / dist) * speed;
    // Never point out of the court from the wall itself: the caller integrates
    // this velocity, and a step past the boundary is the caller's bug to catch,
    // but the model must not ask for it. Sliding along the wall stays allowed.
    if (obs.self.position[0] <= min[0] && vx < 0) vx = 0;
    if (obs.self.position[0] >= max[0] && vx > 0) vx = 0;
    if (obs.self.position[2] <= min[2] && vz < 0) vz = 0;
    if (obs.self.position[2] >= max[2] && vz > 0) vz = 0;
    return {
      state: next,
      velocity: [vx, 0, vz],
      passBall: false,
      holdingBall,
      target,
    };
  }
}

/** Loads a rules model from its file bytes, validated fail-closed. */
export function loadRulesModel(descriptor: ModelEntry, bytes: Uint8Array): RulesNpc {
  return new RulesNpc(descriptor, parseRulesModel(bytes));
}
