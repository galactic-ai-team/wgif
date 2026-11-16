import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  packWgif, signingHash, unpackWgif, utf8, validateManifestSchema,
  type ModelEntry, type WgifFiles,
} from '../src/index.js';

const rules: ModelEntry = {
  id: 'rebounder-rules', path: 'models/rebounder.rules.json', runtime: 'rules',
  purpose: 'rebounder', deterministic: true, seed: 7, tickHz: 10,
};
const onnx: ModelEntry = {
  id: 'rebounder-mlp', path: 'models/rebounder-mlp.onnx', runtime: 'onnx',
  purpose: 'rebounder', fallback: 'rebounder-rules',
  inputs: [{ name: 'obs', dtype: 'float32', shape: [1, 14], range: [-20, 20] }],
  outputs: [{ name: 'action', dtype: 'float32', shape: [1, 3] }],
};

async function world(models: ModelEntry[], extra: WgifFiles = {}, requires: string[] = ['scene.glb', 'runtime.rules']) {
  const fixture = await readFile(new URL('../../../tests/fixtures/good-minimal.wgif', import.meta.url));
  const base = await unpackWgif(new Uint8Array(fixture));
  const files = {
    ...base.files,
    'models/rebounder.rules.json': utf8('{"version":"0.1","deterministic":true,"seed":7}'),
    'models/rebounder-mlp.onnx': utf8('fake-on-device-model-for-format-validation'),
    ...extra,
  };
  return unpackWgif(await packWgif({ ...base.manifest, models, requires }, files));
}

const errorCodes = async (models: ModelEntry[], extra?: WgifFiles) =>
  (await world(models, extra)).report.errors.map((e) => e.code);

const warningCodes = async (models: ModelEntry[], requires?: string[]) =>
  (await world(models, {}, requires)).report.warnings.map((w) => w.code);

describe('Nova model descriptors integrated into hardened RC1 validator', () => {
  it('accepts a same-purpose ONNX -> rules fallback without requiring ONNX', async () => {
    const result = await world([onnx, rules]);
    expect(result.report.ok).toBe(true);
    expect(result.manifest.requires).toContain('runtime.rules');
    expect(result.manifest.requires).not.toContain('runtime.onnx');
  });

  it('warns when runtime.onnx is required but every ONNX model has a usable rules fallback', async () => {
    const withOnnx = ['scene.glb', 'runtime.rules', 'runtime.onnx'];
    const result = await world([onnx, rules], {}, withOnnx);
    expect(result.report.ok).toBe(true); // a SHOULD NOT, not a MUST NOT
    expect(await warningCodes([onnx, rules], withOnnx)).toContain('requires.onnx-unneeded');
    // No warning when an ONNX model has no fallback: the world genuinely
    // needs an ONNX runtime for it.
    expect(await warningCodes([{ ...onnx, fallback: undefined }], withOnnx)).not.toContain('requires.onnx-unneeded');
    // No warning when runtime.onnx is not required at all (the court case).
    expect(await warningCodes([onnx, rules])).not.toContain('requires.onnx-unneeded');
  });

  it('rejects bad fallback identity, purpose and runtime', async () => {
    expect(await errorCodes([{ ...onnx, fallback: 'missing' }, rules])).toContain('models.fallback');
    expect(await errorCodes([{ ...onnx, fallback: onnx.id }, rules])).toContain('models.fallback');
    expect(await errorCodes([onnx, { ...rules, purpose: 'different' }])).toContain('models.fallback');
    expect(await errorCodes([{ ...onnx, fallback: 'another-onnx' }, rules, {
      ...onnx, id: 'another-onnx', fallback: undefined,
    }])).toContain('models.fallback');
    expect(await errorCodes([{ ...rules, fallback: onnx.id }, onnx])).toContain('models.fallback');
  });

  it('rejects deterministic-rules omissions, duplicate IDs and duplicate paths', async () => {
    expect(await errorCodes([{ ...rules, deterministic: false }])).toContain('models.deterministic');
    expect(await errorCodes([{ ...rules, seed: undefined }])).toContain('models.seed');
    expect(await errorCodes([rules, rules])).toContain('models.duplicate');
    expect(await errorCodes([rules, { ...rules, id: 'other-rules' }])).toContain('models.duplicate-path');
  });

  it('rejects malformed tensor shapes and ranges, and oversized model files', async () => {
    expect(await errorCodes([{ ...onnx, inputs: [{ name: 'obs', shape: [2, 14], dtype: 'float32' }] }, rules]))
      .toContain('models.tensor');
    expect(await errorCodes([{ ...onnx, outputs: [{ name: 'action', shape: [1, 65537], dtype: 'float32' }] }, rules]))
      .toContain('models.tensor');
    expect(await errorCodes([{ ...onnx, inputs: [{ name: 'obs', shape: [1, 14], dtype: 'float32', range: [5, -5] }] }, rules]))
      .toContain('models.tensor');
    expect(await errorCodes([rules], { 'models/rebounder.rules.json': new Uint8Array(65537) }))
      .toContain('models.oversize');
  });

  it('rejects executable or malformed model paths and duplicate capability fields', () => {
    const m = { wgif: '0.1', id: 'test.world.1', title: 'Example', creator: { name: 'Tester' },
      created: '2026-11-15T00:00:00Z', mode: 'editable',
      entry: { scene: 'world.glb', preview: 'preview.png' }, files: [],
      models: [{ ...rules, path: 'models/../private.json' }] };
    expect(validateManifestSchema(m).length).toBeGreaterThan(0);
    expect(validateManifestSchema({ ...m, models: [rules], requiredExtensions: ['runtime.onnx'] }).length).toBeGreaterThan(0);
  });

  it('keeps standalone model schema identical to the embedded manifest definition', async () => {
    const read = async (name: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(new URL(`../schema/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
    const descriptor = await read('model-descriptor.v0.1.schema.json');
    const manifest = await read('manifest.v0.1.schema.json');
    const { $id: _id, $schema: _schema, ...body } = descriptor;
    expect((manifest.definitions as Record<string, unknown>).modelDescriptor).toEqual(body);
  });
});

// Provenance parameters are permitted before v0.1 freeze and are part of the signed view.
describe('provenance.params in v0.1', () => {
  it('accepts and round-trips arbitrary nested JSON parameters, including them in the signing hash', async () => {
    const fixture = await readFile(new URL('../../../tests/fixtures/good-minimal.wgif', import.meta.url));
    const base = await unpackWgif(new Uint8Array(fixture));
    const params = {
      seed: 7, generatorMode: 'procedural', dimensions: [16, 8],
      options: { textures: true, density: 0.25, unused: null },
    };
    const packed = await packWgif({
      ...base.manifest, provenance: { generator: 'wgif-worldgen', params },
    }, base.files);
    const result = await unpackWgif(packed);
    expect(result.report.ok).toBe(true);
    expect(result.manifest.provenance?.params).toEqual(params);
    const changed = { ...result.manifest, provenance: {
      ...result.manifest.provenance, params: { ...params, seed: 8 },
    } };
    expect(await signingHash(result.manifest)).not.toBe(await signingHash(changed));
  });

  it('rejects non-object provenance.params (null, array or scalar)', async () => {
    const fixture = await readFile(new URL('../../../tests/fixtures/good-minimal.wgif', import.meta.url));
    const base = await unpackWgif(new Uint8Array(fixture));
    for (const params of [null, [], 7, 'text', false]) {
      const errors = validateManifestSchema({ ...base.manifest, provenance: { params } });
      expect(errors).toContainEqual(expect.objectContaining({
        code: 'schema.type', path: '/provenance/params',
      }));
    }
  });
});
