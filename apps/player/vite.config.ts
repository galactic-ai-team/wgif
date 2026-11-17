import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { offlinePrecachePlugin } from './vite-offline.js';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false, // dist total excludes .map anyway; don't ship them
    manifest: true, // lets size-report reason about the entry chunk later
    reportCompressedSize: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // The service worker is a second build input so it ships as its own
      // file, not bundled into the app. The offlinePrecache plugin injects
      // the versioned cache name and this build's precache list into it.
      input: {
        index: resolve(root, 'index.html'),
        sw: resolve(root, 'src/sw.ts'),
      },
      output: {
        // The service worker must be served from the dist root as sw.js —
        // its scope is its own directory — so it keeps a fixed name while
        // every other entry keeps the hashed asset name.
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('@wgif/format')) return 'wgif-format';
        },
      },
    },
  },
  plugins: [offlinePrecachePlugin()],
  test: { environment: 'node' },
});
