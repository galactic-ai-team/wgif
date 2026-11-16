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
});
