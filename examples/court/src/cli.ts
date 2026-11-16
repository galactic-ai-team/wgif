import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackWgif } from '@wgif/format';
import { buildCourtWgif } from './world.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputs = [resolve(here, '../court.wgif'), resolve(here, '../../../apps/player/public/samples/court.wgif')];

const bytes = await buildCourtWgif();
const { report, manifest } = await unpackWgif(bytes);
if (!report.ok) {
  console.error('court.wgif failed validation:', report.errors);
  process.exit(1);
}
for (const out of outputs) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
}
const sizes = manifest.files.map((f) => `${f.path}=${f.size}B`).join(', ');
console.log(`court.wgif ${bytes.byteLength} bytes (${sizes}) -> ${outputs.join(', ')}`);
