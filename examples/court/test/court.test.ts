import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unpackWgif } from '@wgif/format';
import { buildCourtWgif } from '../src/world.js';

describe('example court', () => {
  it('builds a valid, reproducible .wgif', async () => {
    const a = await buildCourtWgif();
    const b = await buildCourtWgif();
    expect(a).toEqual(b);
    const world = await unpackWgif(a);
    expect(world.report.errors).toEqual([]);
    expect(world.manifest.mode).toBe('editable');
    const glb = world.files['world.glb']!;
    expect(new TextDecoder().decode(glb.subarray(0, 4))).toBe('glTF');
    expect(Array.from(world.files['preview.png']!.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(a.byteLength).toBeLessThan(200 * 1024);
  });

  it('committed court.wgif matches the generator', async () => {
    const committed = new Uint8Array(readFileSync(fileURLToPath(new URL('../court.wgif', import.meta.url))));
    expect(committed).toEqual(await buildCourtWgif());
  });
});
