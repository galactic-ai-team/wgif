// Validates the built player dist for offline use. Run by `npm run build`
// in apps/player, after `vite build`. Exits non-zero on any failure.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const playerRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(playerRoot, 'dist');
const fail = (msg) => {
  console.error(`check:offline FAIL: ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync(join(playerRoot, 'package.json'), 'utf8'));
const cacheName = `wgif-player-v${pkg.version}`;

// 1. The service worker exists, has the versioned cache name, and has no
//    unreplaced placeholders.
const swPath = join(dist, 'sw.js');
if (!existsSync(swPath)) fail('dist/sw.js is missing');
const sw = readFileSync(swPath, 'utf8');
if (sw.includes('__WGIF_')) fail('dist/sw.js still contains a __WGIF_*__ placeholder');
// The cache name is a plain string in the built worker; esbuild minify may
// render it with single quotes, double quotes or backticks.
if (!sw.includes(cacheName)) {
  fail(`dist/sw.js does not contain the versioned cache name ${cacheName}`);
}

// 2. The precache list covers every file in dist (except the worker itself
//    and the Vite build manifest, which are not runtime assets).
const precacheMatch = sw.match(/JSON\.parse\((['"`])([\s\S]*?)\1\)/);
if (!precacheMatch) fail('dist/sw.js has no injectable precache list');
const precache = JSON.parse(precacheMatch[2]);
if (!Array.isArray(precache) || precache.length === 0) fail('precache list is empty');
if (!precache.includes('./')) fail("precache list is missing the shell root './' (offline reload would fail)");
const precached = new Set(precache);
const distFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs);
    else distFiles.push(relative(dist, abs).split(sep).join('/'));
  }
})(dist);
const missing = distFiles
  .filter((rel) => rel !== 'sw.js' && rel !== '.vite/manifest.json')
  .filter((rel) => !precached.has(`./${rel}`));
if (missing.length > 0) fail(`precache list is missing dist files: ${missing.join(', ')}`);

// 3. The web manifest parses, names the app, and its icons exist in dist.
const manifestPath = join(dist, 'manifest.webmanifest');
if (!existsSync(manifestPath)) fail('dist/manifest.webmanifest is missing');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!manifest.name || !manifest.short_name) fail('web manifest has no name/short_name');
if (manifest.display !== 'standalone') fail('web manifest display is not standalone');
if (manifest.start_url !== './') fail('web manifest start_url is not ./');
for (const icon of manifest.icons ?? []) {
  const iconRel = icon.src.replace(/^\.\//, '');
  if (!existsSync(join(dist, iconRel))) fail(`web manifest icon is missing from dist: ${icon.src}`);
}

// 4. The built shell links the manifest.
const html = readFileSync(join(dist, 'index.html'), 'utf8');
if (!html.includes('manifest.webmanifest')) fail('dist/index.html does not link the web manifest');

console.log(
  `check:offline OK: ${distFiles.length} dist files, ${precache.length} precached under ${cacheName}, manifest + sw.js present`,
);
