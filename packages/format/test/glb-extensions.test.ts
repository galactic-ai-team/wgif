import { describe, expect, it } from 'vitest';
import { checkGlbExtensions, readGlbJson } from '../src/glbExtensions.js';
import { unpackWgif, utf8, validateWorld } from '../src/index.js';
import { readFileSync } from 'node:fs';

function glb(json: Record<string, unknown>): Uint8Array {
  const data = utf8(JSON.stringify({ asset: { version: '2.0' }, ...json }));
  const size = Math.ceil(data.length / 4) * 4;
  const result = new Uint8Array(20 + size);
  result.set(utf8('glTF'), 0);
  const view = new DataView(result.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, result.length, true);
  view.setUint32(12, size, true);
  result.set(utf8('JSON'), 16);
  result.fill(0x20, 20, result.length);
  result.set(data, 20);
  return result;
}

const allowed = 'KHR_mesh_quantization';
const declared = ['scene.glb', 'gltf.khr-mesh-quantization'];

// The WGIF manifest uses requires[], never requiredExtensions[].
describe('glTF extensions vs WGIF v0.1 requires[]', () => {
  it('accepts a core GLB and a declared supported extension', () => {
    expect(checkGlbExtensions(glb({}), ['scene.glb'], true)).toEqual([]);
    expect(checkGlbExtensions(glb({ extensionsUsed: [allowed], extensionsRequired: [allowed] }), declared, true)).toEqual([]);
    expect(readGlbJson(glb({}))?.asset).toEqual({ version: '2.0' });
  });
  it('rejects undeclared optional and required extensions', () => {
    expect(checkGlbExtensions(glb({ extensionsUsed: [allowed] }), ['scene.glb']))
      .toContainEqual(expect.objectContaining({ code: 'glb.extension.undeclared' }));
    expect(checkGlbExtensions(glb({ extensionsUsed: [allowed], extensionsRequired: [allowed] }), ['scene.glb']))
      .toContainEqual(expect.objectContaining({ code: 'glb.extension.undeclared' }));
  });
  it('rejects unknown extensions even when a manifest string names them', () => {
    const issues = checkGlbExtensions(glb({ extensionsUsed: ['KHR_materials_unlit'] }), ['gltf.khr-materials-unlit']);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'glb.extension.unsupported' }));
  });
  it('rejects duplicates, invalid types and extensionsRequired not used', () => {
    expect(checkGlbExtensions(glb({ extensionsUsed: [allowed, allowed] }), declared).map((x) => x.code))
      .toContain('glb.extension.duplicate');
    expect(checkGlbExtensions(glb({ extensionsUsed: 'bad' }), declared).map((x) => x.code))
      .toContain('glb.extension.invalid');
    expect(checkGlbExtensions(glb({ extensionsRequired: [allowed] }), declared).map((x) => x.code))
      .toContain('glb.extension.not-used');
  });
  it('rejects malformed GLB in release-strict mode', () => {
    expect(checkGlbExtensions(utf8('garbage'), [], true)).toContainEqual(expect.objectContaining({ code: 'glb.invalid' }));
  });
  it('integrates with the world validator without hiding hash errors', async () => {
    const fixture = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/good-minimal.wgif', import.meta.url)));
    const world = await unpackWgif(fixture);
    const scene = world.manifest.entry.scene;
    const report = await validateWorld({ ...world.manifest, requires: ['scene.glb'] }, {
      ...world.files, [scene]: glb({ extensionsUsed: [allowed] }),
    });
    expect(report.errors.map((x) => x.code)).toContain('glb.extension.undeclared');
    expect(report.errors.map((x) => x.code)).toContain('files.hash');
  });
});
