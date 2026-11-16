/**
 * Repro for the 2026-11-16 browser play test of the Shootout (preview/playtest 4c51be5):
 * 7 shots, 0 makes, "0 of 3 shots", no rebounder seen, ball fetched with E. Desktop mouse, 1280x800.
 *
 * Deterministic and headless: the real court.wgif, the player's own runtime, NPC and controls,
 * driven the way the viewer drives them (60 fps frames, held/released charge button).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRebounder } from '../src/ai.js';
import { PlayerControls } from '../src/controls.js';
import { BallReturnAgent } from '../src/sim/agents.js';
import { CHARGE_SEC, MAX_SHOT_SPEED, MIN_SHOT_SPEED, type PlayerInput, type RuntimeEvent, type WorldRuntime } from '../src/sim/runtime.js';
import { GRAVITY } from '../src/sim/ball.js';
import type { Vec3 } from '../src/sim/vec.js';
import { ofType, open } from './helpers.js';

const HOME: Vec3 = [12.425, 3.05, 0];
const FREE_THROW_EYE: Vec3 = [8.2, 1.7, 0];

/** The court as main.ts mounts it: rebounder NPC plus the 7 s ball-return safety net. */
async function mounted() {
  const opened = await open();
  const npc = await createRebounder(opened.doc.world);
  const rt = opened.runtime;
  if (npc) {
    rt.setAgent(npc);
    if (rt.shootout) rt.setAgent(new BallReturnAgent(7));
  }
  const input: PlayerInput = { forward: 0, right: 0, run: false, charging: false };
  const events: RuntimeEvent[] = [];
  /** One 60 fps browser frame (viewer.ts frame(): rt.update(dt, input)), then the NPC's model step lands. */
  const frame = async (): Promise<void> => {
    rt.update(1 / 60, input);
    await npc?.settled();
    events.push(...rt.drain());
  };
  const frames = async (sec: number): Promise<void> => {
    for (let i = 0; i < Math.round(sec * 60); i++) await frame();
  };
  return { ...opened, rt, npc, input, events, frame, frames };
}

/** Power that sends a raw (unassisted) shot through the rim centre from where the player stands, looking at it. */
function idealPower(rt: WorldRuntime, rim: Vec3): number {
  const o = rt.releasePoint(), v = rt.launchVelocity(1);
  const flat = Math.hypot(v[0], v[2]);
  const tan = v[1] / flat, cos = flat / Math.hypot(flat, v[1]);
  const d = Math.hypot(rim[0] - o[0], rim[2] - o[2]), h = rim[1] - o[1];
  return (Math.sqrt((GRAVITY * d * d) / (2 * cos * cos * (d * tan - h))) - MIN_SHOT_SPEED) / (MAX_SHOT_SPEED - MIN_SHOT_SPEED);
}

/** Holds the shoot button for whole 60 fps frames, as a person does, then lets go. */
async function holdAndRelease(m: Awaited<ReturnType<typeof mounted>>, holdSec: number): Promise<void> {
  m.input.charging = true;
  await m.frames(holdSec);
  m.input.charging = false;
  await m.frames(3);
}

describe('play test 2026-11-16: can the Shootout be won from the UI path?', () => {
  it('scores a free throw driven like the browser (frames, held button, default aim assist)', async () => {
    const m = await mounted();
    m.rt.startShootout();
    await m.frames(3.1);
    expect(m.rt.shootout?.phase).toBe('playing');
    m.rt.player.spawn(FREE_THROW_EYE, HOME);
    // A person holds for whole frames; land within ~2 frames of the ideal hold.
    await holdAndRelease(m, idealPower(m.rt, HOME) * CHARGE_SEC + 2 / 60);
    expect(m.rt.shootout?.attempts).toBe(1);
    expect(m.rt.shootout?.makes).toBe(1);
    expect(ofType(m.events, 'score')[0]).toMatchObject({ counted: true, trigger: 'rim_home' });
  });

  it('forgives a 3° aim error at the free-throw line (aim assist tuning)', async () => {
    const m = await mounted();
    m.rt.startShootout();
    await m.frames(3.1);
    m.rt.player.spawn(FREE_THROW_EYE, HOME);
    const p = idealPower(m.rt, HOME);
    m.rt.player.look((3 * Math.PI) / 180, 0);
    await holdAndRelease(m, p * CHARGE_SEC);
    expect(m.rt.shootout?.makes).toBe(1);
  });

  it('can make it from the UI spawn point too, after turning to face the hoop', async () => {
    const m = await mounted();
    m.rt.startShootout();
    await m.frames(3.1);
    // The UI starts the player at the manifest spawn [0, 1.7, 9.5] looking at centre court: both
    // hoops are ~90° to the side and ~15.6 m away.
    const eye = m.rt.player.eye;
    m.rt.player.spawn([eye[0], eye[1], eye[2]], HOME);
    await holdAndRelease(m, idealPower(m.rt, HOME) * CHARGE_SEC);
    expect(m.rt.shootout?.makes).toBe(1);
  });

  it('counts every shot released while the clock runs; E-drops and the pre-GO countdown do not count', async () => {
    const m = await mounted();
    m.rt.startShootout();
    // Pressing during the countdown does nothing.
    await holdAndRelease(m, 0.5);
    expect(m.events.some((e) => e.type === 'shot')).toBe(false);
    await m.frames(3);
    expect(m.rt.shootout?.phase).toBe('playing');
    let shots = 0;
    for (let i = 0; i < 4; i++) {
      for (let t = 0; t < 15 * 60 && !m.rt.held; t++) await m.frame();
      expect(m.rt.held).toBe('ball');
      await holdAndRelease(m, 0.4 + 0.2 * i);
      shots++;
      expect(m.rt.shootout?.attempts).toBe(shots);
    }
    // E with the ball in hand is a drop (a little toss), not a shot.
    for (let t = 0; t < 15 * 60 && !m.rt.held; t++) await m.frame();
    expect(m.rt.drop()).toBe(true);
    expect(m.rt.shootout?.attempts).toBe(shots);
  });
});

describe('play test 2026-11-16: rebounder NPC', () => {
  it('is installed from court.wgif, has a body for the viewer to draw, and brings a miss back', async () => {
    const m = await mounted();
    expect(m.npc?.info).toMatchObject({ runtime: 'rules', usedFallback: false, tickHz: 10 });
    expect(m.rt.bodies.map((b) => b.role)).toEqual(['rebounder']);
    m.rt.startShootout();
    await m.frames(3.1);
    m.rt.player.spawn(FREE_THROW_EYE, HOME);
    await holdAndRelease(m, 0.2); // a short, weak miss
    const before = m.events.length;
    for (let t = 0; t < 15 * 60 && !m.rt.held; t++) await m.frame();
    expect(m.rt.held).toBe('ball');
    // The NPC carried it (model state went through chase/carry), not only the 7 s safety net.
    expect(m.events.slice(before).some((e) => e.type === 'grab' && e.by === 'agent')).toBe(true);
  });
});

describe('play test 2026-11-16: desktop mouse while the pointer is captured', () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  afterEach(() => {
    Object.assign(globalThis, saved);
  });

  it('a left press with the pointer locked on #stage charges a shot', () => {
    const win = new EventTarget(), doc = Object.assign(new EventTarget(), { pointerLockElement: null as unknown, exitPointerLock() {} });
    Object.assign(globalThis, { window: win, document: doc });
    const el = () => Object.assign(new EventTarget(), { hidden: true, style: {} as Record<string, string> });
    // main.ts passes #stage (a DIV holding the canvas); requestPointerLock() is called on it.
    const stage = Object.assign(el(), { tagName: 'DIV', requestPointerLock() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }) });
    let primary = 0;
    const controls = new PlayerControls(stage as unknown as HTMLElement, { stick: el(), knob: el(), action: el() } as never, {
      onPrimary: () => primary++, onUse() {}, onReset() {}, onLockChange() {},
    });
    controls.setEnabled(true);
    doc.pointerLockElement = stage;
    doc.dispatchEvent(new Event('pointerlockchange'));
    expect(controls.locked).toBe(true);
    // Under pointer lock the browser targets the lock element, not the canvas under the crosshair.
    const down = Object.assign(new Event('pointerdown'), { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 640, clientY: 400, preventDefault() {} });
    Object.defineProperty(down, 'target', { value: stage });
    stage.dispatchEvent(down);
    expect(controls.input.charging).toBe(true);
    expect(primary).toBe(1);
    doc.dispatchEvent(new Event('mouseup'));
    expect(controls.input.charging).toBe(false);
  });
});
