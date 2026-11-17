#!/usr/bin/env node
/**
 * Headless real-browser check of the music world and the player's audio component (not part of
 * CI: needs Chrome + SwiftShader).
 *
 *   NODE_PATH=<folder with playwright-core> node apps/player/e2e/music.e2e.mjs <url> [--shots <dir>] [--chrome /usr/bin/google-chrome]
 *
 * At 1280x800 (desktop, mouse) and 390x844 (iPhone UA, real touch), with Chrome's normal autoplay
 * policy (sound only after a user gesture):
 *   1. ?src=samples/music.wgif opens the world with no warnings, in orbit, with the big
 *      "Tap to play" button and the music bar showing, and nothing playing yet.
 *   2. Tap to play: the AudioContext is running, the track is playing, and over three seconds the
 *      analyser levels, the beat count, the bar heights and the core's scale change.
 *   3. The ⏸ button pauses: the context is suspended and the levels fall back towards silence.
 *   4. The ▶ button plays again; the volume slider sets the gain.
 * Screenshots go to --shots (default ./shots) as music-idle.png, music-playing.png and
 * music-390x844-*.png.
 *
 * Nothing is heard: the test reads the analyser, which only moves when audio is flowing through
 * the graph, and checks the visual follows it. How it sounds is for a person with speakers.
 */
/* global setTimeout */
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

const status = (page) =>
  page.evaluate(() => {
    const p = window.wgifPlayer, m = p.music;
    const s = m ? m.status() : null;
    const shown = (id) => !document.getElementById(id).hidden;
    return {
      ...s,
      mode: p.viewer.mode,
      tapShown: shown('music-tap'),
      barShown: shown('music-bar'),
      toggle: document.getElementById('music-toggle').getAttribute('aria-pressed'),
      title: document.getElementById('music-title').textContent,
      warnings: p.session?.warnings ?? [],
    };
  });
const fmt = (s) => JSON.stringify({ state: s.state, context: s.context, energy: +(s.energy ?? 0).toFixed(3), bass: +(s.bass ?? 0).toFixed(3), beats: s.beats, core: +(s.visual?.coreScale ?? 0).toFixed(3), bar: +(s.visual?.barMax ?? 0).toFixed(2) });

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (const [label, ctxOpts] of [
    ['desktop', { viewport: { width: 1280, height: 800 } }],
    ['390x844', { userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
  ]) {
    const phone = label !== 'desktop';
    const tag = `music ${label}`;
    const prefix = phone ? 'music-390x844' : 'music';
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const press = (sel) => (phone ? page.locator(sel).tap() : page.locator(sel).click());
    await page.goto(new URL('./?e2e&src=samples/music.wgif', base).href);
    await page.waitForFunction(() => !!window.wgifPlayer?.music, null, { timeout: 90000 });
    await sleep(1500);
    const idle = await status(page);
    check(`${tag}: opens via ?src= in orbit with Tap to play and the music bar`, idle.mode === 'orbit' && idle.tapShown && idle.barShown && (await page.title()).startsWith('Neon Pulse') && idle.title.includes('Neon Pulse'), JSON.stringify({ mode: idle.mode, tap: idle.tapShown, bar: idle.barShown, title: idle.title }));
    check(`${tag}: nothing plays before a tap`, idle.state === 'idle' && idle.context !== 'running' && idle.toggle === 'false', fmt(idle));
    check(`${tag}: no world warnings`, idle.warnings.length === 0, idle.warnings.join(' | '));
    await page.screenshot({ path: join(shots, `${prefix}-idle.png`) });

    // Tap to play.
    await press('#music-tap');
    await page.waitForFunction(() => window.wgifPlayer.music.status().state === 'playing', null, { timeout: 15000 }).catch(() => {});
    await sleep(800);
    const a = await status(page);
    check(`${tag}: tap starts the AudioContext and the track`, a.state === 'playing' && a.context === 'running' && !a.tapShown && a.toggle === 'true', fmt(a));
    const samples = [];
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      samples.push(await status(page));
    }
    const b = samples.at(-1);
    const spread = (k) => Math.max(...samples.map(k)) - Math.min(...samples.map(k));
    check(`${tag}: the analyser hears it`, Math.max(...samples.map((s) => s.energy)) > 0.15 && spread((s) => s.energy) > 0.005, samples.map((s) => s.energy.toFixed(3)).join(' '));
    check(`${tag}: beats are counted`, b.beats > a.beats, `${a.beats} -> ${b.beats}`);
    check(`${tag}: the bars and the core move with it`, b.visual.barMax > 1 && spread((s) => s.visual.barMax) > 0.05 && spread((s) => s.visual.coreScale) > 0.005, `bars ${samples.map((s) => s.visual.barMax.toFixed(2)).join(' ')}, core ${samples.map((s) => s.visual.coreScale.toFixed(3)).join(' ')}`);
    await page.screenshot({ path: join(shots, `${prefix}-playing.png`) });

    // Volume.
    await page.locator('#music-volume').fill('30');
    const vol = await page.evaluate(() => window.wgifPlayer.music.track.volume);
    check(`${tag}: the volume slider sets the gain`, Math.abs(vol - 0.3) < 0.01, String(vol));

    // Pause.
    await press('#music-toggle');
    await sleep(2500);
    const p = await status(page);
    check(`${tag}: pause suspends the context`, p.state === 'paused' && p.context === 'suspended' && p.toggle === 'false', fmt(p));
    check(`${tag}: the levels fall back when paused`, p.energy < b.energy * 0.5 && p.visual.barMax < b.visual.barMax, `${fmt(b)} -> ${fmt(p)}`);
    const beatsPaused = p.beats;
    await sleep(1000);
    check(`${tag}: no beats while paused`, (await status(page)).beats === beatsPaused);
    await page.screenshot({ path: join(shots, `${prefix}-paused.png`) });

    // Play again.
    await press('#music-toggle');
    await sleep(1500);
    const r = await status(page);
    check(`${tag}: ▶ plays again`, r.state === 'playing' && r.context === 'running' && r.energy > 0.1, fmt(r));
    check(`${tag}: no page or console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
