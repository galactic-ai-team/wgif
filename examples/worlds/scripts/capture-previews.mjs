#!/usr/bin/env node
/**
 * Renders each sample world in the real player and saves the first-person spawn view (the orbit
 * view centred on the car for worlds with a vehicle) as the
 * world's preview (assets/previews/<name>.png, 480x288, palette PNG well under 256 KiB).
 * Run by a human after changing a world, then rebuild (`npm run build --workspace @wgif/example-worlds`)
 * so the new preview is packed. Needs Chrome, playwright-core and Python 3 with Pillow.
 *
 *   npm run build && (cd apps/player && npx vite preview --port 4173 &)
 *   NODE_PATH=<folder with playwright-core> node examples/worlds/scripts/capture-previews.mjs http://localhost:4173/ [names...]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:4173/';
const names = args.filter((a) => !/^https?:/.test(a));
const worlds = names.length ? names : ['gallery', 'rooftop', 'city', 'car'];
const out = resolve(fileURLToPath(new URL('../assets/previews/', import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), 'wgif-previews-'));

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (const name of worlds) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(new URL(`./?src=samples/${name}.wgif`, base).href);
    await page.waitForFunction(() => !!window.wgifPlayer?.runtime, null, { timeout: 60000 });
    await page.evaluate(() => {
      if (!window.wgifPlayer.viewer.canDrive) window.wgifPlayer.setMode('walk');
    });
    await page.waitForTimeout(2500);
    const raw = join(tmp, `${name}.png`);
    await page.locator('#stage canvas').screenshot({ path: raw });
    // Centre-crop to 5:3, scale to 480x288 and quantise to a 256-colour palette.
    execFileSync('python3', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
tw = min(w, int(h * 5 / 3)); th = int(tw * 3 / 5)
im = im.crop(((w - tw) // 2, (h - th) // 2, (w - tw) // 2 + tw, (h - th) // 2 + th)).resize((480, 288), Image.LANCZOS)
im.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(sys.argv[2], optimize=True)
`, raw, join(out, `${name}.png`)]);
    console.log(`preview ${name} -> ${join(out, `${name}.png`)}`);
    await page.close();
  }
} finally {
  await browser.close();
}
