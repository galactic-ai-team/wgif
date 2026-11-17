#!/usr/bin/env node
/**
 * Headless real-browser play test of the Shootout (not part of CI: GPU/timing dependent).
 *
 *   npm i --no-save playwright-core        # or point NODE_PATH at a folder that has it
 *   node apps/player/e2e/shootout.e2e.mjs <url> [--chrome /usr/bin/google-chrome] [--rounds 1] [--seconds 60]
 *
 * <url> is a deployed preview or a local `vite preview` (http://localhost:4173/). WebGL runs on
 * SwiftShader. It plays like a person who does not watch the power bar: opens `?src=samples/court.wgif`,
 * "▶ Shootout", then, whenever the ball is in hand, a 300–1200 ms hold and release; it never
 * presses E or R. Profiles (--profile a,b): mouse (pointer lock, which headless Chrome grants),
 * mouse-nolock (requestPointerLock refused: plain press-and-hold), space, and touch (390x844 phone,
 * the on-screen Shoot button). Default: all four.
 * It reports attempts, makes, ball returns (ball back in hand after a shot) and console errors,
 * reading the page's scoreboard; with `?e2e` the player also exposes window.__wgif for exact counts.
 */
/* global innerWidth, setTimeout, Element */
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const base = args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:4173/';
const chrome = opt('chrome', process.env.CHROME ?? '/usr/bin/google-chrome');
const seconds = Number(opt('seconds', '60'));
const only = opt('profile', 'all');
const seed = Number(opt('seed', '7'));

let s = seed >>> 0;
const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function play(profile) {
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const phone = profile === 'touch';
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const mouse = profile === 'mouse' || profile === 'mouse-nolock';
  // mouse-nolock: a browser that refuses pointer lock (the press must still charge and shoot).
  if (profile === 'mouse-nolock') await page.addInitScript(() => { Element.prototype.requestPointerLock = () => Promise.reject(new Error('refused by the e2e profile')); });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const url = new URL(base);
  url.searchParams.set('e2e', '1');
  url.searchParams.set('src', 'samples/court.wgif');
  await page.goto(url.href, { waitUntil: 'load' });
  // Second load so the service worker controls the page (its fetch handler is what logged Response.clone errors).
  await sleep(1500);
  await page.reload({ waitUntil: 'load' });
  const tap = async (sel) => (phone ? page.tap(sel) : page.click(sel));
  await page.waitForSelector('#play:not([hidden])', { timeout: 60000 });
  // Header must not be clipped: every visible header control fully inside the viewport.
  const clipped = await page.evaluate(() => [...document.querySelectorAll('header .btn, header .brand')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ id: el.id || el.className, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.left < -0.5 || r.right > innerWidth + 0.5).map(({ id }) => id));
  const playVisible = await page.evaluate(() => { const r = document.getElementById('play').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
  await tap('#play');
  const hasHook = await page.evaluate(() => !!window.__wgif);
  const stage = await page.locator('#stage canvas').boundingBox();
  const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
  let lockedEver = false;
  if (mouse) {
    // A first click captures the mouse (when the browser allows pointer lock).
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await sleep(60);
    await page.mouse.up();
  }
  const state = () => page.evaluate(() => {
    const w = window.__wgif;
    const rt = w?.rt;
    const g = rt?.shootout;
    const shots = document.getElementById('hud-shots')?.textContent ?? '0/0';
    const [mk, at] = shots.split('/').map(Number);
    return {
      phase: g?.phase ?? null,
      held: rt ? rt.held !== null : document.getElementById('prompt')?.textContent?.includes('release') || document.getElementById('action')?.textContent === 'Shoot',
      makes: g?.makes ?? mk, attempts: g?.attempts ?? at,
      score: Number(document.getElementById('hud-score')?.textContent ?? 0),
      locked: !!document.pointerLockElement,
      over: !document.getElementById('result').hidden,
      time: Number(document.getElementById('hud-time')?.textContent ?? 0),
    };
  });
  if (phone && !(await page.locator('#action').isVisible())) {
    // Older builds only showed the Shoot button after a finger touched the scene.
    await page.touchscreen.tap(stage.x + stage.width * 0.75, cy);
  }
  const action = phone ? page.locator('#action') : null;
  if (phone) await action.waitFor({ state: 'visible', timeout: 5000 });
  let presses = 0, ignored = 0, returns = 0;
  const returnTimes = [];
  const t0 = Date.now();
  // Countdown 3-2-1.
  await sleep(3300);
  while (Date.now() - t0 < (seconds + 8) * 1000) {
    const st = await state();
    if (st.locked) lockedEver = true;
    if (st.over) break;
    if (!st.held) {
      await sleep(100);
      continue;
    }
    await sleep(250); // a person's reaction time once the ball is back
    const before = (await state()).attempts;
    const hold = 300 + Math.round(rand() * 900);
    presses++;
    if (mouse) {
      await page.mouse.down();
      await sleep(hold);
      await page.mouse.up();
    } else if (profile === 'space') {
      await page.keyboard.down('Space');
      await sleep(hold);
      await page.keyboard.up('Space');
    } else {
      const b = await action.boundingBox();
      const client = await ctx.newCDPSession(page);
      const p = { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 };
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      await sleep(hold);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await client.detach();
    }
    const released = Date.now();
    await sleep(150);
    const after = await state();
    if (after.over) break;
    if (after.attempts === before) {
      ignored++;
      continue;
    }
    // Wait for the ball to come back (rebounder pass or the safety net).
    for (;;) {
      const w = await state();
      if (w.over || Date.now() - t0 > (seconds + 8) * 1000) break;
      if (w.held) {
        returns++;
        returnTimes.push(Date.now() - released);
        break;
      }
      await sleep(100);
    }
  }
  const end = await state();
  await browser.close();
  const swErrors = errors.filter((e) => /clone|sw\.js|Response body/i.test(e));
  return {
    profile, hook: hasHook, presses, ignoredPresses: ignored, attempts: end.attempts, makes: end.makes, score: end.score, returns,
    medianReturnMs: returnTimes.length ? returnTimes.sort((a, b) => a - b)[Math.floor(returnTimes.length / 2)] : null,
    maxReturnMs: returnTimes.length ? Math.max(...returnTimes) : null,
    pointerLock: mouse ? lockedEver : undefined,
    headerClipped: clipped, playButtonOnScreen: playVisible, swErrors: swErrors.length, errors: errors.slice(0, 5),
  };
}

const profiles = only === 'all' ? ['mouse', 'mouse-nolock', 'space', 'touch'] : only.split(',');
const out = [];
for (const p of profiles) {
  const r = await play(p);
  out.push(r);
  console.log(JSON.stringify(r));
}
const bad = out.filter((r) => r.ignoredPresses > 0 || r.makes === 0 || r.swErrors > 0 || r.headerClipped.length > 0);
process.exitCode = bad.length ? 1 : 0;
