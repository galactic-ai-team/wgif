/**
 * Regression tests for the second Shootout play test (2026-11-16, PR #29 preview oof5hxca9):
 * desktop 1 attempt of many / 0 makes, phone 0 makes, rebounder never seen bringing the ball back,
 * `Response.clone` errors from sw.js, and a clipped phone header.
 *
 * What a person does, measured headlessly on the real court.wgif: press ▶ Shootout, then hold the
 * button for 0.3–1.2 s without watching the bar. Those holds must score often from where the game
 * puts them, every press with the ball in hand must count, and the ball must come back fast.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createRebounder, reboundSpot } from '../src/ai.js';
import { PlayerControls } from '../src/controls.js';
import { BallReturnAgent } from '../src/sim/agents.js';
import { FREE_THROW_DISTANCE, MIN_HOLD_SEC, type PlayerInput, type RuntimeEvent } from '../src/sim/runtime.js';
import { horizontalDistance, type Vec3 } from '../src/sim/vec.js';
import { open } from './helpers.js';

const HOME: Vec3 = [12.425, 3.05, 0];

/** The court as main.ts mounts it and starts a Shootout: NPC under the faced hoop, 2 s / 4 s ball-return net. */
async function started(opts: { deadline?: number | null; standBy?: boolean } = {}) {
  const opened = await open();
  const rt = opened.runtime;
  const npc = await createRebounder(opened.doc.world);
  if (npc) {
    rt.setAgent(npc);
    rt.setAgent(new BallReturnAgent(opts.deadline === null ? 7 : 2, opts.deadline === undefined ? 4 : opts.deadline));
  }
  const input: PlayerInput = { forward: 0, right: 0, run: false, charging: false };
  const events: RuntimeEvent[] = [];
  const frame = async (): Promise<void> => {
    rt.update(1 / 60, input);
    await npc?.settled();
    events.push(...rt.drain());
  };
  const frames = async (sec: number): Promise<void> => {
    for (let i = 0; i < Math.round(sec * 60); i++) await frame();
  };
  expect(rt.startShootout()).toBe(true);
  if (npc && rt.shootoutTarget && opts.standBy !== false) npc.standBy(reboundSpot(rt.shootoutTarget, rt.player.feet));
  await frames(3.1);
  expect(rt.shootout?.phase).toBe('playing');
  const hold = async (sec: number): Promise<void> => {
    input.charging = true;
    await frames(sec);
    input.charging = false;
    await frame();
  };
  /** Frames until the ball is back in hand; returns the seconds waited (or Infinity). */
  const awaitBall = async (limit = 15): Promise<number> => {
    for (let i = 0; i < limit * 60; i++) {
      if (rt.held) return i / 60;
      await frame();
    }
    return Infinity;
  };
  return { ...opened, rt, npc, input, events, frame, frames, hold, awaitBall };
}

describe('Shootout for people: tip-off', () => {
  it('puts the shooter on the free-throw line of the nearest hoop, facing it, ball in hand', async () => {
    const m = await started();
    expect(m.rt.shootoutTarget).toEqual(HOME);
    expect(horizontalDistance(m.rt.player.eye, HOME)).toBeCloseTo(FREE_THROW_DISTANCE, 1);
    expect(m.rt.player.eye[0]).toBeCloseTo(HOME[0] - FREE_THROW_DISTANCE, 1);
    const f = m.rt.player.forward;
    expect(f[0]).toBeGreaterThan(0.9); // looking down +x at the home rim
    expect(m.rt.held).toBe('ball');
    // The NPC waits under that hoop, in view, instead of at centre court.
    const body = m.npc!.body.position;
    expect(horizontalDistance(body, HOME)).toBeLessThan(2);
  });
});

describe('Shootout for people: a natural hold scores', () => {
  it('holds of 0.30–1.20 s from the tip-off spot score at least 60 % of the time', async () => {
    let made = 0, tried = 0;
    for (let ms = 300; ms <= 1200; ms += 50) {
      const m = await started();
      await m.hold(ms / 1000);
      await m.frames(2.5);
      tried++;
      made += m.rt.shootout!.makes;
      expect(m.rt.shootout!.attempts).toBe(1);
    }
    // Measured 14/19 (74 %) with CHARGE_SEC 2 and the ±30 % / 8° assist; it was 4/19 before.
    expect(made / tried).toBeGreaterThanOrEqual(0.6);
  }, 60_000);

  it('still scores with a few degrees of aim error after the mouse moved', async () => {
    for (const deg of [-4, 4]) {
      const m = await started();
      m.rt.player.look((deg * Math.PI) / 180, 0);
      await m.hold(0.7);
      await m.frames(2.5);
      expect(m.rt.shootout!.makes).toBe(1);
    }
  });
});

describe('Shootout for people: every press with the ball counts', () => {
  it('a quick tap (the click that captures the mouse) does not throw the ball away', async () => {
    const m = await started();
    await m.hold(MIN_HOLD_SEC / 2);
    await m.frames(0.5);
    expect(m.rt.held).toBe('ball');
    expect(m.rt.shootout!.attempts).toBe(0);
    await m.hold(0.6);
    expect(m.rt.shootout!.attempts).toBe(1);
  });

  it('a press turned into a drag (input.cancel) drops the charge without a shot', async () => {
    const m = await started();
    m.input.charging = true;
    await m.frames(0.5);
    expect(m.rt.charging).toBe(true);
    m.input.charging = false;
    m.input.cancel = true;
    await m.frames(0.5);
    expect(m.rt.charging).toBe(false);
    expect(m.rt.held).toBe('ball');
    expect(m.rt.shootout!.attempts).toBe(0);
    // The next press shoots normally.
    m.input.cancel = false;
    await m.hold(0.7);
    expect(m.rt.shootout!.attempts).toBe(1);
  });

  it('a full 60 s round of 0.3–1.2 s holds: every press counts and the ball is back within 5 s', async () => {
    const m = await started();
    let presses = 0, worstWait = 0, s = 7;
    const rand = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    while (m.rt.shootout!.phase === 'playing' && m.rt.shootout!.timeLeft > 2) {
      const wait = await m.awaitBall();
      if (m.rt.shootout!.phase !== 'playing' || m.rt.shootout!.timeLeft <= 2) break;
      if (presses > 0) worstWait = Math.max(worstWait, wait);
      await m.frames(0.25); // a person's reaction time
      await m.hold(0.3 + rand() * 0.9);
      presses++;
      expect(m.rt.shootout!.attempts).toBe(presses);
    }
    expect(presses).toBeGreaterThanOrEqual(10); // was ~6 with 7–11 s returns
    // 4 s deadline from the release, plus a pass already in the air finishing (measured worst 4.77 s; was ~11 s).
    expect(worstWait).toBeLessThanOrEqual(5);
    // This seed draws many holds at the extremes of 0.3–1.2 s (measured 5 of 13); the sweep above is the make-rate gate.
    expect(m.rt.shootout!.makes).toBeGreaterThanOrEqual(4);
  }, 60_000);
});

describe('Shootout for people: the ball comes back', () => {
  it('the NPC alone (no 4 s deadline) brings a miss back from under the hoop', async () => {
    const m = await started({ deadline: null });
    await m.hold(0.25); // weak: short of the rim
    const before = m.events.length;
    const wait = await m.awaitBall();
    expect(wait).toBeLessThan(7);
    // It came as the NPC's pass (a pass is "incoming"; the safety net would take 7 s + the shot).
    expect(m.events.slice(before).some((e) => e.type === 'grab' && e.by === 'agent')).toBe(true);
  });

  it('the 4 s deadline takes the ball from an NPC that keeps it', async () => {
    const m = await started();
    // A stuck rebounder: picks the loose ball up and never passes it.
    m.rt.setAgent('rebounder');
    m.rt.setAgent({
      role: 'hog',
      update: (world) => {
        const b = world.object('ball');
        if (b && b.heldBy !== 'player' && (b.heldBy === 'hog' || b.state === 'resting' || b.state === 'grounded')) world.carry('ball', [HOME[0] - 2, 1, 3]);
      },
    });
    await m.hold(0.7);
    const t0 = m.rt.time;
    const wait = await m.awaitBall();
    expect(wait).toBeLessThan(5);
    expect(m.rt.time - t0).toBeGreaterThanOrEqual(3.9);
    expect(m.rt.held).toBe('ball');
  });
});

describe('controls: holds register however the mouse is (or is not) captured', () => {
  const saved = { window: globalThis.window, document: globalThis.document, matchMedia: (globalThis as { matchMedia?: unknown }).matchMedia };
  afterEach(() => {
    Object.assign(globalThis, saved);
  });

  function rig(coarse = false) {
    const win = new EventTarget(), doc = Object.assign(new EventTarget(), { pointerLockElement: null as unknown, exitPointerLock() {} });
    Object.assign(globalThis, { window: win, document: doc, matchMedia: (q: string) => ({ matches: coarse && q.includes('coarse') }) });
    const el = (tagName = 'DIV') => Object.assign(new EventTarget(), { tagName, hidden: true, style: {} as Record<string, string>, setPointerCapture() {} });
    const canvas = Object.assign(el('CANVAS'), { requestPointerLock() { /* refused: no lock */ }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }) });
    let primary = 0, lockChanges = 0;
    const action = el('BUTTON');
    const controls = new PlayerControls(canvas as unknown as HTMLElement, { stick: el(), knob: el(), action } as never, {
      onPrimary: () => primary++, onUse() {}, onReset() {}, onLockChange: () => lockChanges++,
    });
    controls.setEnabled(true);
    const pointer = (target: EventTarget, type: string, x: number, y: number, pointerType = 'mouse') => {
      const e = Object.assign(new Event(type), { pointerType, button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
      Object.defineProperty(e, 'target', { value: target });
      target.dispatchEvent(e);
    };
    const key = (type: string, code: string) => {
      const e = Object.assign(new Event(type), { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
      Object.defineProperty(e, 'target', { value: null });
      win.dispatchEvent(e);
    };
    return { controls, canvas, action, win, doc, pointer, key, primary: () => primary, lockChanges: () => lockChanges };
  }

  it('without pointer lock a held press charges and its release shoots', () => {
    const r = rig();
    r.pointer(r.canvas, 'pointerdown', 640, 400);
    expect(r.controls.locked).toBe(false);
    expect(r.controls.input.charging).toBe(true);
    expect(r.primary()).toBe(1);
    r.pointer(r.canvas, 'pointermove', 644, 402); // a steady hand wobbles a little
    expect(r.controls.input.charging).toBe(true);
    r.pointer(r.canvas, 'pointerup', 644, 402);
    expect(r.controls.input.charging).toBe(false);
    expect(r.controls.input.cancel).toBe(false);
  });

  it('without pointer lock a drag looks around and cancels the charge (no shot), and Space still works after', () => {
    const r = rig();
    r.pointer(r.canvas, 'pointerdown', 640, 400);
    r.pointer(r.canvas, 'pointermove', 700, 400);
    expect(r.controls.input.charging).toBe(false);
    expect(r.controls.input.cancel).toBe(true);
    expect(r.controls.consumeLook()[0]).not.toBe(0);
    r.pointer(r.canvas, 'pointerup', 700, 400);
    expect(r.controls.input.cancel).toBe(true); // latched until the next press: no frame can read it as a release
    r.key('keydown', 'Space');
    expect(r.controls.input).toMatchObject({ charging: true, cancel: false });
    r.key('keyup', 'Space');
    expect(r.controls.input.charging).toBe(false);
  });

  it('a phone shows touch controls from the start, and a first touch anywhere switches them on', () => {
    expect(rig(true).controls.touch).toBe(true);
    const r = rig(false);
    expect(r.controls.touch).toBe(false);
    const header = new EventTarget();
    r.pointer(header, 'pointerdown', 10, 10, 'touch');
    // The capture listener sits on window; a real DOM bubbles to it, the stub dispatches there.
    r.pointer(r.win, 'pointerdown', 10, 10, 'touch');
    expect(r.controls.touch).toBe(true);
    expect(r.lockChanges()).toBe(1);
  });

  it('the touch Shoot button charges while held and shoots on release', () => {
    const r = rig(true);
    r.pointer(r.action, 'pointerdown', 340, 760, 'touch');
    expect(r.controls.input.charging).toBe(true);
    r.pointer(r.action, 'pointerup', 340, 760, 'touch');
    expect(r.controls.input.charging).toBe(false);
  });
});

describe('service worker: network-first responses are cloned before the page reads them', () => {
  it('caches an intact copy even when the page consumes the body first (no "body is already used")', async () => {
    const src = readFileSync(fileURLToPath(new URL('../src/sw.ts', import.meta.url)), 'utf8')
      .replace("'__WGIF_CACHE_NAME__'", "'wgif-player-test'")
      .replace("'__WGIF_PRECACHE_URLS__'", `'${JSON.stringify(['./'])}'`);
    const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const listeners: Record<string, (e: unknown) => void> = {};
    const self = { location: { origin: 'https://p.test', href: 'https://p.test/sw.js' }, addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f), skipWaiting: async () => {}, clients: { claim: async () => {} } };
    const put: string[] = [];
    const errors: unknown[] = [];
    const cache = { put: async (_req: unknown, res: Response) => void put.push(await res.text()), match: async () => undefined };
    // caches.open resolves a macrotask later, after the page has read the body.
    const caches = { open: () => new Promise((r) => setTimeout(() => r(cache), 5)), match: async () => undefined, keys: async () => [], delete: async () => true };
    const fetchStub = async () => new Response('world-bytes', { status: 200 });
    new Function('self', 'caches', 'fetch', js)(self, caches, fetchStub);
    let responded: Promise<Response> | null = null;
    const onRejection = (e: unknown) => errors.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      listeners.fetch!({ request: new Request('https://p.test/assets/extra.bin'), respondWith: (p: Promise<Response>) => (responded = p) });
      const res = await responded!;
      expect(await res.text()).toBe('world-bytes'); // the page consumes the body right away
      await new Promise((r) => setTimeout(r, 30));
      expect(put).toEqual(['world-bytes']);
      expect(errors).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
