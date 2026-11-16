import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import {
  exportEditedWorld,
  generateKeyPair,
  packManifestAndFiles,
  packWgif,
  readContainer,
  signManifest,
  signingHash,
  unpackWgif,
  utf8,
  validateManifestSchema,
  WgifReadError,
  type ManifestInput,
  type WgifFiles,
} from '../src/index.js';

const PNG_1PX = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function sample(mode: ManifestInput['mode'] = 'editable'): { manifest: ManifestInput; files: WgifFiles } {
  return {
    manifest: {
      wgif: '0.1',
      id: 'test.world.1',
      title: 'Test world',
      creator: { name: 'Galactic AI Team' },
      created: '2026-11-15T00:00:00Z',
      mode,
      entry: { scene: 'world.glb', preview: 'preview.png', interactions: 'interactions.json', state: 'game-state.json' },
    },
    files: {
      'world.glb': utf8('glTF-fake-binary'),
      'preview.png': PNG_1PX,
      'interactions.json': utf8('{"interactions":[]}'),
      'game-state.json': utf8('{"score":0}'),
      'assets/note.txt': utf8('hello'),
    },
  };
}

describe('pack / unpack', () => {
  it('round-trips a world and validates it', async () => {
    const { manifest, files } = sample();
    const bytes = await packWgif(manifest, files);
    const world = await unpackWgif(bytes);
    expect(world.report.errors).toEqual([]);
    expect(world.report.ok).toBe(true);
    expect(world.manifest.files.map((f) => f.path)).toEqual(Object.keys(files).sort());
    expect(new TextDecoder().decode(world.files['game-state.json'])).toBe('{"score":0}');
    const roles = Object.fromEntries(world.manifest.files.map((f) => [f.path, f.role]));
    expect(roles).toMatchObject({ 'world.glb': 'scene', 'preview.png': 'preview', 'assets/note.txt': 'asset' });
  });

  it('is byte-for-byte reproducible by default', async () => {
    const { manifest, files } = sample();
    expect(await packWgif(manifest, files)).toEqual(await packWgif(manifest, files));
  });

  it('writes the same bytes in any timezone', async () => {
    const { manifest, files } = sample();
    const before = process.env.TZ;
    process.env.TZ = 'UTC';
    const a = await packWgif(manifest, files);
    process.env.TZ = 'Asia/Tokyo';
    const b = await packWgif(manifest, files);
    process.env.TZ = before;
    expect(a).toEqual(b);
  });

  it('writes manifest.json as the first, stored entry', async () => {
    const { manifest, files } = sample();
    const bytes = await packWgif(manifest, files);
    const nameLen = bytes[26]! | (bytes[27]! << 8);
    expect(new TextDecoder().decode(bytes.subarray(30, 30 + nameLen))).toBe('manifest.json');
    expect(bytes[8]! | (bytes[9]! << 8)).toBe(0); // compression method 0 = stored
  });

  it('rejects non-zip input and missing manifest', async () => {
    await expect(unpackWgif(utf8('GIF89a...'))).rejects.toMatchObject({ code: 'container.notzip' });
    const noManifest = zipSync({ 'world.glb': utf8('x') });
    await expect(unpackWgif(noManifest)).rejects.toBeInstanceOf(WgifReadError);
  });

  it('enforces entry limits', () => {
    const { files } = sample();
    const bytes = zipSync({ 'manifest.json': utf8('{}'), ...files });
    expect(() => readContainer(bytes, { maxEntries: 2, maxEntryBytes: 1e6, maxTotalBytes: 1e6 })).toThrow(/entries/);
  });
});

describe('validation', () => {
  it('flags schema errors', () => {
    const issues = validateManifestSchema({ wgif: 'one', title: '' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.code === 'schema.required')).toBe(true);
  });

  it('detects tampered payloads', async () => {
    const { manifest, files } = sample();
    const world = await unpackWgif(await packWgif(manifest, files));
    const tampered = packManifestAndFiles(world.manifest, { ...world.files, 'game-state.json': utf8('{"score":999}') });
    const reopened = await unpackWgif(tampered);
    expect(reopened.report.ok).toBe(false);
    expect(reopened.report.errors.map((e) => e.code)).toContain('files.hash');
  });

  it('detects undeclared and missing files', async () => {
    const { manifest, files } = sample();
    const world = await unpackWgif(await packWgif(manifest, files));
    const extra = { ...world.files, 'sneaky.js': utf8('alert(1)') };
    const { 'assets/note.txt': _drop, ...missing } = world.files;
    const r1 = await unpackWgif(packManifestAndFiles(world.manifest, extra));
    const r2 = await unpackWgif(packManifestAndFiles(world.manifest, missing));
    expect(r1.report.errors.map((e) => e.code)).toContain('files.undeclared');
    expect(r2.report.errors.map((e) => e.code)).toContain('files.absent');
  });

  it('rejects unknown major versions and broken entry refs', async () => {
    const { manifest, files } = sample();
    const world = await unpackWgif(await packWgif({ ...manifest, wgif: '2.0' }, files));
    expect(world.report.errors.map((e) => e.code)).toContain('version.major');
    const bad = await unpackWgif(await packWgif({ ...manifest, entry: { ...manifest.entry, scene: 'nope.glb' } }, files));
    expect(bad.report.errors.map((e) => e.code)).toContain('ref.missing');
  });

  it('refuses unsafe paths when packing', async () => {
    const { manifest, files } = sample();
    await expect(packWgif(manifest, { ...files, '../evil.txt': utf8('x') })).rejects.toThrow(/unsafe/);
  });

  it('warns when a locked world is unsigned', async () => {
    const { manifest, files } = sample('locked');
    const world = await unpackWgif(await packWgif(manifest, files));
    expect(world.report.ok).toBe(true);
    expect(world.report.warnings.map((w) => w.code)).toContain('signature.absent');
  });
});

describe('signatures, locking and edits', () => {
  it('signs and verifies; tampering invalidates', async () => {
    const { manifest, files } = sample('locked');
    const keys = await generateKeyPair();
    const unsigned = (await unpackWgif(await packWgif(manifest, files))).manifest;
    const signed = await signManifest(unsigned, keys.secretKey);
    const ok = await unpackWgif(packManifestAndFiles(signed, files));
    expect(ok.report.signature).toBe('valid');

    const flipped = { ...signed, mode: 'editable' as const };
    const bad = await unpackWgif(packManifestAndFiles(flipped, files));
    expect(bad.report.signature).toBe('invalid');
  });

  it('refuses to export edits of a locked world', async () => {
    const { manifest, files } = sample('locked');
    const world = await unpackWgif(await packWgif(manifest, files));
    await expect(exportEditedWorld(world)).rejects.toMatchObject({ code: 'mode.locked' });
  });

  it('exports an edited world with new hashes, history and parent provenance', async () => {
    const { manifest, files } = sample('editable');
    const keys = await generateKeyPair();
    const opened = await unpackWgif(await packWgif(manifest, files));
    const signed = await signManifest(opened.manifest, keys.secretKey);
    const parentHash = await signingHash(signed);
    const edited = { manifest: signed, files: { ...opened.files, 'game-state.json': utf8('{"score":3}') } };
    const out = await unpackWgif(await exportEditedWorld(edited, { by: 'tester', at: new Date('2026-11-16T00:00:00Z') }));
    expect(out.report.ok).toBe(true);
    expect(out.manifest.signature).toBeUndefined();
    expect(out.manifest.provenance?.parent).toEqual({ id: 'test.world.1', signingHash: parentHash });
    expect(out.manifest.provenance?.history?.at(-1)).toMatchObject({ action: 'edit', by: 'tester' });
    expect(new TextDecoder().decode(out.files['game-state.json'])).toBe('{"score":3}');
  });

  it('keeps the base signature valid when only layers are added', async () => {
    const { manifest, files } = sample('layered');
    const keys = await generateKeyPair();
    const base = (await unpackWgif(await packWgif(manifest, files))).manifest;
    const signed = await signManifest(base, keys.secretKey);
    const layerFiles = { ...files, 'layers/user-1.json': utf8('{"add":[]}') };
    const layered = await packWgif(
      { ...signed, layers: [{ id: 'user-1', path: 'layers/user-1.json', author: 'friend' }], files: undefined },
      layerFiles,
    );
    const world = await unpackWgif(layered);
    expect(world.report.ok).toBe(true);
    expect(world.report.signature).toBe('valid');
  });
});
