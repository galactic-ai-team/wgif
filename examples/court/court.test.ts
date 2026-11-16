import { describe, expect, it } from 'vitest';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { buildReproducibleCourtArtifacts } from './src/pack-court.js';
import { zlibCompressDeterministic } from './src/prng.js';
import { buildWorldFromImage } from '../../tools/img2world/src/img2world.js';

describe('Phase 1 World Generation — Court Polish, Spec v0.1 Alignment & Browser-Safe PRNG', () => {
  it('compresses deterministically with browser-safe zlib and round-trips via standard inflate', () => {
    const sample = new TextEncoder().encode(
      'WGIF-court-plank-repeat-pattern-WGIF-court-plank-repeat-pattern-1234567890'
    );
    const compressed = zlibCompressDeterministic(sample);
    const decompressed = new Uint8Array(inflateSync(compressed));
    expect(Buffer.compare(sample, decompressed)).toBe(0);
  });

  it('rebuilds byte-for-byte identical court.wgif archives across runs', () => {
    const run1 = buildReproducibleCourtArtifacts();
    const run2 = buildReproducibleCourtArtifacts();

    expect(run1.sha256Scene).toBe(run2.sha256Scene);
    expect(run1.sha256Preview).toBe(run2.sha256Preview);
    expect(run1.sha256Wgif).toBe(run2.sha256Wgif);
    expect(Buffer.compare(run1.wgifBytes, run2.wgifBytes)).toBe(0);
    // Verify valid PK\x03\x04 ZIP magic
    const dv = new DataView(
      run1.wgifBytes.buffer,
      run1.wgifBytes.byteOffset,
      run1.wgifBytes.byteLength
    );
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
  });

  it('aligns manifest with GPT-6 Spec v0.1 (wgif_version: "0.1", entrypoints.scene & entrypoints.preview)', () => {
    const { manifest } = buildReproducibleCourtArtifacts();
    expect(manifest.wgif_version).toBe('0.1');
    expect(manifest.entrypoints).toEqual({
      scene: 'scene/court.glb',
      preview: 'preview.gif',
    });
  });

  it('meets Spec 5.2 constraints on preview.gif (<= 512 px, <= 256 KB, valid GIF89a)', () => {
    const { previewGif } = buildReproducibleCourtArtifacts();
    const header = new TextDecoder().decode(previewGif.subarray(0, 6));
    expect(header).toBe('GIF89a');

    const view = new DataView(
      previewGif.buffer,
      previewGif.byteOffset,
      previewGif.byteLength
    );
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);

    expect(width).toBeLessThanOrEqual(512);
    expect(height).toBeLessThanOrEqual(512);
    expect(previewGif.byteLength).toBeLessThanOrEqual(256 * 1024);
  });

  it('includes hardwood texture, rim nets, arena walls, and stadium lights in court.glb', () => {
    const { sceneGlb } = buildReproducibleCourtArtifacts();
    const view = new DataView(
      sceneGlb.buffer,
      sceneGlb.byteOffset,
      sceneGlb.byteLength
    );
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    const jsonLen = view.getUint32(12, true);
    const jsonText = new TextDecoder().decode(sceneGlb.subarray(20, 20 + jsonLen));
    const gltf = JSON.parse(jsonText);

    expect(gltf.images.length).toBeGreaterThanOrEqual(1);
    expect(gltf.materials.map((m: { name: string }) => m.name)).toEqual(
      expect.arrayContaining([
        'HardwoodCourt',
        'ArenaWallSlate',
        'RimOrange',
        'NetCordWhite',
        'StadiumLightEmissive',
      ])
    );
    expect(gltf.meshes[0].primitives.length).toBe(20);
  });

  it('generates a displaced 3D world .wgif and Spec v0.1 provenance from a single RGB image offline', async () => {
    const w = 32;
    const h = 24;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = (i * 7) & 255;
      rgba[i * 4 + 1] = (i * 13) & 255;
      rgba[i * 4 + 2] = (i * 29) & 255;
      rgba[i * 4 + 3] = 255;
    }

    const res = await buildWorldFromImage({
      imageRgba: rgba,
      width: w,
      height: h,
      gridWidth: 16,
      gridHeight: 12,
      syntheticDepth: true,
    });

    expect(res.wgifBytes.byteLength).toBeGreaterThan(200);
    expect(res.manifest.wgif_version).toBe('0.1');
    expect(res.manifest.entrypoints).toEqual({
      scene: 'scene/world.glb',
      preview: 'preview.gif',
    });
    expect(res.manifest.provenance.origin).toBe('image-to-world');
    expect(Array.isArray(res.manifest.provenance.source_inputs)).toBe(true);
    // Ensure first ZIP entry ('manifest.json') inflates cleanly
    const dv = new DataView(
      res.wgifBytes.buffer,
      res.wgifBytes.byteOffset,
      res.wgifBytes.byteLength
    );
    const method = dv.getUint16(8, true);
    const compSize = dv.getUint32(18, true);
    const nameLen = dv.getUint16(26, true);
    const payload = res.wgifBytes.subarray(30 + nameLen, 30 + nameLen + compSize);
    const manifestRaw =
      method === 8 ? new Uint8Array(inflateRawSync(payload)) : payload;
    const parsed = JSON.parse(new TextDecoder().decode(manifestRaw));
    expect(parsed.wgif_version).toBe('0.1');
  });
});