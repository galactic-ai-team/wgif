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
  private carriedFor = 0;
  /** Simulated time not yet handed to the hook. */
  private clock = 0;
  /** Where the ball was left for a player who could not take it. The NPC leaves it alone while it stays there. */
  private parked: Vec3 | null = null;

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
    this.body.position[0] = this.home[0]; this.body.position[1] = this.home[1]; this.body.position[2] = this.home[2];
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

    // 2. Walk, staying inside the play area.
    const [vx, , vz] = this.failed ? IDLE.velocity : this.action.velocity;
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

    // 4. Feed the hook at the model's own rate. Calling it on every 120 Hz tick would only build
    //    observations and promises it throws away (PERF.md fix #7). It never overlaps two steps.
    if (this.failed) return;
    this.clock += dt;
    if (this.clock < 1 / this.info.tickHz) return;
    const elapsed = this.clock;
    this.clock = 0;
    const pending = this.hook.tick(elapsed, this.observe(world, ball)).catch((error: unknown) => {
      // A model error must never stop the world: the NPC stands still from here on.
      this.failed = error instanceof Error ? error : new Error(String(error));
      this.hook.dispose();
      if (ball.heldBy === this.role) world.release(ball.id);
    });
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
