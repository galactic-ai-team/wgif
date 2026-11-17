#!/usr/bin/env node
/**
 * Headless check of opening and exporting (not part of CI: needs Chrome + SwiftShader).
 *
 *   NODE_PATH=<folder with playwright-core> node apps/player/e2e/open-export.e2e.mjs <url> [--chrome /usr/bin/google-chrome]
 *
 * 1. As an iPhone (UA + touch): the "Open .wgif" input has no accept filter; as a desktop it does.
 * 2. ?src=samples/court.wgif opens the court from a link.
 * 3. Move the ball in Edit, Export: the download is a valid .wgif whose preview.png is a fresh
 *    render (not the packed 320x192 one), and choosing that file in the picker opens it again.
 * 4. Save preview image downloads a PNG.
 * 5. A PNG picked by mistake gets a plain "is an image" message.
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:4173/';
const ci = args.indexOf('--chrome');
const chrome = ci >= 0 ? args[ci + 1] : process.env.CHROME ?? '/usr/bin/google-chrome';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const pngSize = (b) => (b.subarray(0, 4).toString('hex') === '89504e47' ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : 'not-png');

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const dir = mkdtempSync(join(tmpdir(), 'wgif-open-e2e-'));
try {
  for (const [label, ctxOpts, expectAccept] of [
    ['iPhone', { userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 }, null],
    ['desktop', { viewport: { width: 1280, height: 800 } }, '.wgif,application/vnd.wgif+zip,application/zip'],
  ]) {
    const ctx = await browser.newContext({ ...ctxOpts, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(new URL('./?src=samples/court.wgif', base).href);
    const accept = await page.getAttribute('#file', 'accept');
    check(`${label}: picker accept`, accept === expectAccept, `accept=${JSON.stringify(accept)}`);
    await page.waitForFunction(() => !!window.wgifPlayer?.runtime, null, { timeout: 30000 });
    check(`${label}: ?src= opened the court`, (await page.textContent('#title'))?.includes('Court') ?? false, await page.textContent('#title'));

    // Edit: move the ball, then export.
    await page.evaluate(() => {
      const s = window.wgifPlayer.session;
      s.edits.push({ op: 'move', id: 'ball', position: [-4, 0.12, 3] });
    });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
    const out = join(dir, `${label}-${dl.suggestedFilename()}`);
    await dl.saveAs(out);
    const info = await page.evaluate(() => {
      const r = window.wgifPlayer.session.lastExport;
      return { preview: r.preview, name: r.fileName };
    });
    check(`${label}: export file name`, info.name === 'galactic-court-edit.wgif', info.name);
    check(`${label}: export has a fresh preview`, info.preview === 'refreshed', info.preview);

    // Re-open the exported file through the picker, the way it is picked from Files.
    await page.setInputFiles('#file', out);
    await page.waitForFunction(() => window.wgifPlayer.session?.doc.world.manifest.provenance?.history?.length > 0, null, { timeout: 20000 });
    const reopened = await page.evaluate(() => {
      const d = window.wgifPlayer.session.doc;
      const p = d.world.files[d.world.manifest.entry.preview];
      return { ok: d.world.report.ok, size: `${(p[16] << 24 | p[17] << 16 | p[18] << 8 | p[19]) >>> 0}x${(p[20] << 24 | p[21] << 16 | p[22] << 8 | p[23]) >>> 0}`, bytes: p.length, img: document.getElementById('preview').naturalWidth };
    });
    check(`${label}: exported file re-opens from the picker`, reopened.ok, JSON.stringify(reopened));
    check(`${label}: re-opened preview is the new render`, reopened.size !== '320x192' && reopened.bytes <= 256 * 1024, reopened.size);

    const [img] = await Promise.all([page.waitForEvent('download'), page.click('#save-image')]);
    const imgPath = join(dir, `${label}-${img.suggestedFilename()}`);
    await img.saveAs(imgPath);
    check(`${label}: Save preview image`, pngSize(readFileSync(imgPath)) === '1024x614', `${img.suggestedFilename()} ${pngSize(readFileSync(imgPath))}`);

    const bogus = join(dir, 'IMG_0001.png');
    writeFileSync(bogus, readFileSync(imgPath));
    await page.setInputFiles('#file', bogus);
    await page.waitForTimeout(300);
    const toast = await page.textContent('#toast');
    check(`${label}: a picked image is explained`, /is an image/.test(toast ?? ''), toast ?? '');
    check(`${label}: no page errors`, errors.filter((e) => !/favicon/.test(e)).length === 0, errors.join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed; files in ${dir}`);
process.exit(failed ? 1 : 0);
