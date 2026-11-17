import { describe, expect, it } from 'vitest';
import { exportEditedWorld, packWgif, sha256Hex, unpackWgif, utf8 } from '../src/index.js';

const payloads = {
  'world.glb': utf8('glTF-fake-binary'),
  'preview.png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
  'game-state.json': utf8('{"score":0}'),
};

async function sourceWorld() {
  const archive = await packWgif({
    wgif: '0.1', id: 'test.portable.edits', title: 'Portable edited world',
    creator: { name: 'Test creator' }, created: '2026-11-15T00:00:00Z',
    mode: 'editable', entry: { scene: 'world.glb', preview: 'preview.png', state: 'game-state.json' },
  }, payloads);
  return unpackWgif(archive);
}

describe('edited WGIF portability boundary', () => {
  it('exports updated state with refreshed hashes and reopens as valid WGIF', async () => {
    const world = await sourceWorld();
    expect(world.report.ok).toBe(true);
    const changed = utf8('{"score":4}');
    const files = { ...world.files, 'game-state.json': changed };
    const edited = { manifest: world.manifest, files };
    const at = new Date('2026-11-16T00:00:00Z');
    const bytes = await exportEditedWorld(edited, { by: 'editor', at });
    const received = await unpackWgif(bytes);
    expect(received.report.ok).toBe(true);
    expect(received.manifest.modified).toBe('2026-11-16T00:00:00Z');
    expect(received.manifest.provenance?.history?.at(-1)?.by).toBe('editor');
    expect(received.manifest.files.find((f) => f.path === 'game-state.json')?.sha256)
      .toBe(await sha256Hex(changed));
    expect(received.files['game-state.json']).toEqual(changed);
    expect(await exportEditedWorld(edited, { by: 'editor', at })).toEqual(bytes);
  });

  it('refuses export when an edited declarative payload is invalid', async () => {
    const world = await sourceWorld();
    const files = { ...world.files, 'game-state.json': utf8('{"score":') };
    await expect(exportEditedWorld({ manifest: world.manifest, files }))
      .rejects.toMatchObject({ code: 'export.invalid' });
  });
});
