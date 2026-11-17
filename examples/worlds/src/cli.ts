/**
 * Builds the sample worlds.
 *
 *   tsx examples/worlds/src/cli.ts            -> examples/worlds/<name>.wgif + apps/player/public/samples/<name>.wgif
 *   tsx examples/worlds/src/cli.ts --xl <dir> -> also <dir>/city-xl.wgif (device stress build, never committed)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { unpackWgif } from '@wgif/format';
import { WORLDS_ROOT } from './common.js';
import { EXTRA_WORLDS, WORLDS } from './worlds.js';

const args = process.argv.slice(2);
const xlAt = args.indexOf('--xl');
const xlDir = xlAt >= 0 ? args[xlAt + 1] : undefined;
const playerSamples = resolve(WORLDS_ROOT, '../../apps/player/public/samples');

async function emit(name: string, build: () => Promise<Uint8Array>, outs: string[]): Promise<void> {
  const bytes = await build();
  const { report, manifest } = await unpackWgif(bytes);
  if (!report.ok) {
    console.error(`${name}.wgif failed validation:`, report.errors);
    process.exit(1);
  }
  for (const out of outs) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
  }
  console.log(`${name}.wgif ${bytes.byteLength} bytes, ${manifest.files.length} payloads, signature ${report.signature} -> ${outs.join(', ')}`);
}

for (const [name, build] of Object.entries(WORLDS)) {
  await emit(name, build, [resolve(WORLDS_ROOT, `${name}.wgif`), resolve(playerSamples, `${name}.wgif`)]);
}
if (xlDir) for (const [name, build] of Object.entries(EXTRA_WORLDS)) await emit(name, build, [resolve(process.cwd(), xlDir, `${name}.wgif`)]);
