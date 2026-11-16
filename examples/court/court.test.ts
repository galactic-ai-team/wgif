import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildReproducibleCourtArtifacts } from './src/pack-court.js';
import { zlibCompressDeterministic } from './src/prng.js';
import { buildWorldFromImage } from '../../tools/img2world/src/img2world.js';

function inspectFirstZipEntry(zipBytes: Uint8Array): {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  payload: Uint8Array;
} {
  const dv = new DataView(
    zipBytes.buffer,
    zipBytes.byteOffset,
    zipBytes.byteLength
  );
  expect(dv.getUint32(0, true)).toBe(0x04034b50); // PK\x03\x04
  const method = dv.getUint16(8, true);
  const compressedSize = dv.getUint32(18, true);
  const uncompressedSize = dv.getUint32(22, true);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const name = new TextDecoder().decode(zipBytes.subarray(30, 30 + nameLen));
  const payloadStart = 30 + nameLen + extraLen;
  const payload = zipBytes.subarray(payloadStart, payloadStart + compressedSize);
  return { name, method, compressedSize, uncompressedSize, payload };
}

describe('Phase 1 World Generation — RC1 Validator Alignment', () => {
  it('compresses deterministically with browser-safe zlib and round-trips via standard inflate', () => {
    const sample = new TextEncoder().encode(
      'WGIF-court-plank-repeat-pattern-WGIF-court-plank-repeat-pattern-1234567890'
    );
    const compressed = zlibCompressDeterministic(sample);
    const decompressed = new Uint8Array(inflateSync(compressed));
    expect(Buffer.compare(sample, decompressed)).toBe(0);
  });

  it('rebuilds byte-for-byte identical court.gen.wgif archives across runs', () => {
    const run1 = buildReproducibleCourtArtifacts();
    const run2 = buildReproducibleCourtArtifacts();

    expect(run1.sha256Scene).toBe(run2.sha256Scene);
    expect(run1.sha256Preview).toBe(run2.sha256Preview);
    expect(run1.sha256Wgif).toBe(run2.sha256Wgif);
    expect(Buffer.compare(run1.wgifBytes, run2.wgifBytes)).toBe(0);
  });

  it('emits RC1 manifest fields (wgif, id, title, creator, created, mode, entry, files) and stores manifest.json FIRST with method=0 (STORED)', () => {
    const { manifest, wgifBytes } = buildReproducibleCourtArtifacts();

    expect(manifest.wgif).toBe('0.1');
    expect(typeof manifest.id).toBe('string');
    expect(typeof manifest.title).toBe('string');
    expect(typeof manifest.creator).toBe('string');
    expect(manifest.created).toBe('2026-01-01T00:00:00.000Z');
    expect(manifest.mode).toBe('walk');
    expect(manifest.entry).toEqual({
      scene: 'scene/court.glb',
      preview: 'preview.gif',
    });
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.map((f) => f.path)).toEqual([
      'preview.gif',
      'scene/court.glb',
    ]);

    // Verify first ZIP entry is manifest.json and STORED (method === 0)
    const first = inspectFirstZipEntry(wgifBytes);
    expect(first.name).toBe('manifest.json');
    expect(first.method).toBe(0);
    expect(first.compressedSize).toBe(first.uncompressedSize);

    const parsed = JSON.parse(new TextDecoder().decode(first.payload));
    expect(parsed.wgif).toBe('0.1');
    expect(parsed.entry.scene).toBe('scene/court.glb');
    expect(parsed.entry.preview).toBe('preview.gif');
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

  it('generates a displaced 3D world .wgif from a single RGB image with RC1 manifest STORED first', async () => {
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

    expect(res.manifest.wgif).toBe('0.1');
    expect(res.manifest.mode).toBe('orbit');
    expect(res.manifest.entry).toEqual({
      scene: 'scene/world.glb',
      preview: 'preview.gif',
    });
    expect(res.manifest.files.length).toBe(2);

    const first = inspectFirstZipEntry(res.wgifBytes);
    expect(first.name).toBe('manifest.json');
    expect(first.method).toBe(0);

    const parsed = JSON.parse(new TextDecoder().decode(first.payload));
    expect(parsed.wgif).toBe('0.1');
    expect(parsed.creator).toContain('@wgif/img2world');
    expect(parsed.provenance.origin).toBe('image-to-world');
  });
});