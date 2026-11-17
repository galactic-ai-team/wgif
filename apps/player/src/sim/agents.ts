import type { ShootoutPhase } from './shootout.js';
import type { Vec3 } from './vec.js';

/**
 * The NPC hook (Embedded AI lane).
 *
 * An agent is a controller the runtime calls once per fixed simulation tick with a narrow view of
 * the world. Agents never touch the DOM, the renderer or the network: they read the view and call
 * its few actions. `rules` and `onnx` models from a world's `models/` plug in by implementing this
 * interface inside the player; a container never supplies code (SPEC §5.6).
 *
 * The runtime keeps one agent per role. `BallReturnAgent` below is the smallest example;
 * `../ai.ts` adapts a @wgif/ai model (the court's rebounder NPC) to this interface.
 */
export interface WorldAgent {
  /** What the agent does in the world, for example `rebounder`. One agent per role. */
  readonly role: string;
  /** Agents that walk around have a body. The viewer draws it; the simulation does not collide with it. */
  readonly body?: AgentBody;
  /** Called once per tick. `dt` is the fixed tick length in seconds. */
  update(world: AgentWorld, dt: number): void;
  /** Called when a world (re)starts, so stateful agents can clear themselves. */
  reset?(): void;
}

export interface AgentBody {
  /** Feet position. */
  readonly position: Vec3;
  /** Facing direction as a yaw angle in radians (0 looks down -Z, like the walker). */
  heading: number;
  readonly radius: number;
  readonly height: number;
  /** 0xRRGGBB. */
  readonly color: number;
}

export interface AgentShot {
  /** Simulation time of the release. */
  readonly releasedAt: number;
  readonly scored: boolean;
  /** True once the shot is over: it scored, it has been on the floor for a moment, or it timed out. */
  readonly done: boolean;
}

export interface AgentObject {
  readonly id: string;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly state: 'held' | 'flying' | 'grounded' | 'resting';
  /** Who holds it: `player`, the role of the agent carrying it, or null when it is loose. */
  readonly heldBy: string | null;
  /** True while a pass is on its way to the player. */
  readonly incoming: boolean;
  /** The player's last shot with this object, or null if it has not been shot since it was picked up. */
  readonly shot: AgentShot | null;
}

export interface AgentWorld {
  /** Simulated seconds since the world started. */
  readonly time: number;
  readonly tick: number;
  /** The play area from interactions.json, if the world declares one. */
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 } | null;
  readonly player: {
    readonly feet: Vec3;
    readonly eye: Vec3;
    readonly forward: Vec3;
    readonly holding: string | null;
    /** False while the camera orbits or the hands are full: a pass would not be caught. */
    readonly canHold: boolean;
  };
  readonly minigame: { readonly id: string; readonly ball: string; readonly phase: ShootoutPhase; readonly score: number; readonly timeLeft: number } | null;
  object(id: string): AgentObject | null;
  objectIds(): string[];
  /** Deterministic random number in [0, 1), so a replay with the same inputs gives the same game. */
  random(): number;
  /**
   * Picks up a loose object, or moves one this agent already carries. A carried object leaves
   * physics and stays exactly where the agent puts it, so call this every tick while carrying.
   */
  carry(objectId: string, position: Vec3): boolean;
  /** Lets go of an object this agent carries. It falls from where it is with the given velocity. */
  release(objectId: string, velocity?: Vec3): boolean;
  /** Puts a loose object, or one this agent carries, straight into the player's hands. */
  giveToPlayer(objectId: string): boolean;
  /**
   * The safety net's action: puts the object into the player's hands even if another agent is
   * carrying it (never if the player holds it). For the built-in ball return, so a slow or stuck
   * NPC can never keep the ball from the shooter.
   */
  returnToPlayer(objectId: string): boolean;
  /** Throws a loose or carried object so that it reaches `target` after `flightSec`. The player catches it on arrival. */
  pass(objectId: string, target: Vec3, flightSec: number): boolean;
  /** Raises a custom event for the HUD and audio layers. */
  emit(name: string, detail?: unknown): void;
}

/**
 * Built-in ball return: during a Shootout it hands the ball back once a shot is over, so the
 * player can keep shooting. It has no body.
 *
 * With `patienceSec` 0 it is the whole rebounder for worlds that bring no NPC. When a real
 * rebounder NPC is installed it stays on as a safety net with some patience, so a ball the NPC
 * cannot reach never stalls the game. With `deadlineSec`, the ball is also back in the shooter's
 * hands at the latest that long after it left them (shot over, no pass in the air), even if the
 * NPC is still chasing or carrying it: a Shootout is timed, so a slow NPC must not eat the clock.
 */
export class BallReturnAgent implements WorldAgent {
  readonly role = 'ball-return';
  private deadSince: number | null = null;
  private leftHandsAt: number | null = null;

  constructor(readonly patienceSec = 0, readonly deadlineSec: number | null = null) {}

  reset(): void {
    this.deadSince = null;
    this.leftHandsAt = null;
  }

  update(world: AgentWorld): void {
    const game = world.minigame;
    const ball = game ? world.object(game.ball) : null;
    const waiting = !!game && !!ball && (game.phase === 'countdown' || game.phase === 'playing') && world.player.canHold;
    if (this.deadlineSec !== null && waiting) {
      if (ball.heldBy === 'player') this.leftHandsAt = null;
      else {
        this.leftHandsAt ??= world.time;
        const over = !ball.shot || ball.shot.done;
        if (over && !ball.incoming && world.time - this.leftHandsAt >= this.deadlineSec && world.returnToPlayer(ball.id)) {
          this.leftHandsAt = this.deadSince = null;
          return;
        }
      }
    } else if (!waiting) this.leftHandsAt = null;
    const dead = waiting && ball.heldBy === null && !ball.incoming && (!ball.shot || ball.shot.done);
    if (!dead) {
      // A ball in an NPC's hands is on its way; a ball in the air is not dead yet.
      if (!waiting || ball?.heldBy === 'player' || (ball?.shot && !ball.shot.done)) this.deadSince = null;
      return;
    }
    this.deadSince ??= world.time;
    if (world.time - this.deadSince >= this.patienceSec && world.giveToPlayer(ball.id)) this.deadSince = null;
  }
}
