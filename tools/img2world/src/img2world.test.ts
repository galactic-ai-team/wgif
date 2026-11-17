import { describe, expect, it } from 'vitest';
import { buildWorldFromImage } from './img2world.js';

describe('img2world — synthetic depth world builder', () => {
  it('builds a valid WGIF archive with manifest and GLB from raw RGBA input', async () => {
    const width = 8;
    const height = 8;
    const imageRgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      imageRgba[idx] = (i * 15) & 255;
      imageRgba[idx + 1] = (i * 25) & 255;
      imageRgba[idx + 2] = (i * 35) & 255;
      imageRgba[idx + 3] = 255;
    }

    const result = await buildWorldFromImage({
      imageRgba,
      width,
      height,
      syntheticDepth: true,
      gridWidth: 8,
      gridHeight: 8,
    });

    // 1. Assert wgifBytes starts with ZIP signature 'PK\x03\x04'
    expect(result.wgifBytes.length).toBeGreaterThan(4);
    const zipHeader = new TextDecoder().decode(result.wgifBytes.subarray(0, 4));
    expect(zipHeader).toBe('PK\x03\x04');

    // 2. Assert archive contains manifest.json and world.glb by searching bytes
    const wgifText = new TextDecoder().decode(result.wgifBytes);
    expect(wgifText).toContain('manifest.json');
    expect(wgifText).toContain('world.glb');

    // 3. Assert glbBytes starts with 'glTF'
    expect(result.glbBytes.length).toBeGreaterThan(4);
    const glbHeader = new TextDecoder().decode(result.glbBytes.subarray(0, 4));
    expect(glbHeader).toBe('glTF');

    // 4. Assert depthMap length > 0
    expect(result.depthMap).toBeInstanceOf(Float32Array);
    expect(result.depthMap.length).toBeGreaterThan(0);
  });

  it('stores preview assets with method 0 (STORED) and scene glb with method 8 (DEFLATED)', async () => {
    const width = 8;
    const height = 8;
    const imageRgba = new Uint8Array(width * height * 4).fill(128);

    const result = await buildWorldFromImage({
      imageRgba,
      width,
      height,
      syntheticDepth: true,
      gridWidth: 8,
      gridHeight: 8,
    });

    const zipBytes = result.wgifBytes;
    const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    let offset = 0;
    const methods: Record<string, number> = {};

    while (offset + 30 <= zipBytes.byteLength) {
      const sig = dv.getUint32(offset, true);
      if (sig !== 0x04034b50) break; // Not a local file header signature

      const compressionMethod = dv.getUint16(offset + 8, true);
      const compressedSize = dv.getUint32(offset + 18, true);
      const nameLen = dv.getUint16(offset + 26, true);
      const extraLen = dv.getUint16(offset + 28, true);

      const nameBytes = zipBytes.subarray(offset + 30, offset + 30 + nameLen);
      const fileName = new TextDecoder().decode(nameBytes);

      methods[fileName] = compressionMethod;

      offset += 30 + nameLen + extraLen + compressedSize;
    }

    // manifest.json and preview.gif should be STORED (method 0)
    expect(methods['manifest.json']).toBe(0);
    expect(methods['preview.gif']).toBe(0);

    // scene/world.glb should be DEFLATED (method 8)
    expect(methods['scene/world.glb']).toBe(8);
  });
});
