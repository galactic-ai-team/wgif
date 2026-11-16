import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** The service-worker cache name for a player build, versioned from the player package. */
export function cacheNameFor(version: string): string {
  return `wgif-player-v${version}`;
}

/**
 * The precache list for a built player: every file Vite emits into dist —
 * the app shell, the web manifest, the icons, the sample court — except the
 * service worker itself and the Vite build manifest. Paths are './'-relative
 * so they resolve against the service worker's own URL whatever subpath the
 * player is served from.
 */
export function buildPrecacheList(fileNames: Iterable<string>): string[] {
  const list: string[] = [];
  for (const name of fileNames) {
    if (name === 'sw.js' || name === '.vite/manifest.json' || name === 'manifest.json') continue;
    list.push(`./${name}`);
  }
  // The shell root ('/') is served as index.html, but it is a different URL
  // from './index.html' — precache it too, or an offline reload of the
  // player itself (a navigation to '/') would miss the cache.
  if (list.includes('./index.html') && !list.includes('./')) list.push('./');
  return list.sort();
}

/**
 * Vite plugin that turns src/sw.ts into dist/sw.js with the versioned cache
 * name and this build's precache list injected. The worker source stays
 * dependency-free: the plugin only does string replacement on the emitted
 * file, it never imports anything into it.
 *
 * The injection happens in writeBundle, not generateBundle: public-dir
 * files (the manifest, the icons, the sample court) are copied into dist
 * after generateBundle, and the HTML asset may not be in the bundle yet
 * either — so the true file list is read from dist once everything is
 * written.
 */
export function offlinePrecachePlugin(): Plugin {
  const playerRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
  const pkg = JSON.parse(readFileSync(resolve(playerRoot, 'package.json'), 'utf8')) as { version: string };
  const cacheName = cacheNameFor(pkg.version);
  return {
    name: 'wgif-offline-precache',
    writeBundle(options) {
      const distDir = resolve(playerRoot, options.dir ?? 'dist');
      const swPath = resolve(distDir, 'sw.js');
      let code: string;
      try {
        code = readFileSync(swPath, 'utf8');
      } catch {
        throw new Error('offlinePrecache: dist/sw.js is missing (add src/sw.ts as a build input)');
      }
      const files: string[] = [];
      const walk = (dir: string, rel: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(resolve(dir, entry.name), childRel);
          else files.push(childRel);
        }
      };
      walk(distDir, '');
      const injected = code
        .replace('__WGIF_CACHE_NAME__', cacheName)
        .replace('__WGIF_PRECACHE_URLS__', JSON.stringify(buildPrecacheList(files)));
      if (injected.includes('__WGIF_')) {
        throw new Error('offlinePrecache: a __WGIF_*__ placeholder survived injection in sw.js');
      }
      writeFileSync(swPath, injected);
    },
  };
}
