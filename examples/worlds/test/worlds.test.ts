import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readGlbJson, unpackWgif, verifyManifestSignature } from '@wgif/format';
import { CITY, CITY_TEST_KEY_SEED, ORB_COUNT, buildCityWgif } from '../src/city.js';
import { ARTWORKS } from '../src/gallery.js';
import { WORLDS_ROOT } from '../src/common.js';
import { WORLDS } from '../src/worlds.js';

const budgets = JSON.parse(readFileSync(resolve(WORLDS_ROOT, '../../scripts/size-budgets.json'), 'utf8')) as {
  worldTotalBytes: number;
  worldEntryBytes: Record<string, number>;
};

describe.each(Object.keys(WORLDS))('sample world %s', (name) => {
  it('is reproducible, valid, inside the Phase One budgets and matches the committed file', async () => {
    const a = await WORLDS[name]!();
    const b = await WORLDS[name]!();
    expect(a).toEqual(b);
    const world = await unpackWgif(a);
    expect(world.report.errors).toEqual([]);
    expect(world.report.ok).toBe(true);
    expect(a.byteLength).toBeLessThanOrEqual(budgets.worldTotalBytes);
    for (const [path, bytes] of Object.entries(world.files)) {
      const cap = budgets.worldEntryBytes[path];
      if (cap) expect(bytes.byteLength, path).toBeLessThanOrEqual(cap);
    }
    const preview = world.files[world.manifest.entry.preview]!;
    expect(Array.from(preview.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(new DataView(preview.buffer, preview.byteOffset).getUint32(16)).toBeLessThanOrEqual(512); // IHDR width
    // Committed copy is exactly what the generator makes (like court.wgif).
    const committed = new Uint8Array(readFileSync(resolve(WORLDS_ROOT, `${name}.wgif`)));
    expect(committed).toEqual(a);
  });
});

describe('gallery', () => {
  it('embeds every painting as a GLB texture and credits each one', async () => {
    const world = await unpackWgif(await WORLDS.gallery!());
    expect(world.manifest.mode).toBe('locked');
    const gltf = readGlbJson(world.files['world.glb']!) as { images: { mimeType: string }[]; nodes: { name: string; extras?: { wgif?: { credit?: { license: string } } } }[] };
    expect(gltf.images).toHaveLength(ARTWORKS.length);
    expect(gltf.images.every((i) => i.mimeType === 'image/jpeg')).toBe(true);
    const credited = gltf.nodes.filter((n) => n.extras?.wgif?.credit?.license === 'Public domain');
    expect(credited).toHaveLength(ARTWORKS.length);
    const credits = world.manifest.extensions?.['x-credits'] as { license: string; source: string }[];
    expect(credits).toHaveLength(ARTWORKS.length);
    expect(credits.every((c) => c.license === 'Public domain' && c.source.startsWith('https://commons.wikimedia.org/'))).toBe(true);
  });
});

describe('rooftop', () => {
  it('has a CC0 panorama sky and a one-hoop shootout', async () => {
    const world = await unpackWgif(await WORLDS.rooftop!());
    const gltf = readGlbJson(world.files['world.glb']!) as { nodes: { name: string; extras?: { wgif?: { role?: string } } }[] };
    expect(gltf.nodes.find((n) => n.extras?.wgif?.role === 'sky')?.name).toBe('sky_rooftop_night');
    const ix = JSON.parse(new TextDecoder().decode(world.files['interactions.json'])) as { minigames: { type: string; targets: string[] }[] };
    expect(ix.minigames[0]).toMatchObject({ type: 'basketball-shooting', targets: ['rim'] });
    expect((world.manifest.extensions?.['x-credits'] as { license: string }[])[0]!.license).toBe('CC0-1.0');
  });
});

describe('city (stress)', () => {
  it('is layered with a valid base signature from the public test key', async () => {
    const world = await unpackWgif(await buildCityWgif(CITY));
    expect(world.manifest.mode).toBe('layered');
    expect(world.report.signature).toBe('valid');
    expect(await verifyManifestSignature(world.manifest)).toBe(true);
    expect(world.manifest.layers?.map((l) => l.id)).toEqual(['neon-signs', 'drone-swarm', 'remix']);
    expect(CITY_TEST_KEY_SEED).toMatch(/PUBLIC TEST KEY/);
    const gltf = readGlbJson(world.files['world.glb']!) as { nodes: { name: string }[] };
    expect(gltf.nodes.filter((n) => n.name.startsWith('tower_')).length).toBeGreaterThan(200);
    expect(gltf.nodes.filter((n) => n.name.startsWith('orb_'))).toHaveLength(ORB_COUNT);
    // Heavy on purpose: the scene sits near the 768 KiB Phase One scene budget.
    expect(world.files['world.glb']!.byteLength).toBeGreaterThan(600 * 1024);
  });
});
