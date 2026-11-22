#!/usr/bin/env node
/**
 * Headless real-browser check of "Create from image" (not part of CI: needs Chrome + SwiftShader).
 *
 *   NODE_PATH=<folder with playwright-core> node apps/player/e2e/image3d.e2e.mjs <url> [--shots <dir>] [--out <dir>] [--real]
 *
 * At 1280x800 (desktop) and 390x844 (iPhone UA, touch), with the depth model mocked (?depth=mock):
 *   1. "Create from image" opens the creator; a PNG (fixtures/street-256.png) becomes a 3D scene:
 *      the photo mesh is really displaced (vertex z varies) and the canvas shows it.
 *   2. Orbit (mouse drag / finger drag) moves the camera and changes the picture on screen.
 *   3. Save .wgif gives a valid file within 1 MiB that re-opens in a fresh page with no warnings.
 *   4. A GIF (fixtures/bounce-160.gif) becomes an animated 3D scene: its frames play on the mesh.
 *   5. The flat mode builds the picture as a screen in a room.
 * --real (desktop only): once more with the real model (Depth Anything V2 Small on WebAssembly),
 * fetched from Hugging Face and jsDelivr; reports download+start and inference times, then reloads
 * offline and makes the scene again from the cache.
 * Screenshots go to --shots as img3d-*.png; saved worlds to --out.
 */
/* global setTimeout, Image, navigator */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const base = args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:4317/';
const chrome = opt('chrome', process.env.CHROME ?? '/usr/bin/google-chrome');
const shots = resolve(opt('shots', 'shots'));
const out = resolve(opt('out', join(shots, 'worlds')));
const real = args.includes('--real');
mkdirSync(shots, { recursive: true });
mkdirSync(out, { recursive: true });
const PNG = join(here, 'fixtures/street-256.png');
const GIF = join(here, 'fixtures/bounce-160.gif');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** The made world, the photo mesh's depth range and the camera. */
const probe = (page) =>
  page.evaluate(() => {
    const p = window.wgifPlayer, c = p.creator, w = c?.world ?? null;
    const root = p.viewer?.worldRoot, mesh = root?.getObjectByName('photo');
    let zr = 0, verts = 0;
    if (mesh?.geometry) {
      const a = mesh.geometry.attributes.position.array;
      let lo = Infinity, hi = -Infinity;
      for (let i = 2; i < a.length; i += 3) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
      zr = hi - lo;
      verts = a.length / 3;
    }
    const cam = p.viewer?.camera.position;
    const map = mesh?.material?.emissiveMap;
    return {
      made: !!w, bytes: w?.bytes.length ?? 0, sizes: w?.sizes ?? null, zRange: zr, verts,
      camera: cam ? [cam.x, cam.y, cam.z] : null, title: document.title, status: document.getElementById('cr-status').textContent,
      warnings: p.session?.warnings ?? [], offset: map ? [map.offset.x, map.offset.y] : null, repeat: map ? [map.repeat.x, map.repeat.y] : null,
      mode: w?.manifest.provenance?.params?.mode ?? null, depth: c?.depth ? { ...c.depth.info, loadMs: c.depth.loadMs } : null,
    };
  });

/** Waits for a new world from the creator (a different one from the last seen on this page). */
const waitMade = (page, timeout = 60000) =>
  page.waitForFunction(() => {
    const c = window.wgifPlayer.creator;
    if (!c?.world || c.world === window.__lastWorld || document.getElementById('cr-make').disabled) return false;
    window.__lastWorld = c.world;
    return true;
  }, null, { timeout, polling: 250 });

/** Fraction of sampled canvas pixels that differ between two screenshots (PNG buffers compared as bytes is too strict). */
async function changed(page, a, b) {
  return page.evaluate(async ([x, y]) => {
    const load = async (b64) => { const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const [p, q] = [await load(x), await load(y)];
    let diff = 0, n = 0;
    for (let i = 0; i < Math.min(p.length, q.length); i += 4 * 97) { n++; if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 30) diff++; }
    return diff / n;
  }, [a.toString('base64'), b.toString('base64')]);
}

async function variety(page, shot) {
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 53) seen.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | d[i + 2] >> 4);
    return seen.size;
  }, shot.toString('base64'));
}

async function drag(page, phone, from, to) {
  if (!phone) {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) { await page.mouse.move(from[0] + ((to[0] - from[0]) * k) / 12, from[1] + ((to[1] - from[1]) * k) / 12); await sleep(30); }
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(...from) });
  for (let k = 1; k <= 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(from[0] + ((to[0] - from[0]) * k) / 12, from[1] + ((to[1] - from[1]) * k) / 12) }); await sleep(30); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const validate = (file) => {
  try {
    return { ok: true, text: execFileSync('npx', ['tsx', join(repo, 'packages/format/src/cli.ts'), 'validate', file], { cwd: repo, encoding: 'utf8' }).trim() };
  } catch (e) {
    return { ok: false, text: String(e.stdout ?? e) };
  }
};

async function save(page, phone, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), phone ? page.tap('#cr-save') : page.click('#cr-save')]);
  const file = join(out, name);
  await dl.saveAs(file);
  return file;
}

async function reopen(browser, ctxOpts, file) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(new URL('./?e2e', base).href);
  await page.waitForFunction(() => !!window.wgifOpenBytes);
  const bytes = [...readFileSync(file)];
  await page.evaluate(async (b) => window.wgifOpenBytes(new Uint8Array(b), 'reopened.wgif'), bytes);
  await page.waitForFunction(() => !!window.wgifPlayer.viewer?.worldRoot?.getObjectByName('photo'), null, { timeout: 30000 });
  const r = await page.evaluate(() => ({ warnings: window.wgifPlayer.session.warnings, photos: window.wgifPlayer.session.doc.interactions.photos.length, empty: !document.getElementById('empty').hidden }));
  await ctx.close();
  return { ...r, errors };
}

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (const [label, ctxOpts] of [
    ['desktop', { viewport: { width: 1280, height: 800 }, acceptDownloads: true }],
    ['390x844', { userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, acceptDownloads: true }],
  ]) {
    const phone = label !== 'desktop';
    const tag = `img3d ${label}`;
    const pre = phone ? 'img3d-390x844' : 'img3d';
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(new URL('./?e2e&depth=mock', base).href);
    await page.waitForFunction(() => !!window.wgifPlayer);
    const btn = (await page.isVisible('#create-empty')) ? '#create-empty' : '#create';
    if (phone) await page.tap(btn); else await page.click(btn);
    await page.waitForSelector('#img-creator:not([hidden])');
    check(`${tag}: "Create from image" opens the creator`, await page.isVisible('#cr-file + *, label[for="cr-file"]'));
    if (!phone) await page.screenshot({ path: join(shots, `${pre}-creator.png`) });

    // 1. PNG -> 3D
    await page.setInputFiles('#cr-file', PNG);
    await waitMade(page);
    await sleep(1200);
    let s = await probe(page);
    const shotA = await page.screenshot({ path: join(shots, `${pre}-photo.png`) });
    check(`${tag}: a PNG becomes a 3D scene (mesh z varies)`, s.made && s.zRange > 1 && s.verts > 1000, `z range ${s.zRange.toFixed(2)} m, ${s.verts} vertices, ${s.bytes} B`);
    check(`${tag}: the scene is drawn`, (await variety(page, shotA)) > 40, `${await variety(page, shotA)} colours`);
    check(`${tag}: no warnings for the made world`, s.warnings.length === 0, s.warnings.join('; '));

    // 2. Orbit
    const cam0 = s.camera;
    const box = await page.locator('#stage canvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height * (phone ? 0.3 : 0.5);
    await drag(page, phone, [cx - 60, cy], [cx + (phone ? 90 : 220), cy - 30]);
    await sleep(1500);
    s = await probe(page);
    const shotB = await page.screenshot({ path: join(shots, `${pre}-orbit.png`) });
    const moved = Math.hypot(s.camera[0] - cam0[0], s.camera[1] - cam0[1], s.camera[2] - cam0[2]);
    const diff = await changed(page, shotA, shotB);
    check(`${tag}: orbit moves the camera and changes the view`, moved > 0.3 && diff > 0.05, `camera moved ${moved.toFixed(2)} m, ${(diff * 100).toFixed(0)}% of pixels changed`);

    // 3. Save + re-open
    const file = await save(page, phone, `${pre}-photo.wgif`);
    const size = readFileSync(file).length;
    const v = validate(file);
    check(`${tag}: Save .wgif gives a valid file within 1 MiB`, v.ok && size <= 1024 * 1024, `${size} B; ${v.text.split('\n')[0]}`);
    const re = await reopen(browser, ctxOpts, file);
    check(`${tag}: the saved file re-opens with no warnings`, re.photos === 1 && re.warnings.length === 0 && re.errors.length === 0 && !re.empty, JSON.stringify(re));

    // 4. GIF -> animated 3D
    if (phone) await page.tap('#cr-close'); else await page.click('#cr-close');
    if (phone) await page.tap('#create'); else await page.click('#create');
    await page.setInputFiles('#cr-file', GIF);
    await waitMade(page);
    await sleep(800);
    const g1 = await probe(page);
    await sleep(330); // not a multiple of the 700 ms loop
    const g2 = await probe(page);
    await page.screenshot({ path: join(shots, `${pre}-gif.png`) });
    check(`${tag}: a GIF becomes an animated 3D scene`, g1.made && g1.zRange > 0.5 && !!g1.repeat && g1.repeat[0] < 1 && JSON.stringify(g1.offset) !== JSON.stringify(g2.offset), `repeat ${JSON.stringify(g1.repeat)}, offset ${JSON.stringify(g1.offset)} -> ${JSON.stringify(g2.offset)}, ${g1.bytes} B`);
    const gfile = await save(page, phone, `${pre}-gif.wgif`);
    const gv = validate(gfile);
    check(`${tag}: the GIF world saves valid`, gv.ok && readFileSync(gfile).length <= 1024 * 1024, `${readFileSync(gfile).length} B`);

    // 5. Flat mode
    if (phone) await page.tap('input[name="cr-mode"][value="flat"]'); else await page.check('input[name="cr-mode"][value="flat"]');
    await waitMade(page);
    await sleep(800);
    const f = await probe(page);
    await page.screenshot({ path: join(shots, `${pre}-flat.png`) });
    check(`${tag}: the flat mode is a screen in a room`, f.made && f.mode === 'flat' && f.zRange < 0.01 && f.bytes > 0, `mode ${f.mode}, z range ${f.zRange}, ${f.bytes} B`);

    check(`${tag}: no page or console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  if (real) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(new URL('./?e2e&depth=wasm', base).href);
    await page.waitForFunction(() => !!window.wgifPlayer);
    await page.click('#create');
    await page.waitForSelector('#img-creator:not([hidden])');
    const t0 = Date.now();
    await page.setInputFiles('#cr-file', PNG);
    await waitMade(page, 600000);
    const wall = Date.now() - t0;
    await sleep(1500);
    const s = await probe(page);
    await page.screenshot({ path: join(shots, 'img3d-real.png') });
    await drag(page, false, [560, 400], [800, 370]);
    await sleep(1500);
    await page.screenshot({ path: join(shots, 'img3d-real-orbit.png') });
    check('img3d real model: Depth Anything V2 Small runs headless', s.made && s.depth?.backend === 'wasm' && s.zRange > 1, `load ${s.depth?.loadMs} ms, inference ${s.depth?.ms} ms at ${JSON.stringify(s.depth?.inputSize)}, total ${wall} ms`);
    const file = await save(page, false, 'img3d-real.wgif');
    check('img3d real model: saved world is valid', validate(file).ok, `${readFileSync(file).length} B`);
    writeFileSync(join(out, 'real-timing.json'), JSON.stringify({ ...s.depth, wallMs: wall }, null, 2));
    // Offline, from the cache.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    // One online reload first: `vite preview` sends Vary: Origin, so the install-time precache
    // misses module-script requests until they have been fetched once under the worker.
    // (and the creator's lazy chunk, so it is opened once too).
    await page.reload();
    await page.waitForFunction(() => !!window.wgifPlayer, null, { timeout: 30000 });
    await page.click('#create');
    await page.waitForSelector('#img-creator:not([hidden])');
    await page.waitForFunction(() => !!window.wgifPlayer.creator);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => !!window.wgifPlayer, null, { timeout: 30000 });
    await page.click('#create');
    await page.waitForSelector('#img-creator:not([hidden])');
    const t1 = Date.now();
    await page.setInputFiles('#cr-file', PNG);
    let offlineOk = true;
    try {
      await waitMade(page, 300000);
    } catch {
      offlineOk = false;
    }
    const s2 = await probe(page);
    check('img3d real model: works offline from the cache', offlineOk && s2.depth?.backend === 'wasm', `load ${s2.depth?.loadMs} ms, inference ${s2.depth?.ms} ms, total ${Date.now() - t1} ms`);
    check('img3d real model: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
