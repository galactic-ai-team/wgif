#!/usr/bin/env node
/**
 * Headless real-browser check of the extra sample worlds (not part of CI: needs Chrome + SwiftShader).
 *
 *   NODE_PATH=<folder with playwright-core> node apps/player/e2e/sample-worlds.e2e.mjs <url> [--shots <dir>] [--chrome /usr/bin/google-chrome]
 *
 * For gallery, rooftop and city, at 1280x800 (desktop, mouse) and 390x844 (iPhone UA, touch):
 *   1. ?src=samples/<name>.wgif opens the world (title, no page or console errors).
 *   2. The renderer draws a real picture (a snapshot of the world is not one flat colour).
 *   3. The raw .wgif link downloads with the WGIF media type (or at least as bytes starting PK).
 *   4. Per world: gallery is locked (no export box); rooftop's Shootout starts and a shot is taken
 *      and comes back; city shows a valid signature and exporting an edit adds a fourth layer
 *      while the base signature stays.
 * Screenshots go to --shots (default ./shots) as <name>.png (desktop) and <name>-390x844.png.
 */
/* global setTimeout, fetch */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const base = args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:4173/';
const chrome = opt('chrome', process.env.CHROME ?? '/usr/bin/google-chrome');
const shots = resolve(opt('shots', 'shots'));
const only = opt('worlds', 'gallery,rooftop,city').split(',');
mkdirSync(shots, { recursive: true });
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** manifest.json of a .wgif: always the first, STORED entry (SPEC §2). */
function manifestOf(bytes) {
  if (bytes.readUInt32LE(0) !== 0x04034b50) return null;
  const size = bytes.readUInt32LE(18), nameLen = bytes.readUInt16LE(26), extra = bytes.readUInt16LE(28);
  return JSON.parse(bytes.subarray(30 + nameLen + extra, 30 + nameLen + extra + size).toString('utf8'));
}

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  for (const name of only) {
    for (const [label, ctxOpts] of [
      ['desktop', { viewport: { width: 1280, height: 800 } }],
      ['390x844', { userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
    ]) {
      const tag = `${name} ${label}`;
      const phone = label !== 'desktop';
      const ctx = await browser.newContext({ ...ctxOpts, acceptDownloads: true });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      const t0 = Date.now();
      await page.goto(new URL(`./?src=samples/${name}.wgif&e2e`, base).href);
      try {
        await page.waitForFunction(() => !!window.wgifPlayer?.runtime, null, { timeout: 60000 });
      } catch {
        check(`${tag}: opens from ?src=`, false, (await page.textContent('#error').catch(() => '')) ?? 'timeout');
        await ctx.close();
        continue;
      }
      const title = await page.textContent('#title');
      check(`${tag}: opens from ?src=`, !!title, `"${title}" in ${Date.now() - t0} ms`);
      await page.evaluate(() => window.wgifPlayer.setMode('walk'));
      await sleep(2000);
      const pixels = await page.evaluate(() => {
        const c = window.wgifPlayer.viewer.snapshot(64, 40);
        const d = c.getContext('2d').getImageData(0, 0, 64, 40).data;
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4));
        return seen.size;
      });
      check(`${tag}: renders`, pixels > 20, `${pixels} distinct colours in a 64x40 snapshot`);
      await page.screenshot({ path: join(shots, phone ? `${name}-390x844.png` : `${name}.png`) });

      if (!phone) {
        const raw = await page.evaluate(async (n) => {
          const r = await fetch(`samples/${n}.wgif`, { cache: 'no-store' });
          const b = new Uint8Array(await r.arrayBuffer());
          return { status: r.status, type: r.headers.get('content-type'), bytes: b.length, pk: b[0] === 0x50 && b[1] === 0x4b };
        }, name);
        check(`${tag}: raw .wgif link`, raw.status === 200 && raw.pk, `${raw.status} ${raw.type} ${raw.bytes} B`);
      }

      if (name === 'gallery') {
        check(`${tag}: locked (no export)`, await page.evaluate(() => document.getElementById('export-box').hidden));
      } else if (name === 'rooftop') {
        await (phone ? page.tap('#play') : page.click('#play'));
        await sleep(3600); // 3-2-1
        const held = () => page.evaluate(() => window.__wgif?.rt?.held !== null);
        const startAttempts = await page.evaluate(() => window.__wgif.rt.shootout.attempts);
        let returned = false;
        for (let shot = 0; shot < 2; shot++) {
          for (let i = 0; i < 40 && !(await held()); i++) await sleep(100);
          if (phone) {
            const b = await page.locator('#action').boundingBox();
            const cdp = await ctx.newCDPSession(page);
            const p = { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
            await sleep(700);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await cdp.detach();
          } else {
            await page.keyboard.down('Space');
            await sleep(700);
            await page.keyboard.up('Space');
          }
          await sleep(300);
          for (let i = 0; i < 60 && !(await held()); i++) await sleep(100);
          returned = await held();
        }
        const g = await page.evaluate(() => ({ phase: window.__wgif.rt.shootout.phase, attempts: window.__wgif.rt.shootout.attempts, makes: window.__wgif.rt.shootout.makes }));
        check(`${tag}: Shootout plays`, ['playing', 'overtime'].includes(g.phase) && g.attempts > startAttempts && returned, `phase ${g.phase}, ${g.makes}/${g.attempts} shots, ball back in hand: ${returned}`);
        await page.screenshot({ path: join(shots, phone ? `${name}-390x844-play.png` : `${name}-play.png`) });
      } else if (name === 'city') {
        const badges = await page.evaluate(() => document.body.textContent);
        check(`${tag}: signature valid badge`, /signature valid/i.test(badges));
        if (!phone) {
          await page.evaluate(() => window.wgifPlayer.session.edits.push({ op: 'move', id: 'orb_3', position: [1, 0.2, 1] }));
          await page.evaluate(() => document.getElementById('export').removeAttribute('disabled'));
          const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#export')]);
          const out = join(shots, `_${dl.suggestedFilename()}`);
          await dl.saveAs(out);
          const m = manifestOf(readFileSync(out));
          check(`${tag}: layered export`, m?.layers?.length === 4 && !!m?.signature, `${dl.suggestedFilename()}: ${m?.layers?.length} layers, signature ${m?.signature ? 'kept' : 'missing'}`);
        }
      }
      check(`${tag}: no errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
