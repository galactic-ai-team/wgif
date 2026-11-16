import { describe, expect, it } from 'vitest';
import { BallReturnAgent, type AgentWorld, type WorldAgent } from '../src/sim/agents.js';
import { GRAVITY } from '../src/sim/ball.js';
import { CHARGE_SEC, MAX_SHOT_SPEED, MIN_SHOT_SPEED, TICK, WorldRuntime, type PlayerInput } from '../src/sim/runtime.js';
import { COUNTDOWN_SEC, Shootout } from '../src/sim/shootout.js';
import type { Vec3 } from '../src/sim/vec.js';
import { parseInteractions } from '../src/interactions.js';
import { createRuntime } from '../src/sceneBridge.js';
import { ofType, open, run } from './helpers.js';

const HOME: Vec3 = [12.425, 3.05, 0];
const AWAY: Vec3 = [-12.425, 3.05, 0];
const FREE_THROW: Vec3 = [8.2, 1.7, 0];
const DOWNTOWN: Vec3 = [4.6, 1.7, 1.5];

/** Distance between the ball's surface and the rim's metal (negative = overlapping). The rim is a 12 mm tube. */
function gapToRim(p: Vec3, rim: Vec3): number {
  return Math.hypot(Math.hypot(p[0] - rim[0], p[2] - rim[2]) - 0.225, p[1] - rim[1]) - 0.012 - 0.12;
}

/** Distance between the ball's surface and an axis-aligned box such as the backboard (negative = overlapping). */
function gapToBox(p: Vec3, min: Vec3, max: Vec3): number {
  return Math.hypot(...p.map((v, i) => Math.max(min[i]! - v, 0, v - max[i]!))) - 0.12;
}

/** Opens the court with aim assist off, so these tests exercise the raw physics. */
async function court(assist = false) {
  const opened = await open();
  if (assist) return opened;
  const runtime = new WorldRuntime({
    interactions: opened.doc.interactions,
    colliders: opened.built.colliders,
    state: opened.doc.initialState,
    spawn: opened.doc.spawn,
    assist: false,
  });
  return { ...opened, runtime };
}

/** Walks up to the ball and picks it up. */
function pickUp(runtime: WorldRuntime): void {
  const ball = runtime.objects.get('ball')!;
  runtime.player.spawn([ball.body.pos[0] - 1, 1.7, ball.body.pos[2]]);
  expect(runtime.grab()).toBe(true);
}

/** Stands at `eye`, faces `rim`, and returns the power that sends the ball through its centre. */
function aim(runtime: WorldRuntime, eye: Vec3, rim: Vec3, tweak = 1): number {
  runtime.player.spawn(eye, rim);
  const o = runtime.releasePoint();
  const v = runtime.launchVelocity(1);
  const flat = Math.hypot(v[0], v[2]);
  const tan = v[1] / flat, cos = flat / Math.hypot(flat, v[1]);
  const d = Math.hypot(rim[0] - o[0], rim[2] - o[2]), h = rim[1] - o[1];
  const speed = Math.sqrt((GRAVITY * d * d) / (2 * cos * cos * (d * tan - h))) * tweak;
  return (speed - MIN_SHOT_SPEED) / (MAX_SHOT_SPEED - MIN_SHOT_SPEED);
}

/** Starts a Shootout and runs the countdown; the rebounder hands over the ball. */
function tipOff(runtime: WorldRuntime): void {
  expect(runtime.startShootout()).toBe(true);
  run(runtime, COUNTDOWN_SEC + TICK);
  expect(runtime.shootout?.phase).toBe('playing');
  expect(runtime.held).toBe('ball');
}

describe('free play on the court', () => {
  it('lets the player pick the ball up only when it is in reach, and drop it again', async () => {
    const { runtime } = await court();
    expect(runtime.canGrab()).toBeNull();
    expect(runtime.grab()).toBe(false);
    pickUp(runtime);
    expect(runtime.held).toBe('ball');
    expect(runtime.canGrab()).toBeNull();
    run(runtime, 0.5);
    const ball = runtime.objects.get('ball')!;
    // Carried in front of the player, not simulated.
    expect(Math.hypot(ball.body.pos[0] - runtime.player.eye[0], ball.body.pos[2] - runtime.player.eye[2])).toBeLessThan(0.8);
    expect(runtime.drop()).toBe(true);
    expect(runtime.held).toBeNull();
    const events = run(runtime, 8);
    expect(ball.body.resting).toBe(true);
    expect(ball.body.pos[1]).toBeCloseTo(0.125, 3);
    expect(ofType(events, 'state').length).toBeGreaterThan(0);
  });

  it('scores a clean free throw, but does not count it without a running Shootout', async () => {
    const { runtime } = await court();
    pickUp(runtime);
    const power = aim(runtime, FREE_THROW, HOME);
    expect(power).toBeGreaterThan(0.25);
    expect(power).toBeLessThan(0.45);
    expect(runtime.shoot(power)).toBe(true);
    const events = run(runtime, 2.5);
    const [score] = ofType(events, 'score');
    expect(score).toMatchObject({ object: 'ball', trigger: 'rim_home', points: 2, three: false, swish: true, counted: false });
    expect(ofType(events, 'score')).toHaveLength(1);
    expect(runtime.shootout?.score).toBe(0);
  });

  it('bounces off the rim instead of passing through it', async () => {
    const { runtime } = await court();
    pickUp(runtime);
    // Aimed at the front of the ring, not its centre.
    runtime.shoot(aim(runtime, FREE_THROW, [HOME[0] - 0.225, HOME[1], 0]));
    const ball = runtime.objects.get('ball')!;
    let rim = false;
    for (let i = 0; i < 3 / TICK; i++) {
      runtime.step();
      rim ||= runtime.drain().some((e) => e.type === 'bounce' && e.surface === 'rim_home');
      expect(gapToRim(ball.body.pos, HOME)).toBeGreaterThan(-1e-3);
    }
    expect(rim).toBe(true);
  });

  it('keeps the ball out of the rim and the glass, and scores exactly when it drops through the ring', async () => {
    const { runtime } = await court();
    const ball = runtime.objects.get('ball')!;
    let seed = 12345;
    const random = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    let makes = 0, rattles = 0;
    for (let shot = 0; shot < 60; shot++) {
      runtime.resetObject('ball');
      pickUp(runtime);
      const eye: Vec3 = [4 + random() * 6, 1.7, (random() - 0.5) * 8];
      const power = aim(runtime, eye, [HOME[0] + (random() - 0.5) * 0.3, HOME[1], (random() - 0.5) * 0.3], 0.97 + random() * 0.06);
      runtime.shoot(power);
      let scored = 0, through = 0, touchedRim = false;
      let above = ball.body.pos[1] > HOME[1];
      for (let i = 0; i < 3.5 / TICK; i++) {
        runtime.step();
        for (const e of runtime.drain()) {
          if (e.type === 'score') scored++;
          if (e.type === 'bounce' && e.surface === 'rim_home') touchedRim = true;
        }
        const p = ball.body.pos;
        expect(gapToRim(p, HOME)).toBeGreaterThan(-1e-3);
        expect(gapToBox(p, [12.775, 2.975, -0.9], [12.825, 4.025, 0.9])).toBeGreaterThan(-1e-3);
        // Independent check of a make: the centre goes from above the ring to below it, inside the ring.
        const nowAbove = p[1] > HOME[1];
        if (above && !nowAbove && Math.hypot(p[0] - HOME[0], p[2] - HOME[2]) < 0.225 - 0.012) through++;
        above = nowAbove;
      }
      expect(scored).toBe(through);
      expect(scored).toBeLessThanOrEqual(1);
      makes += scored;
      if (scored && touchedRim) rattles++;
    }
    // A spread of ±3 % in speed and ±15 cm in aim gives makes, misses and rim-ins.
    expect(makes).toBeGreaterThan(5);
    expect(makes).toBeLessThan(55);
    expect(rattles).toBeGreaterThan(0);
  });

  it('banks off the backboard', async () => {
    const { runtime } = await court();
    pickUp(runtime);
    const power = aim(runtime, FREE_THROW, [12.8, 3.6, 0]);
    runtime.shoot(power);
    const events = run(runtime, 3);
    const board = ofType(events, 'bounce').find((b) => b.surface === 'hoop_home_backboard');
    expect(board).toBeDefined();
    const ball = runtime.objects.get('ball')!;
    expect(ball.body.pos[0]).toBeLessThan(12.775 - 0.12 + 1e-6); // came back off the glass, never through it
  });

  it('only shots score: a ball that merely drops through the hoop is ignored', async () => {
    const { runtime } = await court();
    expect(runtime.setObjectSpawn('ball', [HOME[0], HOME[1] + 1, HOME[2]])).toBe(true);
    const events = run(runtime, 2);
    expect(ofType(events, 'score')).toHaveLength(0);
    expect(ofType(events, 'bounce').some((b) => b.surface === 'floor_court')).toBe(true);
    expect(ofType(events, 'bounce').some((b) => b.surface === 'rim_home')).toBe(false);
  });

  it('charges while the button is held and shoots on release', async () => {
    const { runtime } = await court();
    pickUp(runtime);
    run(runtime, TICK); // the press that picked the ball up is let go
    runtime.player.spawn(FREE_THROW, HOME);
    const hold: PlayerInput = { forward: 0, right: 0, run: false, charging: true };
    run(runtime, CHARGE_SEC / 2, hold);
    expect(runtime.charging).toBe(true);
    expect(runtime.power).toBeCloseTo(0.5, 2);
    run(runtime, CHARGE_SEC, hold);
    expect(runtime.power).toBeCloseTo(0.5, 2); // swung up to full and half-way back down
    const events = run(runtime, 0.1);
    expect(ofType(events, 'shot')[0]?.power).toBeCloseTo(0.5, 2);
    expect(runtime.held).toBeNull();
    expect(runtime.charging).toBe(false);
  });

  it('does not throw the ball with the same press that picked it up', async () => {
    const { runtime } = await court();
    const hold: PlayerInput = { forward: 0, right: 0, run: false, charging: true };
    const ball = runtime.objects.get('ball')!;
    runtime.player.spawn([ball.body.pos[0] - 1, 1.7, ball.body.pos[2]]);
    // A tap on Grab (or a click, or Space) is one press: it picks the ball up...
    expect(runtime.grab()).toBe(true);
    run(runtime, 0.2, hold);
    expect(runtime.charging).toBe(false);
    // ...and letting go of it keeps the ball.
    const events = run(runtime, 0.2);
    expect(ofType(events, 'shot')).toHaveLength(0);
    expect(runtime.held).toBe('ball');
    // The next press charges, and its release shoots.
    run(runtime, 0.3, hold);
    expect(runtime.charging).toBe(true);
    expect(ofType(run(runtime, 0.1), 'shot')).toHaveLength(1);
  });

  it('does not start charging from a button that was already down when the ball arrived', async () => {
    const { runtime } = await court();
    const hold: PlayerInput = { forward: 0, right: 0, run: false, charging: true };
    run(runtime, 0.2, hold);
    pickUp(runtime);
    run(runtime, 0.5, hold);
    expect(runtime.charging).toBe(false);
    expect(runtime.held).toBe('ball');
  });

  it('draws an aim arc that matches the flight of the shot', async () => {
    const { runtime } = await court();
    pickUp(runtime);
    const power = aim(runtime, DOWNTOWN, HOME);
    const arc = new Float32Array(60 * 3);
    const points = runtime.aimArc(power, arc);
    expect(points).toBeGreaterThan(15);
    runtime.shoot(power);
    const ball = runtime.objects.get('ball')!;
    for (let i = 0; i < 12; i++) {
      run(runtime, 0.05);
      expect(Math.hypot(ball.body.pos[0] - arc[i * 3]!, ball.body.pos[1] - arc[i * 3 + 1]!, ball.body.pos[2] - arc[i * 3 + 2]!)).toBeLessThan(0.03);
    }
  });

  it('puts a ball that leaves the world back on its spawn', async () => {
    const { runtime } = await court();
    const ball = runtime.objects.get('ball')!;
    ball.body.pos[0] = 60; // off the edge of the apron
    ball.body.resting = false;
    const events = run(runtime, 4);
    expect(ofType(events, 'reset')).toHaveLength(1);
    expect(ball.body.pos[0]).toBeCloseTo(9, 6);
  });

  it('brings back a ball that comes to rest where nobody can walk', async () => {
    const { runtime } = await court();
    const ball = runtime.objects.get('ball')!;
    // Rolled under the bleachers side, 2.5 m outside the walkable area.
    ball.body.pos[0] = 0; ball.body.pos[1] = 0.2; ball.body.pos[2] = -9.6;
    ball.body.vel[2] = -0.2;
    ball.body.resting = false;
    runtime.player.spawn([0, 1.7, -9.9]);
    expect(runtime.canGrab()).toBe('ball'); // just inside the edge: reachable, so it stays
    run(runtime, 3);
    expect(ball.body.resting).toBe(true);
    expect(ball.body.pos[2]).toBeLessThan(-9.6);
    ball.body.pos[0] = 17.5; ball.body.pos[2] = 0; ball.body.pos[1] = 0.3;
    ball.body.vel[0] = 3;
    ball.body.resting = false;
    const events = run(runtime, 6);
    expect(ofType(events, 'reset')).toHaveLength(1);
    expect(ball.body.pos[0]).toBeCloseTo(9, 6);
  });

  it('ignores the player while the camera is orbiting', async () => {
    const { runtime } = await court();
    pickUp(runtime);
    runtime.drop();
    run(runtime, 0.2);
    runtime.playerEnabled = false;
    const before = [...runtime.player.feet];
    run(runtime, 0.5, { forward: 1, right: 0, run: true, charging: true });
    expect(runtime.player.feet).toEqual(before);
    expect(runtime.canGrab()).toBeNull();
    expect(runtime.grab()).toBe(false);
  });
});

describe('Shootout', () => {
  it('counts down, hands over the ball, and scores two for a free throw', async () => {
    const { runtime } = await court();
    expect(runtime.startShootout()).toBe(true);
    expect(runtime.held).toBe('ball'); // tip-off: the shooter starts with the ball
    const countdown = run(runtime, COUNTDOWN_SEC + TICK);
    expect(ofType(countdown, 'shootout').map((e) => e.signal.kind)).toEqual(['countdown', 'countdown', 'countdown', 'go']);
    expect(ofType(countdown, 'grab')[0]).toMatchObject({ object: 'ball', by: 'agent' });
    expect(runtime.shootout?.phase).toBe('playing');

    runtime.shoot(aim(runtime, FREE_THROW, HOME));
    const events = run(runtime, 2.5);
    expect(ofType(events, 'score')[0]).toMatchObject({ points: 2, three: false, counted: true, trigger: 'rim_home' });
    expect(runtime.shootout).toMatchObject({ score: 2, makes: 1, attempts: 1 });
    // The rebounder has the ball back in the player's hands shortly after the make.
    expect(ofType(events, 'grab').some((g) => g.by === 'agent')).toBe(true);
    expect(runtime.held).toBe('ball');
  });

  it('gives three points from beyond the arc, at either basket', async () => {
    const { runtime } = await court();
    tipOff(runtime);
    runtime.shoot(aim(runtime, DOWNTOWN, HOME));
    let events = run(runtime, 3.5);
    expect(ofType(events, 'score')[0]).toMatchObject({ points: 3, three: true, counted: true });
    expect(runtime.held).toBe('ball');
    runtime.shoot(aim(runtime, [-4.6, 1.7, -1.5], AWAY));
    events = run(runtime, 3.5);
    expect(ofType(events, 'score')[0]).toMatchObject({ points: 3, three: true, trigger: 'rim_away' });
    expect(runtime.shootout).toMatchObject({ score: 6, makes: 2, attempts: 2 });
  });

  it('returns the ball after a miss so the player can keep shooting', async () => {
    const { runtime } = await court();
    tipOff(runtime);
    runtime.player.spawn(FREE_THROW, HOME);
    runtime.shoot(0.02);
    const events = run(runtime, 3);
    expect(ofType(events, 'score')).toHaveLength(0);
    expect(ofType(events, 'grab').filter((g) => g.by === 'agent')).toHaveLength(1);
    expect(runtime.held).toBe('ball');
    expect(runtime.shootout).toMatchObject({ score: 0, makes: 0, attempts: 1 });
  });

  it('cannot shoot during the countdown', async () => {
    const { runtime } = await court();
    runtime.startShootout();
    run(runtime, 0.5);
    expect(runtime.held).toBe('ball');
    runtime.player.spawn(FREE_THROW, HOME);
    const events = run(runtime, 1, { forward: 0, right: 0, run: false, charging: true });
    run(runtime, 0.2);
    expect(ofType(events, 'shot')).toHaveLength(0);
    expect(runtime.held).toBe('ball');
  });

  it('runs for the declared 60 seconds, then records the score, the high score and the play', async () => {
    const { runtime } = await court();
    tipOff(runtime);
    runtime.shoot(aim(runtime, FREE_THROW, HOME));
    const events = run(runtime, 61);
    const signals = ofType(events, 'shootout').map((e) => e.signal);
    expect(signals.filter((s) => s.kind === 'second')).toHaveLength(59);
    expect(signals.at(-2)?.kind).toBe('buzzer');
    const over = signals.at(-1);
    expect(over).toMatchObject({ kind: 'over', result: { score: 2, makes: 1, attempts: 1, highScore: 2, newHigh: true } });
    expect(runtime.shootout).toMatchObject({ phase: 'over', highScore: 2, plays: 1, timeLeft: 0 });
    expect(runtime.snapshot().minigames.shootout).toEqual({ highScore: 2, plays: 1 });
    expect(events.at(-1)?.type === 'state' || ofType(events, 'state').length > 0).toBe(true);

    // A second, worse game keeps the high score and counts the play.
    tipOff(runtime);
    run(runtime, 61);
    expect(runtime.shootout).toMatchObject({ phase: 'over', score: 0, highScore: 2, plays: 2 });
    expect(runtime.shootout?.result?.newHigh).toBe(false);
  });

  it('counts a buzzer-beater released in time, and waits for it to come down', async () => {
    const { runtime } = await court();
    tipOff(runtime);
    const power = aim(runtime, DOWNTOWN, HOME);
    run(runtime, 59.5);
    expect(runtime.shootout?.phase).toBe('playing');
    runtime.shoot(power);
    const events = run(runtime, 4);
    const kinds = ofType(events, 'shootout').map((e) => e.signal.kind);
    const buzzer = events.findIndex((e) => e.type === 'shootout' && e.signal.kind === 'buzzer');
    const score = events.findIndex((e) => e.type === 'score');
    const over = events.findIndex((e) => e.type === 'shootout' && e.signal.kind === 'over');
    expect(kinds).toEqual(['buzzer', 'over']);
    expect(buzzer).toBeLessThan(score);
    expect(score).toBeLessThan(over);
    expect(ofType(events, 'score')[0]).toMatchObject({ counted: true, points: 3 });
    expect(runtime.shootout?.result).toMatchObject({ score: 3, newHigh: true });
  });

  it('does not count a shot released after the buzzer', async () => {
    const { runtime } = await court();
    tipOff(runtime);
    run(runtime, 59.8);
    runtime.player.spawn(FREE_THROW, HOME);
    runtime.shoot(0.02); // a miss in the air at the buzzer keeps the game in overtime
    run(runtime, 0.3);
    expect(runtime.shootout?.phase).toBe('overtime');
    // No ball comes back after the buzzer, so nothing more can be shot or counted.
    const events = run(runtime, 6);
    expect(runtime.held).toBeNull();
    expect(runtime.shootout).toMatchObject({ phase: 'over', score: 0 });
    expect(ofType(events, 'grab')).toHaveLength(0);
  });

  it('can be abandoned without recording anything', async () => {
    const { runtime } = await court();
    tipOff(runtime);
    runtime.shoot(aim(runtime, FREE_THROW, HOME));
    run(runtime, 3);
    runtime.stopShootout();
    expect(runtime.shootout).toMatchObject({ phase: 'idle', highScore: 0, plays: 0, timeLeft: 60 });
  });

  it('is deterministic: the same inputs give the same game', async () => {
    const play = async () => {
      const { runtime } = await court();
      tipOff(runtime);
      const log: string[] = [];
      for (const [eye, rim, tweak] of [[FREE_THROW, HOME, 1], [DOWNTOWN, HOME, 0.97], [[6, 1.7, -3], HOME, 1.02], [FREE_THROW, HOME, 1]] as const) {
        if (!runtime.held) run(runtime, 2);
        runtime.shoot(aim(runtime, [...eye] as Vec3, rim, tweak));
        for (const e of run(runtime, 3.2)) if (e.type !== 'shootout') log.push(JSON.stringify(e));
      }
      const ball = runtime.objects.get('ball')!;
      return { log, pos: [...ball.body.pos], score: runtime.shootout?.score, tick: runtime.tick };
    };
    const a = await play(), b = await play();
    expect(a).toEqual(b);
    expect(a.log.length).toBeGreaterThan(5);
  });

  it('restores the high score and the ball position from saved state', async () => {
    const { runtime } = await open(undefined, { version: '0.1-draft', minigames: { shootout: { highScore: 21, plays: 4 } }, objects: { ball: { position: [-3, 0.125, 2] } } });
    expect(runtime.shootout).toMatchObject({ highScore: 21, plays: 4 });
    expect(runtime.objects.get('ball')!.body.pos).toEqual([-3, 0.125, 2]);
    // Reset still goes to the spawn point from interactions.json, not to the saved position.
    runtime.resetObject('ball');
    expect(runtime.objects.get('ball')!.body.pos).toEqual([9, 0.12, 1.2]);
    run(runtime, 2);
    expect(runtime.snapshot().objects.ball?.position[0]).toBeCloseTo(9, 6);
  });

  it('follows edited rules', async () => {
    const { runtime } = await court();
    runtime.setRules({ durationSec: 10, pointsPerBasket: 5, threePointRadius: 3 });
    expect(runtime.shootout?.timeLeft).toBe(10);
    tipOff(runtime);
    runtime.shoot(aim(runtime, FREE_THROW, HOME)); // 4.2 m out: beyond the new 3 m arc
    const events = run(runtime, 11);
    expect(ofType(events, 'score')[0]).toMatchObject({ points: 6, three: true, counted: true });
    expect(runtime.shootout).toMatchObject({ phase: 'over', highScore: 6 });
  });
});

describe('aim assist', () => {
  it('turns a nearly right shot into a make and leaves a bad one alone', async () => {
    const { runtime } = await court(true);
    pickUp(runtime);
    const exact = aim(runtime, FREE_THROW, HOME);
    const speed = (p: number): number => Math.hypot(...runtime.plannedShot(p).velocity);
    const raw = (p: number): number => Math.hypot(...runtime.launchVelocity(p));
    // 3 % too hard and slightly off line: assist pulls most of the error out.
    runtime.player.look(0.02, 0);
    const near = (raw(exact) * 1.03 - MIN_SHOT_SPEED) / (MAX_SHOT_SPEED - MIN_SHOT_SPEED);
    const planned = runtime.plannedShot(near);
    expect(planned.locked).toBe(true);
    expect(Math.abs(speed(near) - raw(exact))).toBeLessThan(0.35 * 0.03 * raw(exact));
    runtime.shoot(near);
    expect(ofType(run(runtime, 2.5), 'score')).toHaveLength(1);

    // 15 % too hard: not close, so it flies exactly as thrown.
    pickUp(runtime);
    const far = (raw(aim(runtime, FREE_THROW, HOME)) * 1.15 - MIN_SHOT_SPEED) / (MAX_SHOT_SPEED - MIN_SHOT_SPEED);
    expect(runtime.plannedShot(far).locked).toBe(false);
    expect(runtime.plannedShot(far).velocity).toEqual(runtime.launchVelocity(far));
    // Good power but aimed 6° wide: also untouched.
    runtime.player.look(0.105, 0);
    expect(runtime.plannedShot(aim(runtime, FREE_THROW, HOME)).locked).toBe(true);
    runtime.player.look(0.105, 0);
    expect(runtime.plannedShot(exact).locked).toBe(false);
  });

  it('reports the lock through aimArc for the HUD', async () => {
    const { runtime } = await court(true);
    pickUp(runtime);
    const power = aim(runtime, FREE_THROW, HOME);
    const arc = new Float32Array(90);
    runtime.aimArc(power, arc);
    expect(runtime.aimLocked).toBe(true);
    runtime.aimArc(0.9, arc);
    expect(runtime.aimLocked).toBe(false);
  });
});

describe('NPC hook', () => {
  it('calls agents once per tick with a read view and a few actions', async () => {
    const { runtime } = await court();
    const seen: { tick: number; dt: number; phase: string | undefined; state: string | undefined }[] = [];
    let resets = 0;
    const spy: WorldAgent = {
      role: 'spy',
      reset: () => void resets++,
      update(world: AgentWorld, dt: number) {
        seen.push({ tick: world.tick, dt, phase: world.minigame?.phase, state: world.object('ball')?.state });
        if (world.tick === 5) world.emit('hello', { n: world.random() });
      },
    };
    runtime.setAgent(spy);
    expect(resets).toBe(1);
    expect(runtime.getAgent('spy')).toBe(spy);
    const events = run(runtime, 10 * TICK);
    expect(seen.map((s) => s.tick)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(seen.every((s) => s.dt === TICK && s.phase === 'idle')).toBe(true);
    const [hello] = ofType(events, 'custom');
    expect(hello?.name).toBe('hello');
    expect((hello?.detail as { n: number }).n).toBeGreaterThanOrEqual(0);
    runtime.setAgent('spy');
    expect(runtime.getAgent('spy')).toBeNull();
  });

  it('lets a rebounder NPC take over from the built-in ball return and pass the ball back', async () => {
    const { runtime } = await court();
    let passes = 0;
    const rebounder: WorldAgent = {
      role: 'rebounder',
      update(world) {
        const game = world.minigame;
        const ball = game ? world.object(game.ball) : null;
        if (!game || !ball || game.phase !== 'playing' || !world.player.canHold) return;
        if (ball.heldBy === null && !ball.incoming && ball.shot?.done) {
          const e = world.player.eye;
          if (world.pass(ball.id, [e[0], e[1] - 0.3, e[2]], 0.8)) passes++;
        }
      },
    };
    runtime.setAgent('ball-return');
    runtime.setAgent(rebounder);
    expect(runtime.getAgent('ball-return')).toBeNull();
    expect(runtime.getAgent('rebounder')).toBe(rebounder);
    tipOff(runtime);
    runtime.shoot(aim(runtime, FREE_THROW, HOME));
    const events = run(runtime, 5);
    expect(ofType(events, 'score')).toHaveLength(1);
    expect(passes).toBeGreaterThanOrEqual(1);
    expect(ofType(events, 'grab').some((g) => g.by === 'agent')).toBe(true);
    expect(runtime.held).toBe('ball');
  });

  it('lets an agent carry an object, and only that agent can move or release it', async () => {
    const { runtime } = await court();
    const ball = runtime.objects.get('ball')!;
    const log: string[] = [];
    const carrier: WorldAgent = {
      role: 'carrier',
      body: { position: [0, 0, 0], heading: 0, radius: 0.3, height: 1.7, color: 0x8b5cf6 },
      update(world) {
        const b = world.object('ball')!;
        if (world.tick === 0) log.push(`pickup:${world.carry('ball', [1, 0.9, 1])}`);
        else if (world.tick < 60) world.carry('ball', [1 + world.tick * 0.01, 0.9, 1]);
        else if (world.tick === 60) log.push(`held:${b.heldBy}:${b.state}`, `release:${world.release('ball', [0, 2, 0])}`);
      },
    };
    const thief: WorldAgent = {
      role: 'thief',
      update(world) {
        if (world.tick === 30) log.push(`steal:${world.carry('ball', [5, 1, 5])}:${world.release('ball')}:${world.giveToPlayer('ball')}`);
      },
    };
    runtime.setAgent(carrier);
    runtime.setAgent(thief);
    expect(runtime.bodies.map((b) => b.role)).toEqual(['carrier']);
    run(runtime, 0.25);
    expect(ball.body.pos[0]).toBeCloseTo(1.29, 6); // carried, not simulated
    expect(ball.body.pos[1]).toBe(0.9);
    expect(runtime.canGrab()).toBeNull();
    run(runtime, 0.5);
    expect(log).toEqual(['pickup:true', 'steal:false:false:false', 'held:carrier:held', 'release:true']);
    expect(ball.body.pos[1]).not.toBe(0.9); // falling again
    // Removing an agent drops what it carries.
    runtime.setAgent({ role: 'holder', update: (world) => void world.carry('ball', [0, 3, 0]) });
    run(runtime, 0.1);
    expect(ball.body.pos).toEqual([0, 3, 0]);
    runtime.setAgent('holder');
    run(runtime, 0.5);
    expect(ball.body.pos[1]).toBeLessThan(3);
  });

  it('keeps the built-in ball return as a patient safety net next to an NPC', async () => {
    const { runtime } = await court();
    runtime.setAgent(new BallReturnAgent(4));
    tipOff(runtime);
    runtime.player.spawn(FREE_THROW, HOME);
    runtime.shoot(0.02);
    let events = run(runtime, 4);
    expect(ofType(events, 'grab')).toHaveLength(0); // still giving the (absent) NPC its chance
    events = run(runtime, 2);
    expect(ofType(events, 'grab').filter((g) => g.by === 'agent')).toHaveLength(1);
    expect(runtime.held).toBe('ball');
  });

  it('stops agents while editing', async () => {
    const { runtime } = await court();
    let calls = 0;
    runtime.setAgent({ role: 'counter', update: () => void calls++ });
    runtime.agentsEnabled = false;
    run(runtime, 0.1);
    expect(calls).toBe(0);
    runtime.agentsEnabled = true;
    run(runtime, 0.1);
    expect(calls).toBe(12);
  });

  it('refuses to hand over a ball the player already holds', async () => {
    const { runtime } = await court();
    pickUp(runtime);
    let result: boolean | null = null;
    runtime.setAgent({ role: 'giver', update: (world) => void (result = world.giveToPlayer('ball')) });
    run(runtime, TICK);
    expect(result).toBe(false);
  });
});

describe('Shootout clock', () => {
  const def = parseInteractions({
    objects: [
      { id: 'ball', kind: 'grabbable', physics: { radius: 0.12 } },
      { id: 'rim', kind: 'trigger', shape: { type: 'cylinder', center: [0, 3, 0], radius: 0.2, height: 0.1 }, on: { enterFromAbove: { event: 'score', target: 'ball' } } },
    ],
    minigames: [{ id: 'm', type: 'basketball-shooting', ball: 'ball', targets: ['rim'], rules: { durationSec: 5, pointsPerBasket: 2 } }],
  }).interactions.minigames[0]!;

  it('ignores shots and baskets outside a game', () => {
    const game = new Shootout(def, { highScore: 4, plays: 1 });
    game.shot();
    game.basket(2);
    expect(game).toMatchObject({ phase: 'idle', score: 0, attempts: 0, highScore: 4, plays: 1, timeLeft: 5 });
  });

  it('gives up waiting for a shot that never comes down', () => {
    const game = new Shootout(def);
    game.start();
    const out: Parameters<Shootout['tick']>[2] = [];
    for (let i = 0; i < 120 * 20 && game.phase !== 'over'; i++) game.tick(TICK, true, out);
    expect(game.phase).toBe('over');
    expect(out.at(-1)?.kind).toBe('over');
  });
});

describe('worlds without a minigame', () => {
  it('still simulate, with no Shootout to start', async () => {
    const { doc, scene } = await open();
    const plain = { ...doc, interactions: { ...doc.interactions, minigames: [] } };
    const { runtime } = createRuntime(plain, scene);
    expect(runtime.shootout).toBeNull();
    expect(runtime.startShootout()).toBe(false);
    expect(runtime.getAgent('ball-return')).toBeNull();
    run(runtime, 1);
    expect(runtime.snapshot().minigames).toEqual({});
  });
});
