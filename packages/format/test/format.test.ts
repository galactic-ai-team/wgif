import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import manifestSchema from '../schema/manifest.v0.1.schema.json';
import descriptorSchema from '../schema/model-descriptor.v0.1.schema.json';
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

describe('embedded model descriptors (§5.5, Embedded AI lane)', () => {
  const rulesModel = {
    id: 'rebounder-rules',
    path: 'models/rebounder.rules.json',
    runtime: 'rules' as const,
    purpose: 'rebounder',
    version: '0.1.0',
    inputs: [
      { name: 'ball_position', description: 'Ball position [x, y, z] in meters.' },
      { name: 'ball_velocity', description: 'Ball velocity [x, y, z] in m/s.' },
      { name: 'ball_held_by', description: '"player", "rebounder", or null.' },
      { name: 'player_position', description: 'Player position [x, y, z] in meters.' },
      { name: 'self_position', description: 'Rebounder position [x, y, z] in meters.' },
    ],
    outputs: [
      { name: 'velocity', description: 'Move velocity [x, y, z] in m/s (y is always 0).' },
      { name: 'pass_ball', description: 'True on the tick the ball is passed back.' },
      { name: 'holding_ball', description: 'True while the rebounder carries the ball.' },
    ],
    tickHz: 10,
    deterministic: true,
    seed: 7,
    license: 'MIT',
  };

  function withModel(models: unknown[], filesExtra: WgifFiles = {}): { manifest: ManifestInput; files: WgifFiles } {
    const { manifest, files } = sample();
    return {
      manifest: { ...manifest, models: models as ManifestInput['models'] },
      files: { ...files, 'models/rebounder.rules.json': utf8('{"version":"0.1-draft"}'), ...filesExtra },
    };
  }

  it('keeps the standalone descriptor schema identical to the manifest copy', () => {
    const { $id: _id, $schema: _schema, ...standalone } = descriptorSchema as Record<string, unknown>;
    const embedded = (manifestSchema as { definitions: { modelDescriptor: unknown } }).definitions.modelDescriptor;
    expect(embedded).toEqual(standalone);
  });

  it('accepts a well-formed rules model and round-trips it', async () => {
    const { manifest, files } = withModel([rulesModel]);
    const world = await unpackWgif(await packWgif(manifest, files));
    expect(world.report.errors).toEqual([]);
    expect(world.report.ok).toBe(true);
    expect(world.manifest.models?.[0]?.id).toBe('rebounder-rules');
    expect(world.manifest.files.find((f) => f.path === 'models/rebounder.rules.json')?.role).toBe('model');
  });

  it('rejects an onnx model without tensor inputs/outputs, and deterministic models without a seed', async () => {
    const packWorld = async (models: unknown[], extra: WgifFiles = {}) => {
      const { manifest, files } = withModel(models, extra);
      return unpackWgif(await packWgif(manifest, files));
    };
    const noTensors = await packWorld([{ id: 'm', path: 'models/m.onnx', runtime: 'onnx' }], { 'models/m.onnx': utf8('fake') });
    expect(noTensors.report.errors.map((e) => e.code)).toContain('models.tensor');
    const noDtype = await packWorld(
      [{ id: 'm', path: 'models/m.onnx', runtime: 'onnx', inputs: [{ name: 'obs', shape: [1, 8] }], outputs: [{ name: 'action', shape: [1, 3], dtype: 'float32' }] }],
      { 'models/m.onnx': utf8('fake') },
    );
    expect(noDtype.report.errors.map((e) => e.code)).toContain('models.tensor');
    const { seed: _seed, ...noSeedModel } = rulesModel;
    const noSeed = await packWorld([{ ...noSeedModel, deterministic: true }]);
    expect(noSeed.report.errors.map((e) => e.code)).toContain('models.seed');
  });

  it('rejects bad paths and bad runtimes (schema)', () => {
    const base = { wgif: '0.1', id: 'test.world.1', title: 't', creator: { name: 'x' }, created: '2026-11-15T00:00:00Z', mode: 'editable', entry: { scene: 'world.glb', preview: 'preview.png' }, files: [] };
    const badPath = validateManifestSchema({ ...base, models: [{ ...rulesModel, path: 'assets/rebounder.rules.json' }] });
    expect(badPath.length).toBeGreaterThan(0);
    const badRuntime = validateManifestSchema({ ...base, models: [{ ...rulesModel, runtime: 'tensorflow' }] });
    expect(badRuntime.length).toBeGreaterThan(0);
  });

  it('rejects oversize models, unknown fallbacks, fallback chains and duplicate ids', async () => {
    const packWorld = async (models: unknown[], extra: WgifFiles = {}) => {
      const { manifest, files } = withModel(models, extra);
      return unpackWgif(await packWgif(manifest, files));
    };
    const over = await packWorld([{ ...rulesModel, sizeBytesMax: 10 }]);
    expect(over.report.errors.map((e) => e.code)).toContain('models.oversize');

    const badFallback = await packWorld([{ ...rulesModel, fallback: 'nope' }]);
    expect(badFallback.report.errors.map((e) => e.code)).toContain('models.fallback');

    const onnx = { ...rulesModel, id: 'rebounder-mlp', path: 'models/rebounder-mlp.onnx', runtime: 'onnx' as const, fallback: 'rebounder-rules' };
    const chain = await packWorld(
      [{ ...rulesModel, fallback: 'rebounder-mlp' }, onnx],
      { 'models/rebounder-mlp.onnx': utf8('fake-onnx') },
    );
    expect(chain.report.errors.map((e) => e.code)).toContain('models.fallback');

    const dup = await packWorld([rulesModel, rulesModel]);
    expect(dup.report.errors.map((e) => e.code)).toContain('models.duplicate');
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
