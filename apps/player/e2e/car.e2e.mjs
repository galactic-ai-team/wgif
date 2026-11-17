#!/usr/bin/env node
/**
 * Headless real-browser check of the car world and the player's vehicle component (not part of
 * CI: needs Chrome + SwiftShader).
 *
 *   NODE_PATH=<folder with playwright-core> node apps/player/e2e/car.e2e.mjs <url> [--shots <dir>] [--chrome /usr/bin/google-chrome]
 *
 * At 1280x800 (desktop, keyboard) and 390x844 (iPhone UA, real touch events):
 *   1. ?src=samples/car.wgif opens the world with no page or console errors, in orbit around the car,
 *      with the Drive button showing.
 *   2. Drive: F on desktop, the 🚗 Drive button on the phone. The mode says Drive, and the phone
 *      shows the touch pad (steer + Gas / Brake).
 *   3. Forward: W held on desktop, the Gas button held with a finger on the phone. The car moved
 *      (more than 2 m), stayed on the ground and inside the lot, and the chase camera followed it.
 *   4. Back to orbit (F / Exit car): the orbit centres on the car where it stopped.
 * Screenshots go to --shots (default ./shots) as car-orbit.png, car-drive.png and car-390x844-*.png.
 *
 * Driving feel (how it handles, frame pacing) cannot be judged here: SwiftShader draws a few frames
 * a second, so this checks that the controls reach the car, not how it feels.
 */
/* global setTimeout, getComputedStyle */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const base = args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:4173/';
const chrome = opt('chrome', process.env.CHROME ?? '/usr/bin/google-chrome');
const shots = resolve(opt('shots', 'shots'));
mkdirSync(shots, { recursive: true });
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const state = (page) =>
  page.evaluate(() => {
    const p = window.wgifPlayer, v = p.runtime?.vehicles.get('car');
    const cam = p.viewer.camera.position;
    return {
      mode: p.viewer.mode,
      pos: v ? [...v.pos] : null,
      speed: v?.speed ?? 0,
      camera: [cam.x, cam.y, cam.z],
      modeText: document.getElementById('mode').textContent,
      driveText: document.getElementById('drive').textContent,
      driveShown: !document.getElementById('drive').hidden,
      padShown: !document.getElementById('drive-pad').hidden && getComputedStyle(document.getElementById('drive-pad')).display !== 'none',
    };
  });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (const [label, ctxOpts] of [
    ['desktop', { viewport: { width: 1280, height: 800 } }],
    ['390x844', { userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
  ]) {
    const phone = label !== 'desktop';
    const tag = `car ${label}`;
    const prefix = phone ? 'car-390x844' : 'car';
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(new URL('./?e2e&src=samples/car.wgif', base).href);
    await page.waitForFunction(() => !!window.wgifPlayer?.runtime?.vehicles?.get('car'), null, { timeout: 90000 });
    await sleep(1500);
    const start = await state(page);
    check(`${tag}: opens via ?src= in orbit with the Drive button`, start.mode === 'orbit' && start.driveShown && start.driveText.includes('Drive') && (await page.title()).startsWith('Neon Lot'), JSON.stringify({ mode: start.mode, drive: start.driveText }));
    const target = await page.evaluate(() => window.wgifPlayer.viewer.orbitTarget);
    check(`${tag}: orbit is centred on the car`, !!target && dist(target, start.pos) < 0.5, JSON.stringify(target));
    await page.screenshot({ path: join(shots, `${prefix}-orbit.png`) });

    // Get in.
    if (phone) await page.locator('#drive').tap();
    else await page.keyboard.press('KeyF');
    await sleep(400);
    const inCar = await state(page);
    check(`${tag}: Drive toggles drive mode`, inCar.mode === 'drive' && inCar.modeText === 'Mode: Drive' && inCar.driveText.includes('Exit'), inCar.modeText);
    if (phone) check(`${tag}: touch pad shows`, inCar.padShown);
    else check(`${tag}: no touch pad on desktop`, !inCar.padShown);

    // Forward.
    if (phone) {
      const box = await page.locator('[data-drive="gas"]').boundingBox();
      const cdp = await ctx.newCDPSession(page);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await sleep(2500);
      const held = await page.evaluate(() => document.querySelector('[data-drive="gas"]').classList.contains('down'));
      check(`${tag}: holding Gas presses it`, held);
      await page.screenshot({ path: join(shots, `${prefix}-drive.png`) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.keyboard.down('KeyW');
      await sleep(2500);
      await page.screenshot({ path: join(shots, `${prefix}-drive.png`) });
      await page.keyboard.up('KeyW');
    }
    const moved = await state(page);
    const d = dist(moved.pos, start.pos);
    check(`${tag}: forward moves the car`, d > 2 && moved.pos[2] < start.pos[2], `${d.toFixed(2)} m, z ${start.pos[2].toFixed(2)} -> ${moved.pos[2].toFixed(2)}`);
    check(`${tag}: the car stays on the ground inside the lot`, moved.pos[1] > -0.01 && Math.abs(moved.pos[0]) < 30 && Math.abs(moved.pos[2]) < 30, JSON.stringify(moved.pos.map((n) => +n.toFixed(2))));
    check(`${tag}: the chase camera follows`, dist(moved.camera, moved.pos) < 12, `${dist(moved.camera, moved.pos).toFixed(2)} m behind`);

    // Get out.
    if (phone) await page.locator('#drive').tap();
    else await page.keyboard.press('KeyF');
    await sleep(2500);
    const out = await state(page);
    const orbitAt = await page.evaluate(() => window.wgifPlayer.viewer.orbitTarget);
    check(`${tag}: back to orbit around the car where it stopped`, out.mode === 'orbit' && Math.abs(out.speed) < 0.01 && dist(orbitAt, out.pos) < 0.5 && out.driveText.includes('Drive'), JSON.stringify({ mode: out.mode, speed: out.speed, target: orbitAt?.map((n) => +n.toFixed(2)), car: out.pos.map((n) => +n.toFixed(2)) }));
    await page.screenshot({ path: join(shots, `${prefix}-parked.png`) });
    check(`${tag}: no page or console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
