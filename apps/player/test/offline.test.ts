import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPrecacheList, cacheNameFor } from '../vite-offline.js';

const playerRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(`${playerRoot}/${rel}`, 'utf8');

describe('offline PWA (Phase One item 6)', () => {
  it('versions the cache name from the player package version', () => {
    expect(cacheNameFor('0.1.0')).toBe('wgif-player-v0.1.0');
    expect(cacheNameFor('0.2.0')).toBe('wgif-player-v0.2.0');
  });

  it('precaches every emitted file except the worker and the Vite manifest', () => {
    expect(
      buildPrecacheList([
        'index.html',
        'assets/index-abc123.js',
        'assets/index-def456.css',
        'samples/court.wgif',
        'manifest.webmanifest',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'sw.js',
        '.vite/manifest.json',
      ]),
    ).toEqual([
      './',
      './assets/index-abc123.js',
      './assets/index-def456.css',
      './icons/icon-192.png',
      './icons/icon-512.png',
      './index.html',
      './manifest.webmanifest',
      './samples/court.wgif',
    ]);
  });

  it('keeps the service worker dependency-free and cache-first', () => {
    const sw = read('src/sw.ts');
    // Zero runtime dependencies: no imports at all — the build only injects
    // two constants into this file, it never bundles anything into it.
    expect(sw).not.toMatch(/^import /m);
    expect(sw).not.toMatch(/from ['"]/);
    // No workbox (or any other) library is actually loaded — the comment in
    // sw.ts explains why it was not chosen, so match real references only.
    expect(sw).not.toMatch(/from\s+['"]workbox|require\(\s*['"]workbox|import\s*\(\s*['"]workbox/);
    // The build injects these two placeholders (see vite-offline.ts).
    expect(sw).toContain('__WGIF_CACHE_NAME__');
    expect(sw).toContain('__WGIF_PRECACHE_URLS__');
    // Lifecycle: install precaches and takes over at once; activate deletes
    // older wgif-player-* caches and claims the page.
    expect(sw).toContain('cache.addAll');
    expect(sw).toContain('skipWaiting');
    expect(sw).toContain('clients.claim');
    expect(sw).toContain("startsWith('wgif-player-')");
    // Cache-first for precached URLs, network-first with cache fallback else.
    expect(sw).toContain('PRECACHE.has');
    expect(sw).toContain('cache.match(request, { ignoreSearch: true })');
  });

  it('ships a web manifest with installable icons', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    expect(manifest.name).toBe('WGIF Player');
    expect(manifest.short_name).toBe('WGIF');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    const sizes = (manifest.icons as { sizes: string; src: string; type: string }[]).map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    for (const icon of manifest.icons as { src: string }[]) {
      const rel = icon.src.replace(/^\.\//, '');
      const abs = `${playerRoot}/public/${rel}`;
      expect(existsSync(abs)).toBe(true);
      // PNG magic bytes.
      expect(readFileSync(abs).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  });

  it('links the manifest from the shell and registers the worker in production only', () => {
    const html = read('index.html');
    expect(html).toContain('manifest.webmanifest');
    expect(html).toContain('theme-color');
    const main = read('src/main.ts');
    expect(main).toContain('import.meta.env.PROD');
    expect(main).toContain("navigator.serviceWorker.register('sw.js')");
  });

  it('adds no new runtime dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@wgif/ai', '@wgif/format', 'three']);
  });

  it("pins Dee's mobile item 1: pixel ratio capped at 2", () => {
    expect(read('src/viewer.ts')).toContain('renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))');
  });
});
