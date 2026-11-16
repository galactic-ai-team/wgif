import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false, // dist total excludes .map anyway; don't ship them
    manifest: true, // lets size-report reason about the entry chunk later
    reportCompressedSize: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('@wgif/format')) return 'wgif-format';
        },
      },
    },
  },
  test: { environment: 'node' },
});
