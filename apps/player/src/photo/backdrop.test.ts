import { describe, expect, it } from 'vitest';
import { buildPhotoMesh, type DepthMap } from './mesh.js';
import { computePhotoFramingAndBackdrop } from './world.js';

describe('photo framing, backdrop, and world-space-uniform cut threshold', () => {
  it('aligns floorY below bottom mesh vertices, tints backdrop from image edges, and computes median-depth pivot', () => {
    const w = 16, h = 20;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (y === 0) {
          rgba[i] = 100; rgba[i + 1] = 160; rgba[i + 2] = 240; rgba[i + 3] = 255;
        } else if (y === h - 1) {
          rgba[i] = 120; rgba[i + 1] = 110; rgba[i + 2] = 100; rgba[i + 3] = 255;
        } else {
          rgba[i] = 50; rgba[i + 1] = 50; rgba[i + 2] = 50; rgba[i + 3] = 255;
        }
      }
    }

    const positions = new Float32Array([
      -1,  1.2, -3.0,   1,  1.2, -3.0,
      -1, -1.4, -3.0,   1, -1.1, -3.0,
    ]);

    const res = computePhotoFramingAndBackdrop(rgba, w, h, positions, 2, 2, 3.0, 1.6);

    expect(res.floorY).toBeCloseTo(-1.42, 4);
    expect(res.skyColor[2]).toBeGreaterThan(res.skyColor[0]);
    expect(res.floorColor[0]).toBeGreaterThan(res.floorColor[2]);
    expect(res.pivotDistance).toBeCloseTo((3.0 * 2.6) / 1.8, 4);
  });

  it('uses a world-space-uniform relative depth jump for cuts and centres focus at median depth', () => {
    // Identical disparity step (0.22): small relative depth jump in the foreground (no tear),
    // large relative depth jump in the background (cleanly cut).
    const fgData = new Float32Array(16 * 16);
    const bgData = new Float32Array(16 * 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        fgData[y * 16 + x] = x < 8 ? 1.0 : 0.78;
        bgData[y * 16 + x] = x < 8 ? 0.22 : 0.0;
      }
    }
    const fg = buildPhotoMesh({ width: 16, height: 16, data: fgData }, { aspect: 1, detail: 16, strength: 1, edge: 'cut', cutThreshold: 0.06 });
    const bg = buildPhotoMesh({ width: 16, height: 16, data: bgData }, { aspect: 1, detail: 16, strength: 1, edge: 'cut', cutThreshold: 0.06 });
    expect(fg.cut).toBe(0);
    expect(bg.cut).toBeGreaterThan(0);

    // Median disparity of a uniform 0.5 depth map puts focus at eye.z - near*(1+k)/(1+0.5*k).
    const flatMap: DepthMap = { width: 8, height: 8, data: new Float32Array(64).fill(0.5) };
    const flat = buildPhotoMesh(flatMap, { aspect: 1, detail: 8, strength: 1, near: 3, eye: [0, 2, 0] });
    expect(flat.focus[0]).toBe(0);
    expect(flat.focus[1]).toBe(2);
    expect(flat.focus[2]).toBeCloseTo(-(3 * 2.6) / 1.8, 4);
  });
});
