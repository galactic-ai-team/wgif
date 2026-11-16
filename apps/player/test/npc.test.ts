import { packWgif, unpackWgif } from '@wgif/format';
import { createNpcHookFromModel, type NpcAction, type NpcModel } from '@wgif/ai';
import { describe, expect, it } from 'vitest';
import { RebounderAgent, createRebounder } from '../src/ai.js';
import { BallReturnAgent } from '../src/sim/agents.js';
import { GRAVITY } from '../src/sim/ball.js';
import { MAX_SHOT_SPEED, MIN_SHOT_SPEED, type RuntimeEvent, type WorldRuntime } from '../src/sim/runtime.js';
import type { Vec3 } from '../src/sim/vec.js';
import { courtBytes, open } from './helpers.js';

const HOME: Vec3 = [12.425, 3.05, 0];
const FREE_THROW: Vec3 = [8.2, 1.7, 0];

function aim(runtime: WorldRuntime, eye: Vec3, rim: Vec3, tweak = 1): number {
  runtime.player.spawn(eye, rim);
  const o = runtime.releasePoint(), v = runtime.launchVelocity(1);
  const flat = Math.hypot(v[0], v[2]);
  const tan = v[1] / flat, cos = flat / Math.hypot(flat, v[1]);
  const d = Math.hypot(rim[0] - o[0], rim[2] - o[2]), h = rim[1] - o[1];
  return (Math.sqrt((GRAVITY * d * d) / (2 * cos * cos * (d * tan - h))) * tweak - MIN_SHOT_SPEED) / (MAX_SHOT_SPEED - MIN_SHOT_SPEED);
}

/** The court with only the NPC to bring the ball back (no built-in ball return). */
async function courtWithNpc() {
  const opened = await open();
  const npc = await createRebounder(opened.doc.world);
  if (!npc) throw new Error('the court has no rebounder');
  opened.runtime.setAgent('ball-return');
  opened.runtime.setAgent(npc);
  return { ...opened, npc };
}

/** The live mount() wiring: the NPC first, then the 7s safety net. */
async function courtLive() {
  const opened = await open();
  const npc = await createRebounder(opened.doc.world);
  if (!npc) throw new Error('the court has no rebounder');
  opened.runtime.setAgent(npc);
  opened.runtime.setAgent(new BallReturnAgent(7));
  return { ...opened, npc };
}

/** The court with the ONNX model listed first and its bytes corrupt, so only the rules fallback can run. */
async function brokenOnnxFirstCourt(): Promise<Uint8Array> {
  const world = await unpackWgif(courtBytes());
  world.manifest.models = [...(world.manifest.models ?? [])].reverse();
  return packWgif(world.manifest, {
    ...world.files,
    'models/rebounder-mlp.onnx': new Uint8Array(100),
  });
}

/** One 60 fps frame: two fixed ticks, then let the model's pending step land, as in the browser. */
async function frame(runtime: WorldRuntime, npc: RebounderAgent): Promise<RuntimeEvent[]> {
  runtime.step();
  runtime.step();
  await npc.settled();
  return runtime.drain();
}

/** Plays frames until the player holds the ball again. Returns the simulated seconds it took and the model states seen. */
async function untilReturned(runtime: WorldRuntime, npc: RebounderAgent, limitSec = 15): Promise<{ seconds: number; states: string[]; events: RuntimeEvent[] }> {
  const t0 = runtime.time, states: string[] = [], events: RuntimeEvent[] = [];
  while (runtime.time - t0 < limitSec) {
    events.push(...(await frame(runtime, npc)));
    if (states.at(-1) !== npc.state) states.push(npc.state);
    if (runtime.held) break;
  }
  return { seconds: runtime.time - t0, states, events };
}

async function tipOff(runtime: WorldRuntime, npc: RebounderAgent): Promise<void> {
  runtime.startShootout();
  while (runtime.shootout?.phase !== 'playing') await frame(runtime, npc);
  expect(runtime.held).toBe('ball');
}

describe('rebounder NPC (the court model through @wgif/ai)', () => {
  it('loads the rules model at its declared rate', async () => {
    const { npc } = await courtWithNpc();
    expect(npc.info).toMatchObject({ runtime: 'rules', usedFallback: false, tickHz: 10 });
    expect(npc.body.position).toEqual([0, 0, 6]);
  });

  it('fetches a made shot and passes it back within a few seconds', async () => {
    const { runtime, npc } = await courtWithNpc();
    await tipOff(runtime, npc);
    runtime.shoot(aim(runtime, FREE_THROW, HOME));
    const { seconds, states, events } = await untilReturned(runtime, npc);
    expect(events.filter((e) => e.type === 'score')).toHaveLength(1);
    expect(runtime.held).toBe('ball');
    expect(states).toEqual(expect.arrayContaining(['chase', 'pickup', 'carry', 'pass']));
    // It goes for the ball once, rather than stalling until a fallback hands it over.
    expect(states.filter((s) => s === 'chase')).toHaveLength(1);
    expect(seconds).toBeLessThan(6);
    expect(events.filter((e) => e.type === 'grab').map((e) => (e as Extract<RuntimeEvent, { type: 'grab' }>).by)).toEqual(['agent']);
  });

  it('fetches a miss too, from wherever it ends up', async () => {
    const { runtime, npc } = await courtWithNpc();
    await tipOff(runtime, npc);
    runtime.shoot(aim(runtime, [9, 1.7, -4], HOME, 0.85));
    const { seconds, events } = await untilReturned(runtime, npc);
    expect(events.filter((e) => e.type === 'score')).toHaveLength(0);
    expect(runtime.held).toBe('ball');
    expect(seconds).toBeLessThan(8);
  });

  it('keeps a Shootout going: several shots, each one returned', async () => {
    const { runtime, npc } = await courtWithNpc();
    await tipOff(runtime, npc);
    let made = 0;
    for (const [eye, tweak] of [[FREE_THROW, 1], [[6, 1.7, 2], 1], [FREE_THROW, 0.92], [[9.5, 1.7, -2.5], 1]] as const) {
      runtime.shoot(aim(runtime, [...eye] as Vec3, HOME, tweak));
      const { events } = await untilReturned(runtime, npc);
      made += events.filter((e) => e.type === 'score').length;
      expect(runtime.held).toBe('ball');
    }
    expect(runtime.shootout).toMatchObject({ phase: 'playing', attempts: 4 });
    expect(runtime.shootout?.makes).toBe(made);
    expect(made).toBeGreaterThanOrEqual(3);
  });

  it('leaves the ball at the feet of a player who cannot take it, and does not chase it again', async () => {
    const { runtime, npc } = await courtWithNpc();
    runtime.player.spawn(FREE_THROW, HOME);
    const ball = runtime.objects.get('ball')!;
    ball.body.pos[0] = 11; ball.body.pos[1] = 0.12; ball.body.pos[2] = 3; // loose, out on the court
    ball.body.resting = false;
    runtime.playerEnabled = false; // orbiting: nobody to pass to
    for (let i = 0; i < 60 * 8; i++) await frame(runtime, npc);
    expect(runtime.held).toBeNull();
    // Delivered near the player and left there, not carried around or fetched again and again.
    expect(Math.hypot(ball.body.pos[0] - runtime.player.feet[0], ball.body.pos[2] - runtime.player.feet[2])).toBeLessThan(2.2);
    expect(npc.state).toBe('idle');
    runtime.playerEnabled = true;
    expect(runtime.grab()).toBe(true);
  });

  it('stands still when its model fails, and the built-in ball return takes over', async () => {
    const { doc, runtime } = await open();
    let calls = 0;
    const broken: NpcModel = {
      id: 'broken',
      runtime: 'rules',
      state: 'idle',
      descriptor: {} as NpcModel['descriptor'],
      reset() {},
      async update(): Promise<NpcAction> {
        if (++calls > 2) throw new Error('model exploded');
        return { state: 'chase', velocity: [1, 0, 0], passBall: false, holdingBall: false, target: null };
      },
    };
    const npc = new RebounderAgent(createNpcHookFromModel(broken, 10), [0, 0, 6]);
    runtime.setAgent(npc);
    runtime.setAgent(new BallReturnAgent(1));
    expect(doc.world.manifest.id).toBeTruthy();
    await tipOff(runtime, npc);
    for (let i = 0; i < 30; i++) await frame(runtime, npc);
    expect(npc.failed?.message).toBe('model exploded');
    const at = [...npc.body.position];
    runtime.player.spawn(FREE_THROW, HOME);
    runtime.shoot(0.05);
    const { seconds } = await untilReturned(runtime, npc);
    expect(npc.body.position).toEqual(at);
    expect(runtime.held).toBe('ball');
    expect(seconds).toBeLessThan(5);
  });

  it('asks the model at its own rate, not on every simulation tick', async () => {
    const { runtime, npc } = await courtWithNpc();
    const hook = (npc as unknown as { hook: { tick: (...a: unknown[]) => unknown } }).hook;
    const original = hook.tick.bind(hook);
    let calls = 0;
    hook.tick = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };
    for (let i = 0; i < 60; i++) await frame(runtime, npc); // one simulated second
    expect(calls).toBeGreaterThanOrEqual(9);
    expect(calls).toBeLessThanOrEqual(11);
  });

  it('plays the same rebound the same way every time', async () => {
    const play = async () => {
      const { runtime, npc } = await courtWithNpc();
      await tipOff(runtime, npc);
      runtime.shoot(aim(runtime, FREE_THROW, HOME, 0.97));
      const { seconds, states } = await untilReturned(runtime, npc);
      return { seconds, states, npc: [...npc.body.position], ball: [...runtime.objects.get('ball')!.body.pos] };
    };
    expect(await play()).toEqual(await play());
  });

  it('returns the ball through the NPC, not the safety net, with the live mount wiring', async () => {
    // The safety net fires 7s after the ball goes dead; if it ever beats the
    // NPC to a return, the NPC never reaches carry/pass and the return takes
    // ~7s. The NPC's worst standard fetch (a far miss) takes ~6.1s.
    for (const [label, shoot] of [
      ['made shot', (r: WorldRuntime) => r.shoot(aim(r, FREE_THROW, HOME))],
      ['far miss', (r: WorldRuntime) => r.shoot(aim(r, [9, 1.7, -4], HOME, 0.85))],
    ] as const) {
      const { runtime, npc } = await courtLive();
      await tipOff(runtime, npc);
      shoot(runtime);
      const { seconds, states } = await untilReturned(runtime, npc);
      expect(runtime.held, label).toBe('ball');
      expect(states, label).toEqual(expect.arrayContaining(['chase', 'pickup', 'carry', 'pass']));
      expect(seconds, label).toBeLessThan(7);
    }
  });

  it('falls back to rules through the adapter when the ONNX model cannot load', async () => {
    const bytes = await brokenOnnxFirstCourt();
    const check = await unpackWgif(bytes);
    expect(check.report.errors).toEqual([]);
    expect(check.manifest.models?.[0]?.id).toBe('rebounder-mlp');
    const opened = await open(bytes);
    const npc = await createRebounder(opened.doc.world);
    expect(npc).not.toBeNull();
    expect(npc!.info).toMatchObject({ runtime: 'rules', usedFallback: true });
    opened.runtime.setAgent(npc!);
    opened.runtime.setAgent(new BallReturnAgent(7));
    await tipOff(opened.runtime, npc!);
    opened.runtime.shoot(aim(opened.runtime, FREE_THROW, HOME));
    const { seconds, states } = await untilReturned(opened.runtime, npc!);
    expect(opened.runtime.held).toBe('ball');
    expect(states).toEqual(expect.arrayContaining(['chase', 'pickup', 'carry', 'pass']));
    expect(seconds).toBeLessThan(7);
  });
});
