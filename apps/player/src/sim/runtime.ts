import { BASKETBALL_SHOOTING, PAYLOAD_VERSION, emptyState, type GameState, type Interactions, type ShootingRules, type TriggerDef } from '../interactions.js';
import { BallReturnAgent, type AgentBody, type AgentObject, type AgentShot, type AgentWorld, type WorldAgent } from './agents.js';
import { GRAVITY, ballisticVelocity, newBall, stepBall, wake, type BallHooks, type BallParams, type BallState } from './ball.js';
import { LAYER_ALL, LAYER_SOLID, newRayHit, type StaticColliders } from './colliders.js';
import { COUNTDOWN_SEC, Shootout, type ShootoutSignal } from './shootout.js';
import { CylinderTrigger } from './trigger.js';
import { addScaled, clamp, copy, distance, horizontalDistance, type Vec3 } from './vec.js';
import { Walker, type Bounds } from './walker.js';

/**
 * The simulation of one open world: the walker, the grabbable objects, triggers, the Shootout
 * minigame and the NPC agents, all driven by the world's declarative interactions.json.
 *
 * It runs on a fixed 120 Hz tick and uses no clock, DOM or randomness of its own, so the same
 * inputs always give the same game. The viewer feeds it input and draws what it finds here.
 */
export const TICK = 1 / 120;
const MAX_TICKS_PER_FRAME = 12;
/** Seconds of holding the shoot button to go from no power to full power (then it swings back down). */
export const CHARGE_SEC = 1.6;
export const MIN_SHOT_SPEED = 3;
export const MAX_SHOT_SPEED = 14.5;
/**
 * Shots leave this far above the line of sight. With 40° of loft, looking straight at a rim gives
 * an arc steep enough to drop through it from anywhere on the court, so aiming is "look at the hoop".
 */
export const SHOT_LOFT = (40 * Math.PI) / 180;
const MAX_LAUNCH_ELEVATION = (85 * Math.PI) / 180;
/**
 * Aim assist. When a shot is already nearly right (heading within `angle` of a rim and speed within
 * `speed` of what a make needs), `strength` of the remaining error is taken out. Close shots still
 * rattle or miss; hopeless ones are untouched. Pass `assist: false` to the runtime for raw physics.
 */
export interface AimAssist {
  speed: number;
  angle: number;
  strength: number;
}
export const DEFAULT_ASSIST: AimAssist = { speed: 0.1, angle: (5 * Math.PI) / 180, strength: 0.85 };
/** A shot has to come down at least this steeply (tangent of the angle) to fit through a rim. */
const MIN_DESCENT = 0.75;
const GRAB_REACH = 1.8;
const CATCH_RADIUS = 0.9;
const OUT_OF_WORLD = 20;
/** A ball resting further than this outside the play area cannot be reached and goes back to its spawn. */
const REACH_MARGIN = 1.2;
const ARC_STEP = 0.05;

export interface PlayerInput {
  forward: number;
  right: number;
  run: boolean;
  /** The shoot button is down. Press to start charging, release to shoot. */
  charging: boolean;
}

export const IDLE_INPUT: Readonly<PlayerInput> = Object.freeze({ forward: 0, right: 0, run: false, charging: false });

export type RuntimeEvent =
  | { type: 'bounce'; object: string; surface: string; speed: number }
  | { type: 'grab'; object: string; by: 'player' | 'agent' }
  | { type: 'drop'; object: string }
  | { type: 'shot'; object: string; power: number }
  | { type: 'score'; object: string; trigger: string; points: number; three: boolean; swish: boolean; counted: boolean }
  | { type: 'trigger'; trigger: string; event: string; object: string }
  | { type: 'reset'; object: string }
  | { type: 'shootout'; signal: ShootoutSignal }
  /** Something worth saving changed: a high score, or where an object came to rest. */
  | { type: 'state' }
  | { type: 'custom'; name: string; detail: unknown };

interface Shot {
  releasedAt: number;
  /** Where the shooter stood, for the three-point rule. */
  from: Vec3;
  /** Released while the Shootout clock was running. */
  live: boolean;
  scoredAt: number | null;
  groundedAt: number | null;
  /** Nothing touched yet: a basket now is a swish. */
  clean: boolean;
  done: boolean;
}

export interface Grabbable {
  readonly id: string;
  readonly node: string | null;
  readonly params: BallParams;
  readonly body: BallState;
  /** Position one tick ago, for smooth drawing between ticks. */
  readonly prev: Vec3;
  spawn: Vec3;
  held: boolean;
  /** Where it last lay still. This is what gets saved. */
  lastRest: Vec3;
}

interface Tracked extends Grabbable {
  shot: Shot | null;
  /** Role of the agent carrying it, if any. A carried object is out of physics, like a held one. */
  carrier: string | null;
  incomingSince: number | null;
  wasResting: boolean;
  triggers: { def: TriggerDef; trigger: CylinderTrigger }[];
  view: AgentObject;
}

export interface RuntimeOptions {
  interactions: Interactions;
  colliders: StaticColliders;
  /** Saved or initial game state: high scores and object positions. */
  state?: GameState;
  /** Eye position and look target from the manifest. Falls back to interactions.json, then a default. */
  spawn?: { position: Vec3; lookAt?: Vec3 } | null;
  /** World position of a scene node, for objects that do not declare a spawn. */
  nodePosition?: (node: string) => Vec3 | null;
  /** Aim assist settings, or false for none. */
  assist?: AimAssist | false;
  seed?: number;
}

/** The shot the game will take for a given power: where it leaves the hands, how fast, and whether assist engaged. */
export interface PlannedShot {
  origin: Vec3;
  velocity: Vec3;
  locked: boolean;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ray = newRayHit();
// Scratch vectors for carry(), which runs every frame.
const carryE: Vec3 = [0, 0, 0], carryF: Vec3 = [0, 0, 0], carryR: Vec3 = [0, 0, 0], carryU: Vec3 = [0, 0, 0];

export class WorldRuntime {
  readonly colliders: StaticColliders;
  readonly player: Walker;
  readonly shootout: Shootout | null;
  readonly events: RuntimeEvent[] = [];
  /** Simulated seconds and ticks since the world opened. */
  time = 0;
  tick = 0;
  /** Id of the object in the player's hands. */
  held: string | null = null;
  /** Shot power while charging, 0..1. */
  power = 0;
  charging = false;
  /** False while the camera orbits: the walker stands still and cannot grab or shoot. */
  playerEnabled = true;
  /** False while editing: NPCs stand still so things stay where the editor puts them. */
  agentsEnabled = true;
  /** How far the current frame is between the last two ticks, 0..1. */
  alpha = 1;
  /** Set by aimArc(): aim assist would correct a shot released now. */
  aimLocked = false;
  /** Bodies of the agents that have one, for the viewer to draw. */
  bodies: readonly { role: string; body: AgentBody }[] = [];

  private readonly tracked = new Map<string, Tracked>();
  private readonly agents = new Map<string, WorldAgent>();
  private readonly signals: ShootoutSignal[] = [];
  private readonly view: AgentWorld;
  private readonly hooks: BallHooks;
  private readonly random: () => number;
  private readonly assist: AimAssist | null;
  private spawnPoint: { position: Vec3; lookAt: Vec3 | null };
  private current: Tracked | null = null;
  private currentAgent: WorldAgent | null = null;
  private readonly bounds: Bounds | null;
  private accumulator = 0;
  private chargeTime = 0;
  private prevCharging = false;

  constructor(opts: RuntimeOptions) {
    const { interactions, colliders } = opts;
    this.colliders = colliders;
    this.random = mulberry32(opts.seed ?? 1);
    this.assist = opts.assist === false ? null : (opts.assist ?? DEFAULT_ASSIST);
    this.bounds = interactions.camera.bounds;
    this.player = new Walker(colliders, { eyeHeight: interactions.camera.firstPersonHeight, bounds: this.bounds });
    this.spawnPoint = {
      position: opts.spawn?.position ?? interactions.camera.spawn ?? [0, interactions.camera.firstPersonHeight, 8],
      lookAt: opts.spawn?.lookAt ?? interactions.camera.lookAt ?? null,
    };
    this.respawnPlayer();

    const state = opts.state ?? emptyState();
    const triggerDefs = interactions.objects.filter((o): o is TriggerDef => o.kind === 'trigger');
    for (const def of interactions.objects) {
      if (def.kind !== 'grabbable') continue;
      const spawn = def.spawn ?? opts.nodePosition?.(def.node ?? def.id) ?? [0, def.physics.radius, 0];
      const start = state.objects[def.id]?.position ?? spawn;
      const item: Tracked = {
        id: def.id,
        node: def.node,
        params: { radius: def.physics.radius, restitution: def.physics.restitution, friction: def.physics.friction },
        body: newBall(start),
        prev: copy(start),
        spawn: copy(spawn),
        held: false,
        lastRest: copy(start),
        shot: null,
        carrier: null,
        incomingSince: null,
        wasResting: false,
        triggers: triggerDefs
          .filter((t) => t.enterFromAbove && (t.enterFromAbove.target === null || t.enterFromAbove.target === def.id))
          .map((t) => ({ def: t, trigger: new CylinderTrigger(t.id, t.shape) })),
        view: null as unknown as AgentObject,
      };
      item.view = this.objectView(item);
      this.tracked.set(def.id, item);
    }

    const game = interactions.minigames.find((m) => m.type === BASKETBALL_SHOOTING && this.tracked.has(m.ball));
    this.shootout = game ? new Shootout(game, state.minigames[game.id]) : null;
    if (this.shootout) this.setAgent(new BallReturnAgent());
    this.hooks = { onBounce: (group, speed) => this.onBounce(group, speed), onMove: (a, b) => this.onMove(a, b) };
    this.view = this.agentWorld();
  }

  get objects(): ReadonlyMap<string, Grabbable> {
    return this.tracked;
  }

  /** Advances the world by a frame's worth of real time. Returns the number of fixed ticks it ran. */
  update(dt: number, input: PlayerInput): number {
    const step = clamp(dt, 0, 0.1);
    // The walker moves with the frame so the camera never stutters; everything else is fixed-tick.
    if (this.playerEnabled) this.player.step(step, input);
    this.accumulator += step;
    let ticks = 0;
    while (this.accumulator >= TICK && ticks < MAX_TICKS_PER_FRAME) {
      this.tickWorld(input);
      this.accumulator -= TICK;
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_FRAME) this.accumulator = 0;
    this.alpha = this.accumulator / TICK;
    this.carry();
    return ticks;
  }

  /** Advances exactly one tick, walker included. Tests and replays use this. */
  step(input: PlayerInput = IDLE_INPUT): void {
    if (this.playerEnabled) this.player.step(TICK, input);
    this.tickWorld(input);
    this.alpha = 1;
    this.carry();
  }

  /** Takes the events raised since the last call. */
  drain(): RuntimeEvent[] {
    return this.events.splice(0, this.events.length);
  }

  // ---- player actions -------------------------------------------------------------------------

  /** Id of the object the player could pick up right now, or null. */
  canGrab(): string | null {
    if (this.held || !this.playerEnabled) return null;
    let best: Tracked | null = null, bestD = Infinity;
    for (const o of this.tracked.values()) {
      if (o.carrier) continue;
      const d = horizontalDistance(o.body.pos, this.player.feet);
      if (d <= GRAB_REACH && Math.abs(o.body.pos[1] - (this.player.feet[1] + 1)) <= 1.6 && d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best?.id ?? null;
  }

  grab(): boolean {
    const id = this.canGrab();
    const o = id ? this.tracked.get(id) : undefined;
    if (!o) return false;
    this.hold(o, 'player');
    // The press that picked the ball up is not also the start of a shot: it has to be let go first.
    this.prevCharging = true;
    return true;
  }

  /** Lets go of the held object without shooting it. */
  drop(): boolean {
    const o = this.held ? this.tracked.get(this.held) : undefined;
    if (!o) return false;
    const f = this.player.forward;
    this.release(o);
    o.body.vel[0] = f[0] * 1.2; o.body.vel[1] = 0.6; o.body.vel[2] = f[2] * 1.2;
    this.events.push({ type: 'drop', object: o.id });
    return true;
  }

  /** Shoots the held object with a power of 0..1. Normally called by releasing the shoot button. */
  shoot(power: number): boolean {
    const o = this.held ? this.tracked.get(this.held) : undefined;
    if (!o || this.shootout?.phase === 'countdown') return false;
    const p = clamp(power, 0, 1);
    const { origin, velocity } = this.plannedShot(p, o);
    this.release(o);
    o.body.pos[0] = origin[0]; o.body.pos[1] = origin[1]; o.body.pos[2] = origin[2];
    o.prev[0] = origin[0]; o.prev[1] = origin[1]; o.prev[2] = origin[2];
    o.body.vel[0] = velocity[0]; o.body.vel[1] = velocity[1]; o.body.vel[2] = velocity[2];
    const live = !!this.shootout && this.shootout.live && this.shootout.def.ball === o.id;
    o.shot = { releasedAt: this.time, from: copy(this.player.feet), live, scoredAt: null, groundedAt: null, clean: true, done: false };
    for (const t of o.triggers) t.trigger.reset();
    if (live) this.shootout?.shot();
    this.events.push({ type: 'shot', object: o.id, power: p });
    return true;
  }

  /** Where a shot leaves the hands: just ahead of the eyes, pulled back if a wall is in the way. */
  releasePoint(radius = 0.12): Vec3 {
    const e = this.player.eye, f = this.player.forward;
    let reach = 0.5;
    if (this.colliders.raycast(e[0], e[1], e[2], f[0], f[1], f[2], reach + radius, LAYER_SOLID, ray)) reach = Math.max(0, ray.t - radius);
    return addScaled(addScaled(e, f, reach), this.player.up, 0.12 * (reach / 0.5));
  }

  /** Launch velocity for a shot at this power, before aim assist. */
  launchVelocity(power: number): Vec3 {
    const speed = MIN_SHOT_SPEED + (MAX_SHOT_SPEED - MIN_SHOT_SPEED) * clamp(power, 0, 1);
    const elevation = Math.min(this.player.pitch + SHOT_LOFT, MAX_LAUNCH_ELEVATION);
    const flat = Math.cos(elevation) * speed;
    return [-Math.sin(this.player.yaw) * flat, Math.sin(elevation) * speed, -Math.cos(this.player.yaw) * flat];
  }

  /** The shot that releasing now would take, aim assist included. The aim arc draws exactly this. */
  plannedShot(power: number, object: Grabbable | null = this.held ? (this.tracked.get(this.held) ?? null) : null): PlannedShot {
    const origin = this.releasePoint(object?.params.radius);
    const velocity = this.launchVelocity(power);
    const assist = this.assist;
    const targets = object ? (this.tracked.get(object.id)?.triggers ?? []) : [];
    if (!assist || targets.length === 0) return { origin, velocity, locked: false };
    const flat = Math.hypot(velocity[0], velocity[2]);
    const speed = Math.hypot(flat, velocity[1]);
    if (flat < 1e-6) return { origin, velocity, locked: false };
    const tan = velocity[1] / flat, cos = flat / speed;
    const heading = Math.atan2(velocity[0], velocity[2]);
    for (const { def } of targets) {
      if (def.enterFromAbove?.event !== 'score') continue;
      const dx = def.shape.center[0] - origin[0], dz = def.shape.center[2] - origin[2];
      const d = Math.hypot(dx, dz), h = def.shape.center[1] - origin[1];
      // Needs to pass over the target on the way down, steeply enough to fit through.
      if (d < 0.3 || d * tan - h <= 0 || tan - (2 * h) / d < MIN_DESCENT) continue;
      let turn = Math.atan2(dx, dz) - heading;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      const ideal = Math.sqrt((GRAVITY * d * d) / (2 * cos * cos * (d * tan - h)));
      if (Math.abs(turn) > assist.angle || Math.abs(speed - ideal) > assist.speed * ideal) continue;
      const k = (speed + (ideal - speed) * assist.strength) / speed;
      const a = heading + turn * assist.strength;
      return { origin, velocity: [Math.sin(a) * flat * k, velocity[1] * k, Math.cos(a) * flat * k], locked: true };
    }
    return { origin, velocity, locked: false };
  }

  /**
   * Writes the flight path of a shot at this power into `out` (xyz triples) and returns the number
   * of points. `aimLocked` says whether aim assist has taken hold of it.
   */
  aimArc(power: number, out: Float32Array): number {
    const { origin: o, velocity: v, locked } = this.plannedShot(power);
    this.aimLocked = locked;
    const floor = this.colliders.triangleCount > 0 ? this.colliders.min[1] : this.player.feet[1];
    const max = Math.floor(out.length / 3);
    let count = 0;
    for (let i = 1; i <= max; i++) {
      const t = i * ARC_STEP;
      const y = o[1] + v[1] * t - 0.5 * GRAVITY * t * t;
      if (y < floor) break;
      out[count * 3] = o[0] + v[0] * t;
      out[count * 3 + 1] = y;
      out[count * 3 + 2] = o[2] + v[2] * t;
      count++;
    }
    return count;
  }

  // ---- world actions --------------------------------------------------------------------------

  /** Puts an object back on its spawn point. */
  resetObject(id: string): boolean {
    const o = this.tracked.get(id);
    if (!o) return false;
    if (o.held) this.release(o);
    this.place(o, o.spawn);
    this.events.push({ type: 'reset', object: id });
    return true;
  }

  /** Edit mode: moves an object's spawn point (and the object with it). */
  setObjectSpawn(id: string, position: Vec3): boolean {
    const o = this.tracked.get(id);
    if (!o) return false;
    o.spawn = copy(position);
    return this.resetObject(id);
  }

  /** Edit mode: where the player starts, as an eye position and a point to look at. */
  setPlayerSpawn(position: Vec3, lookAt: Vec3 | null): void {
    this.spawnPoint = { position: copy(position), lookAt: lookAt ? copy(lookAt) : null };
  }

  get playerSpawn(): { position: Vec3; lookAt: Vec3 | null } {
    return this.spawnPoint;
  }

  respawnPlayer(): void {
    this.player.spawn(this.spawnPoint.position, this.spawnPoint.lookAt ?? undefined);
  }

  setRules(rules: ShootingRules): void {
    this.shootout?.setRules(rules);
  }

  startShootout(): boolean {
    if (!this.shootout) return false;
    const ball = this.tracked.get(this.shootout.def.ball);
    if (ball) {
      ball.shot = null;
      // Tip-off: the shooter starts with the ball, wherever it was.
      if (!this.held && this.playerEnabled) this.hold(ball, 'agent');
    }
    this.shootout.start();
    this.events.push({ type: 'shootout', signal: { kind: 'countdown', seconds: COUNTDOWN_SEC } });
    return true;
  }

  stopShootout(): void {
    this.shootout?.stop();
  }

  /** Installs an agent for its role, replacing the previous one. Pass a role name to remove it. */
  setAgent(agent: WorldAgent | string): void {
    if (typeof agent === 'string') {
      // Anything the departing agent was carrying drops where it is.
      for (const o of this.tracked.values()) {
        if (o.carrier === agent) {
          o.carrier = null;
          wake(o.body);
        }
      }
      this.agents.delete(agent);
    } else {
      agent.reset?.();
      this.agents.set(agent.role, agent);
    }
    this.bodies = [...this.agents.values()].flatMap((a) => (a.body ? [{ role: a.role, body: a.body }] : []));
  }

  getAgent(role: string): WorldAgent | null {
    return this.agents.get(role) ?? null;
  }

  /** The state worth keeping between sessions, in game-state.json shape. */
  snapshot(): GameState {
    const state: GameState = { version: PAYLOAD_VERSION, minigames: {}, objects: {} };
    if (this.shootout) state.minigames[this.shootout.id] = { highScore: this.shootout.highScore, plays: this.shootout.plays };
    for (const o of this.tracked.values()) state.objects[o.id] = { position: copy(o.lastRest) };
    return state;
  }

  // ---- internals ------------------------------------------------------------------------------

  private tickWorld(input: PlayerInput): void {
    const held = this.held ? this.tracked.get(this.held) : undefined;
    const pressed = input.charging && this.playerEnabled;
    if (held && this.shootout?.phase !== 'countdown') {
      if (pressed && !this.prevCharging) {
        this.charging = true;
        this.chargeTime = 0;
      }
      if (this.charging) {
        if (pressed) {
          this.chargeTime += TICK;
          const phase = (this.chargeTime / CHARGE_SEC) % 2;
          this.power = phase <= 1 ? phase : 2 - phase;
        } else {
          this.shoot(this.power);
        }
      }
    } else {
      this.charging = false;
      this.power = 0;
    }
    this.prevCharging = pressed;

    for (const o of this.tracked.values()) {
      o.prev[0] = o.body.pos[0]; o.prev[1] = o.body.pos[1]; o.prev[2] = o.body.pos[2];
      if (o.held || o.carrier) continue;
      this.current = o;
      stepBall(o.body, o.params, this.colliders, TICK, LAYER_ALL, this.hooks);
      this.afterStep(o);
    }
    this.current = null;

    const game = this.shootout;
    if (game?.running) {
      let pending = false;
      for (const o of this.tracked.values()) if (o.shot?.live && !o.shot.done) pending = true;
      this.signals.length = 0;
      game.tick(TICK, pending, this.signals);
      for (const signal of this.signals) {
        this.events.push({ type: 'shootout', signal });
        if (signal.kind === 'over') this.events.push({ type: 'state' });
      }
    }

    if (this.agentsEnabled) {
      for (const agent of this.agents.values()) {
        this.currentAgent = agent;
        agent.update(this.view, TICK);
      }
      this.currentAgent = null;
    }
    this.tick++;
    this.time = this.tick * TICK;
  }

  private afterStep(o: Tracked): void {
    const { pos } = o.body;
    if (!Number.isFinite(pos[0] + pos[1] + pos[2]) || pos[1] < this.colliders.min[1] - OUT_OF_WORLD) {
      this.place(o, o.spawn);
      this.events.push({ type: 'reset', object: o.id });
      return;
    }
    const shot = o.shot;
    if (shot && !shot.done) {
      if (o.body.grounded && shot.groundedAt === null) shot.groundedAt = this.time;
      shot.done =
        (shot.scoredAt !== null && this.time - shot.scoredAt > 0.4) ||
        (shot.groundedAt !== null && this.time - shot.groundedAt > 0.8) ||
        o.body.resting ||
        this.time - shot.releasedAt > 6;
    }
    if (o.incomingSince !== null) {
      const e = this.player.eye;
      if (distance(pos, [e[0], e[1] - 0.35, e[2]]) < CATCH_RADIUS && !this.held) this.hold(o, 'agent');
      else if (o.body.resting || this.time - o.incomingSince > 3) o.incomingSince = null;
    }
    if (o.body.resting && !o.wasResting) {
      const b = this.bounds;
      if (b && (pos[0] < b.min[0] - REACH_MARGIN || pos[0] > b.max[0] + REACH_MARGIN || pos[2] < b.min[2] - REACH_MARGIN || pos[2] > b.max[2] + REACH_MARGIN)) {
        // Came to rest where nobody can walk to: put it back in play.
        this.place(o, o.spawn);
        this.events.push({ type: 'reset', object: o.id });
        return;
      }
      o.lastRest = copy(pos);
      this.events.push({ type: 'state' });
    }
    o.wasResting = o.body.resting;
  }

  private onBounce(group: number, speed: number): void {
    const o = this.current;
    if (!o) return;
    if (o.shot) o.shot.clean = false;
    if (speed > 0.8) this.events.push({ type: 'bounce', object: o.id, surface: this.colliders.groups[group]?.name ?? '', speed });
  }

  private onMove(prev: Vec3, cur: Vec3): void {
    const o = this.current;
    if (!o) return;
    for (const t of o.triggers) if (t.trigger.sweep(prev, cur)) this.fire(t.def, o);
  }

  private fire(def: TriggerDef, o: Tracked): void {
    const event = def.enterFromAbove?.event ?? '';
    if (event !== 'score') {
      this.events.push({ type: 'trigger', trigger: def.id, event, object: o.id });
      return;
    }
    const shot = o.shot;
    if (!shot || shot.scoredAt !== null) return; // only a shot can score, and only once
    shot.scoredAt = this.time;
    const game = this.shootout;
    const rules = game?.rules;
    const three = !!rules && rules.threePointRadius !== null && horizontalDistance(shot.from, def.shape.center) > rules.threePointRadius;
    const points = (rules?.pointsPerBasket ?? 2) + (three ? 1 : 0);
    const counted = !!game && shot.live && game.def.ball === o.id && game.def.targets.includes(def.id) && (game.phase === 'playing' || game.phase === 'overtime');
    if (counted) game.basket(points);
    this.events.push({ type: 'score', object: o.id, trigger: def.id, points, three, swish: shot.clean, counted });
  }

  private hold(o: Tracked, by: 'player' | 'agent'): void {
    o.held = true;
    o.carrier = null;
    o.shot = null;
    o.incomingSince = null;
    o.body.vel[0] = o.body.vel[1] = o.body.vel[2] = 0;
    wake(o.body);
    o.wasResting = false;
    this.held = o.id;
    this.charging = false;
    this.power = 0;
    this.events.push({ type: 'grab', object: o.id, by });
    this.carry();
  }

  private release(o: Tracked): void {
    o.held = false;
    wake(o.body);
    o.body.grounded = false;
    if (this.held === o.id) this.held = null;
    this.charging = false;
    this.power = 0;
  }

  private place(o: Tracked, at: Vec3): void {
    o.carrier = null;
    for (const p of [o.body.pos, o.prev]) { p[0] = at[0]; p[1] = at[1]; p[2] = at[2]; }
    o.body.vel[0] = o.body.vel[1] = o.body.vel[2] = 0;
    wake(o.body);
    o.shot = null;
    o.incomingSince = null;
    for (const t of o.triggers) t.trigger.reset();
  }

  /** Keeps the held object in the player's hands, lifting it towards the release point while charging. */
  private carry(): void {
    const o = this.held ? this.tracked.get(this.held) : undefined;
    if (!o) return;
    const p = this.player, e = p.eyeInto(carryE), f = p.forwardInto(carryF), r = p.rightInto(carryR), u = p.upInto(carryU);
    const lift = this.charging ? 0.25 + 0.35 * this.power : 0;
    const fwd = 0.55, side = 0.24 * (1 - lift), down = -0.3 + 0.42 * lift;
    for (let k = 0; k < 3; k++) {
      const v = e[k as 0 | 1 | 2] + f[k as 0 | 1 | 2] * fwd + r[k as 0 | 1 | 2] * side + u[k as 0 | 1 | 2] * down;
      o.body.pos[k as 0 | 1 | 2] = v;
      o.prev[k as 0 | 1 | 2] = v;
    }
  }

  private objectView(o: Tracked): AgentObject {
    const shot: AgentShot = {
      get releasedAt() { return o.shot?.releasedAt ?? 0; },
      get scored() { return o.shot?.scoredAt != null; },
      get done() { return o.shot?.done ?? true; },
    };
    return {
      id: o.id,
      get position() { return o.body.pos; },
      get velocity() { return o.body.vel; },
      get state() { return o.held || o.carrier ? 'held' : o.body.resting ? 'resting' : o.body.grounded ? 'grounded' : 'flying'; },
      get heldBy() { return o.held ? 'player' : o.carrier; },
      get incoming() { return o.incomingSince !== null; },
      get shot() { return o.shot ? shot : null; },
    };
  }

  private agentWorld(): AgentWorld {
    const rt = (): WorldRuntime => this;
    const tracked = this.tracked;
    const player = {
      get feet() { return rt().player.feet; },
      get eye() { return rt().player.eye; },
      get forward() { return rt().player.forward; },
      get holding() { return rt().held; },
      get canHold() { return rt().playerEnabled && rt().held === null; },
    };
    const game = this.shootout;
    const minigame = game && {
      id: game.id,
      ball: game.def.ball,
      get phase() { return game.phase; },
      get score() { return game.score; },
      get timeLeft() { return game.timeLeft; },
    };
    /** An object the calling agent may act on: loose, or carried by that same agent. */
    const usable = (id: string): Tracked | null => {
      const o = tracked.get(id);
      return o && !o.held && (o.carrier === null || o.carrier === this.currentAgent?.role) ? o : null;
    };
    return {
      get time() { return rt().time; },
      get tick() { return rt().tick; },
      bounds: this.bounds,
      player,
      minigame,
      object: (id) => tracked.get(id)?.view ?? null,
      objectIds: () => [...tracked.keys()],
      random: () => this.random(),
      carry: (id, position) => {
        const o = usable(id);
        if (!o || !this.currentAgent || !Number.isFinite(position[0] + position[1] + position[2])) return false;
        if (o.carrier === null) {
          o.carrier = this.currentAgent.role;
          o.shot = null;
          o.incomingSince = null;
          o.wasResting = false;
          wake(o.body);
          for (const p of [o.body.pos, o.prev]) { p[0] = position[0]; p[1] = position[1]; p[2] = position[2]; }
        }
        o.body.pos[0] = position[0]; o.body.pos[1] = position[1]; o.body.pos[2] = position[2];
        o.body.vel[0] = o.body.vel[1] = o.body.vel[2] = 0;
        return true;
      },
      release: (id, velocity) => {
        const o = usable(id);
        if (!o || o.carrier === null) return false;
        o.carrier = null;
        wake(o.body);
        o.body.grounded = false;
        o.body.vel[0] = velocity?.[0] ?? 0; o.body.vel[1] = velocity?.[1] ?? 0; o.body.vel[2] = velocity?.[2] ?? 0;
        return true;
      },
      giveToPlayer: (id) => {
        const o = usable(id);
        if (!o || this.held || !this.playerEnabled) return false;
        this.hold(o, 'agent');
        return true;
      },
      pass: (id, target, flightSec) => {
        const o = usable(id);
        if (!o) return false;
        const v = ballisticVelocity(o.body.pos, target, clamp(flightSec, 0.2, 3));
        if (!Number.isFinite(v[0] + v[1] + v[2])) return false;
        o.carrier = null;
        o.body.vel[0] = v[0]; o.body.vel[1] = v[1]; o.body.vel[2] = v[2];
        wake(o.body);
        o.body.grounded = false;
        o.shot = null;
        o.incomingSince = this.time;
        return true;
      },
      emit: (name, detail) => {
        this.events.push({ type: 'custom', name: String(name).slice(0, 64), detail });
      },
    };
  }
}
