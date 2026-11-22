import { DEFAULT_HOME, createNpcHook, findModels, parseRulesModel, type NpcAction, type NpcHook, type NpcObservation } from '@wgif/ai';
import type { Vec3, WgifWorld } from '@wgif/format';
import type { AgentBody, AgentObject, AgentWorld, WorldAgent } from './sim/agents.js';
import { clamp, distance } from './sim/vec.js';

/**
 * The court's rebounder NPC, wired into the player loop.
 *
 * @wgif/ai (Nova's lane) owns the model and its per-tick hook: `hook.tick(dt, observation)` steps
 * the model at its own rate and answers with a velocity and two flags. This adapter owns the NPC's
 * place in the world. It runs as a `WorldAgent` on the runtime's fixed tick, feeds the hook, walks
 * the body, and turns the flags into world actions: pick the ball up, carry it, pass it to the
 * player. It never touches the scene or the DOM; the viewer draws `body`, and the runtime owns the
 * ball, so the NPC and the Shootout cannot fight over it.
 *
 * The hook answers through a Promise, so a model step lands a moment after it was asked for. It is
 * picked up at the start of the next `update`: everything that changes the world happens inside
 * the tick, never in a callback.
 */
export const REBOUNDER_ROLE = 'rebounder';
const COLOR = 0x8b5cf6; // violet: Nova's NPC
const CARRY_HEIGHT = 0.9;
const DEFAULT_PICKUP_RADIUS = 0.45;
/** The model decides at its own tick rate; by the time the decision lands the ball may have rolled a little further. */
const PICKUP_SLACK = 0.35;
/** If the model carries the ball this long without passing, the ball is handed over anyway. */
const CARRY_TIMEOUT_SEC = 8;
/** Walking speed back to the stand-by post between rebounds. */
const POST_SPEED = 2.5;
/** Rounding allowance when summed ticks are compared with the model's period, seconds. */
const TIME_EPSILON = 1e-9;
const IDLE: NpcAction = { state: 'idle', velocity: [0, 0, 0], passBall: false, holdingBall: false, target: null };

export interface NpcInfo {
  /** The runtime actually driving the NPC. */
  runtime: 'rules' | 'onnx';
  /** True when the listed model could not run and its rules fallback is in use. */
  usedFallback: boolean;
  tickHz: number;
  warnings: string[];
}

export class RebounderAgent implements WorldAgent {
  readonly role = REBOUNDER_ROLE;
  readonly body: AgentBody & { position: Vec3 };
  /** Set when the model failed mid-game. The NPC then stands still and the built-in ball return takes over. */
  failed: Error | null = null;
  private action: NpcAction = IDLE;
  private seenStep = 0;
  private pending: Promise<unknown> | null = null;
  /** A model step is running (the hook answers through a Promise). */
  private stepping = false;
  private carriedFor = 0;
  /** Simulated time since the hook was last asked for a step. */
  private clock = 0;
  /** Where the ball was left for a player who could not take it. The NPC leaves it alone while it stays there. */
  private parked: Vec3 | null = null;
  /** Shootout stand-by post (see standBy). While set, "idle" means waiting here instead of the model's home. */
  private post: Vec3 | null = null;

  constructor(private readonly hook: NpcHook, private readonly home: Vec3, private readonly pickupRadius = DEFAULT_PICKUP_RADIUS) {
    this.body = { position: [home[0], home[1], home[2]], heading: Math.PI, radius: 0.3, height: 1.75, color: COLOR };
  }

  /** Live info about the model driving the NPC — read from the hook each time, because the hook can swap runtimes mid-game (ONNX → rules fallback). */
  get info(): NpcInfo {
    return { runtime: this.hook.runtime, usedFallback: this.hook.usedFallback, tickHz: this.hook.tickHz, warnings: [...this.hook.warnings] };
  }

  /** The model's current state name (`chase`, `carry`, ...), for display. */
  get state(): string {
    return this.hook.state;
  }

  reset(): void {
    this.hook.reset();
    this.action = IDLE;
    this.seenStep = 0;
    this.carriedFor = 0;
    this.clock = 0;
    this.parked = null;
    this.post = null;
    this.body.position[0] = this.home[0]; this.body.position[1] = this.home[1]; this.body.position[2] = this.home[2];
  }

  /**
   * Puts the NPC at a spot, for example under the hoop the shooter faces at tip-off, so it is in
   * view and close to where misses land, and makes that spot where it waits between rebounds for
   * the rest of the Shootout (instead of walking back to the model's centre-court home). The model
   * still decides when to chase, pick up, carry and pass.
   */
  standBy(spot: Vec3): void {
    if (!Number.isFinite(spot[0] + spot[1] + spot[2])) return;
    this.post = [spot[0], spot[1], spot[2]];
    this.body.position[0] = spot[0]; this.body.position[1] = spot[1]; this.body.position[2] = spot[2];
  }

  /** Resolves when no model step is in flight. Tests and replays wait on this between ticks. */
  settled(): Promise<void> {
    return Promise.resolve(this.pending).then(() => undefined);
  }

  update(world: AgentWorld, dt: number): void {
    const ballId = world.minigame?.ball ?? world.objectIds()[0];
    const ball = ballId ? world.object(ballId) : null;
    if (!ball) return;
    const pos = this.body.position;

    // 1. Pick up what the model decided since the last tick. Flags such as passBall are one-shot:
    //    they count only on the tick a new model step arrives.
    const stepped = this.hook.step !== this.seenStep && this.hook.lastAction !== null;
    if (stepped) {
      this.seenStep = this.hook.step;
      this.action = this.hook.lastAction ?? IDLE;
    }
    const mine = ball.heldBy === this.role;
    if (mine) this.carriedFor += dt;
    else this.carriedFor = 0;
    if (mine && ((stepped && this.action.passBall) || this.carriedFor > CARRY_TIMEOUT_SEC)) this.handOver(world, ball);

    // 2. Walk, staying inside the play area. During a Shootout an idle NPC waits at its post.
    const phase = world.minigame?.phase;
    if (this.post && (phase === 'idle' || phase === 'over')) this.post = null;
    let [vx, , vz] = this.failed ? IDLE.velocity : this.action.velocity;
    if (this.post && !this.failed && this.hook.state === 'idle') {
      const dx = this.post[0] - pos[0], dz = this.post[2] - pos[2], d = Math.hypot(dx, dz);
      const v = d > 0.05 ? Math.min(POST_SPEED, d / dt) / d : 0;
      vx = dx * v;
      vz = dz * v;
    }
    const b = world.bounds;
    pos[0] = b ? clamp(pos[0] + vx * dt, b.min[0], b.max[0]) : pos[0] + vx * dt;
    pos[2] = b ? clamp(pos[2] + vz * dt, b.min[2], b.max[2]) : pos[2] + vz * dt;
    if (Math.hypot(vx, vz) > 0.05) this.body.heading = Math.atan2(-vx, -vz);

    // 3. The ball. The model decides when it picks the ball up (`holdingBall`); the adapter only
    //    checks that the ball really is within reach. Picking it up on our own would put the world
    //    and the model out of step: a carried ball is never `ball_near` again, so the model would
    //    keep chasing a ball it already has.
    if (ball.heldBy === this.role) {
      world.carry(ball.id, [pos[0], pos[1] + CARRY_HEIGHT, pos[2]]);
    } else if (!this.failed && this.action.holdingBall && ball.heldBy === null && !ball.incoming && !this.isParked(ball) && distance(pos, ball.position) <= this.pickupRadius + PICKUP_SLACK) {
      if (world.carry(ball.id, [pos[0], pos[1] + CARRY_HEIGHT, pos[2]])) this.parked = null;
    }

    // 4. Feed the hook at the model's own rate, never faster (SPEC §6: players MUST NOT step a
    //    model faster than its declared tickHz). The hook is handed exactly one period, so it steps
    //    exactly once: handing it the whole elapsed time let its leftover add up to a second step,
    //    which landed a frame after the first. A period that ends while a step is still running is
    //    skipped, not queued. Calling the hook on every 120 Hz tick would only build observations
    //    and promises it throws away (PERF.md fix #7).
    if (this.failed) return;
    const period = 1 / this.hook.tickHz;
    this.clock += dt;
    // Twelve 1/120 s ticks add up to 0.09999999999999999, not 0.1: allow for the rounding.
    if (this.clock < period - TIME_EPSILON) return;
    this.clock = 0;
    if (this.stepping) return;
    this.stepping = true;
    const pending = this.hook.tick(period, this.observe(world, ball)).then(
      () => {
        this.stepping = false;
      },
      (error: unknown) => {
        this.stepping = false;
        // A model error must never stop the world: the NPC stands still from here on.
        this.failed = error instanceof Error ? error : new Error(String(error));
        this.hook.dispose();
        if (ball.heldBy === this.role) world.release(ball.id);
      },
    );
    this.pending = pending;
  }

  private observe(world: AgentWorld, ball: AgentObject): NpcObservation {
    const feet = world.player.feet, p = ball.position, v = ball.velocity;
    // The model knows three holders. A pass in the air and a ball left at the player's feet are
    // "the player's", so the NPC does not run after what it has just delivered.
    const heldBy = ball.heldBy === 'player' || ball.incoming || this.isParked(ball) ? 'player' : ball.heldBy === this.role ? 'rebounder' : null;
    return {
      timeSec: world.time,
      ball: { position: [p[0], p[1], p[2]], velocity: [v[0], v[1], v[2]], heldBy },
      player: { position: [feet[0], feet[1], feet[2]] },
      self: { position: [this.body.position[0], this.body.position[1], this.body.position[2]] },
    };
  }

  private isParked(ball: AgentObject): boolean {
    if (!this.parked) return false;
    if (ball.heldBy !== null || distance(ball.position, this.parked) > 1.5) this.parked = null;
    return this.parked !== null;
  }

  /** Gives the ball to the player: a short lob they catch, or left at their feet if they cannot take it. */
  private handOver(world: AgentWorld, ball: AgentObject): void {
    const eye = world.player.eye, feet = world.player.feet;
    if (world.player.canHold) {
      const chest: Vec3 = [eye[0], eye[1] - 0.35, eye[2]];
      world.pass(ball.id, chest, clamp(distance(ball.position, chest) / 6, 0.25, 0.7));
    } else {
      world.release(ball.id, [0, 0, 0]);
      this.parked = [ball.position[0], feet[1], ball.position[2]];
    }
    this.carriedFor = 0;
  }
}

/**
 * Loads the world's rebounder through @wgif/ai's hook and wraps it as an agent. Returns null when
 * the world has no usable rebounder; the world is still fully playable (the runtime's built-in
 * ball return covers the Shootout). With `preferOnnx`, the ONNX clone drives the NPC when it
 * loads (the JS MLP evaluator, no WASM); the rules twin stays the fallback on any load or
 * evaluation failure, and the default stays rules-first.
 */
export async function createRebounder(world: WgifWorld, opts: { preferOnnx?: boolean } = {}): Promise<RebounderAgent | null> {
  const models = findModels(world, REBOUNDER_ROLE);
  if (models.length === 0) return null;
  let hook: NpcHook;
  try {
    hook = await createNpcHook(world, REBOUNDER_ROLE, opts.preferOnnx ? { preferRuntime: 'onnx' } : undefined);
  } catch {
    return null;
  }
  // Home and pickup reach come from the rules model, which every rebounder has (as itself or as its fallback).
  let home: Vec3 = DEFAULT_HOME, pickup = DEFAULT_PICKUP_RADIUS;
  const twin = models.find((m) => m.runtime === 'rules');
  const bytes = twin ? world.files[twin.path] : undefined;
  if (bytes) {
    try {
      const { params } = parseRulesModel(bytes);
      if (Array.isArray(params.home)) home = params.home;
      if (typeof params.pickupRadius === 'number' && params.pickupRadius > 0) pickup = params.pickupRadius;
    } catch {
      // keep the defaults
    }
  }
  return new RebounderAgent(hook, home, pickup);
}

/**
 * Where the rebounder waits during a Shootout: on the floor 1.5 m in front of the rim towards the
 * shooter and 0.8 m to one side, so it is in view under the hoop without standing in the line of the shot.
 */
export function reboundSpot(rim: Vec3, shooterFeet: Vec3): Vec3 {
  let dx = shooterFeet[0] - rim[0], dz = shooterFeet[2] - rim[2];
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  return [rim[0] + dx * 1.5 - dz * 0.8, shooterFeet[1], rim[2] + dz * 1.5 + dx * 0.8];
}
