#!/usr/bin/env node
/**
 * Frame-time profile of photo (image/GIF-to-3D) worlds in headless Chrome (SwiftShader, so this is
 * a CPU-side stand-in for a phone GPU: relative before/after numbers, not absolute fps).
 *
 *   NODE_PATH=<folder with playwright-core> node apps/player/e2e/photo-perf.e2e.mjs <url> <world.wgif>... [--throttle 4] [--secs 5] [--json out.json]
 *
 * For each world, at 1280x800 and at 390x844 (iPhone UA, touch, 2x) with CPU throttling, it records
 * requestAnimationFrame intervals, long tasks, per-render CPU time and the quality level while
 * (a) the picture plays untouched and (b) a finger/mouse orbits it.
 */
/* global setTimeout, PerformanceObserver */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const base = args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:4317/';
const files = args.filter((a) => a.endsWith('.wgif'));
const throttle = Number(opt('throttle', 4));
const secs = Number(opt('secs', 5));
const chrome = opt('chrome', process.env.CHROME ?? '/usr/bin/google-chrome');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

const instrument = () => {
  const s = { dts: [], long: [], renders: [], running: false, last: 0 };
  window.__perf = s;
  new PerformanceObserver((l) => { if (s.running) for (const e of l.getEntries()) s.long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
  const tick = (t) => { if (s.running && s.last) s.dts.push(t - s.last); s.last = s.running ? t : 0; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const r = window.wgifPlayer.viewer.renderer, orig = r.render.bind(r);
  r.render = (a, b) => { const t0 = performance.now(); orig(a, b); if (s.running) s.renders.push(performance.now() - t0); };
};
const stats = (a) => {
  if (!a.length) return null;
  const v = [...a].sort((x, y) => x - y), q = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return { n: a.length, mean: +mean.toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +v[v.length - 1].toFixed(1) };
};

async function measure(page, phone, orbit, cdp) {
  await page.evaluate(() => { const s = window.__perf; s.dts = []; s.long = []; s.renders = []; s.last = 0; s.running = true; });
  const t0 = Date.now();
  if (orbit) {
    const end = t0 + secs * 1000;
    const cx = phone ? 195 : 640, cy = phone ? 420 : 400, amp = phone ? 90 : 260;
    let k = 0;
    if (phone) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
    else { await page.mouse.move(cx, cy); await page.mouse.down(); }
    while (Date.now() < end) {
      const x = cx + Math.sin(k / 12) * amp, y = cy + Math.cos(k / 17) * amp * 0.3; k++;
      if (phone) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
      else await page.mouse.move(x, y);
      await sleep(16);
    }
    if (phone) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await page.mouse.up();
  } else await sleep(secs * 1000);
  const ms = Date.now() - t0;
  const r = await page.evaluate(() => { const s = window.__perf; s.running = false; const v = window.wgifPlayer.viewer; const gl = v.renderer.getContext(), px = new Uint8Array(4), t0 = performance.now();
    for (let i = 0; i < 10; i++) { v.renderer.render(v.scene, v.camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    return { dts: s.dts, long: s.long, renders: s.renders, q: v.stats(), sync: (performance.now() - t0) / 10, buf: [gl.drawingBufferWidth, gl.drawingBufferHeight] }; });
  const fps = (r.dts.length / ms) * 1000, drawn = (r.renders.length / ms) * 1000;
  return { syncRenderMs: +r.sync.toFixed(1), buffer: r.buf.join('x'), fps: +fps.toFixed(1), drawnPerSec: +drawn.toFixed(1), frameMs: stats(r.dts), renderCpuMs: stats(r.renders), longTasks: r.long.length, longTaskMs: +r.long.reduce((x, y) => x + y, 0).toFixed(0), over33: r.dts.filter((d) => d > 33.4).length, over50: r.dts.filter((d) => d > 50).length, quality: `L${r.q.level} ${r.q.pixelRatio.toFixed(2)}x shadows=${r.q.shadows}`, calls: r.q.calls, tris: r.q.triangles };
}

const out = [];
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (const file of files) {
    for (const [label, ctxOpts] of [
      ['desktop', { viewport: { width: 1280, height: 800 } }],
      ['390x844', { userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
    ]) {
      const phone = label !== 'desktop';
      const ctx = await browser.newContext(ctxOpts);
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      page.on('pageerror', (e) => console.log('pageerror', String(e)));
      await page.goto(new URL('./?e2e', base).href);
      await page.waitForFunction(() => !!window.wgifOpenBytes);
      const bytes = [...readFileSync(file)];
      await page.evaluate(async (b) => window.wgifOpenBytes(new Uint8Array(b), 'w.wgif'), bytes);
      await page.waitForFunction(() => !!window.wgifPlayer.viewer?.worldRoot?.getObjectByName('photo'), null, { timeout: 30000 });
      await sleep(2500);
      await instrument_(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: label === 'desktop' ? 1 : throttle });
      for (const [what, orbit] of [['play', false], ['orbit', true]]) {
        const m = await measure(page, phone, orbit, cdp);
        const row = { world: basename(file), viewport: label, throttle: label === 'desktop' ? 1 : throttle, what, ...m };
        out.push(row);
        console.log(`${row.world.padEnd(16)} ${label.padEnd(8)} x${row.throttle} ${what.padEnd(5)} raf/s ${String(m.fps).padStart(5)}  frame mean/p95/max ${m.frameMs?.mean}/${m.frameMs?.p95}/${m.frameMs?.max}ms  draws/s ${m.drawnPerSec}  sync-render ${m.syncRenderMs}ms@${m.buffer}  render-cpu ${m.renderCpuMs?.mean}ms  >33ms:${m.over33} >50ms:${m.over50} long:${m.longTasks}  ${m.quality}  calls ${m.calls} tris ${m.tris}`);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
const jf = opt('json', '');
if (jf) writeFileSync(jf, JSON.stringify(out, null, 1));
async function instrument_(page) { await page.evaluate(instrument); }
