import { describe, expect, it } from 'vitest';
import { buildReproducibleCourtArtifacts } from './src/pack-court.js';
import { buildWorldFromImage } from '../../tools/img2world/src/img2world.js';

describe('Phase 1 World Generation — Court Polish & img2world', () => {
  it('rebuilds byte-for-byte identical court artifacts across runs', () => {
    const run1 = buildReproducibleCourtArtifacts();
    const run2 = buildReproducibleCourtArtifacts();

    expect(run1.sha256Scene).toBe(run2.sha256Scene);
    expect(run1.sha256Preview).toBe(run2.sha256Preview);
    expect(Buffer.compare(run1.sceneGlb, run2.sceneGlb)).toBe(0);
    expect(Buffer.compare(run1.previewGif, run2.previewGif)).toBe(0);
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
    const view = new DataView(sceneGlb.buffer, sceneGlb.byteOffset, sceneGlb.byteLength);
    expect(view.getUint32(0, true)).toBe(0x46546c67); // 'glTF' magic
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
    // 18 primitives: floor + 4 walls + 3 trusses + 4 lights + 2 stanchions + 2 backboards + 2*(rim+net)
    expect(gltf.meshes[0].primitives.length).toBe(20);
  });

  it('generates a displaced 3D world and valid provenance from a single RGB image offline', async () => {
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

    expect(res.glbBytes.byteLength).toBeGreaterThan(200);
    expect(res.previewGifBytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    const prov = res.manifest.provenance as Record<string, unknown>;
    expect(prov.origin).toBe('image-to-world');
    expect(Array.isArray(prov.source_inputs)).toBe(true);
  });
});
