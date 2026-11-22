import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readGlbJson, unpackWgif, validateWorld } from '@wgif/format';
import { encodeAnimatedGif89a, encodeDeterministicPng } from '../../../examples/court/src/prng.js';
import { decodeGif, isGif, lzwDecode } from '../src/photo/gif.js';
import { buildPhotoMesh, normalizeDepth, sampleDepth, syntheticDepth, type DepthMap } from '../src/photo/mesh.js';
import { writeGlb } from '../src/photo/glb.js';
import { atlasLayout, buildPhotoWorld, BUDGET, medianFrame, resize, type ImageCodec, type Picture } from '../src/photo/world.js';
import { parseInteractions } from '../src/interactions.js';
import { open, run } from './helpers.js';

const g = globalThis as unknown as Record<string, unknown>;
g.self ??= globalThis;
g.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

/** Tests have no canvas: every image is stored as PNG. */
const pngCodec: ImageCodec = {
  encode: async (p) => ({ bytes: encodeDeterministicPng(p.width, p.height, new Uint8Array(p.rgba.buffer, p.rgba.byteOffset, p.rgba.byteLength)), mimeType: 'image/png' }),
};

/** A test picture: a bright square (near, per its depth) on a dark gradient. */
function picture(w = 96, h = 64): Picture {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, inside = x > w * 0.35 && x < w * 0.65 && y > h * 0.3 && y < h * 0.7;
    rgba[o] = inside ? 240 : (x * 2) & 255;
    rgba[o + 1] = inside ? 200 : (y * 3) & 255;
    rgba[o + 2] = inside ? 40 : 90;
    rgba[o + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

/** A depth map with a raised square in the middle (a hard edge). */
function stepDepth(w = 64, h = 48): DepthMap {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x > w * 0.35 && x < w * 0.65 && y > h * 0.3 && y < h * 0.7 ? 1 : 0.1;
  return { width: w, height: h, data };
}

describe('GIF decoding', () => {
  const palette = new Uint8Array(192);
  for (let i = 0; i < 64; i++) palette.set([i * 4, 255 - i * 4, (i * 37) & 255], i * 3);
  const frames = Array.from({ length: 5 }, (_, f) => {
    const px = new Uint8Array(20 * 12);
    for (let i = 0; i < px.length; i++) px[i] = (i + f * 7) % 64;
    return px;
  });
  const gif = encodeAnimatedGif89a(20, 12, palette, frames, 8);

  it('decodes every frame to the exact palette colours and delays', () => {
    expect(isGif(gif)).toBe(true);
    const d = decodeGif(gif);
    expect([d.width, d.height, d.frames.length, d.sourceFrames]).toEqual([20, 12, 5, 5]);
    for (let f = 0; f < 5; f++) {
      const fr = d.frames[f]!;
      expect(fr.delayMs).toBe(80);
      for (const i of [0, 17, 119, 239]) {
        const ci = frames[f]![i]!;
        expect(Array.from(fr.rgba.subarray(i * 4, i * 4 + 4))).toEqual([palette[ci * 3], palette[ci * 3 + 1], palette[ci * 3 + 2], 255]);
      }
    }
  });

  it('samples long GIFs evenly and keeps the loop length', () => {
    const long = encodeAnimatedGif89a(20, 12, palette, Array.from({ length: 30 }, (_, i) => frames[i % 5]!), 5);
    const d = decodeGif(long, { maxFrames: 8 });
    expect(d.sourceFrames).toBe(30);
    expect(d.frames.length).toBeLessThanOrEqual(8);
    expect(d.frames.reduce((s, f) => s + f.delayMs, 0)).toBe(30 * 50);
  });

  it('treats near-zero delays as 100 ms, like browsers', () => {
    const fast = encodeAnimatedGif89a(20, 12, palette, frames.slice(0, 2), 0);
    expect(decodeGif(fast).frames.map((f) => f.delayMs)).toEqual([100, 100]);
  });

  it('LZW handles the KwKwK case (a run of one colour)', () => {
    const run1 = new Uint8Array(20 * 12).fill(3);
    const d = decodeGif(encodeAnimatedGif89a(20, 12, palette, [run1, run1]));
    expect(d.frames[0]!.rgba.subarray(0, 4)).toEqual(new Uint8ClampedArray([12, 243, 111, 255]));
    expect(d.frames[1]!.rgba.subarray(239 * 4, 240 * 4)).toEqual(new Uint8ClampedArray([12, 243, 111, 255]));
    expect(lzwDecode(new Uint8Array(0), 2, 4)).toEqual(new Uint8Array(4));
  });

  it('refuses what is not a GIF, and oversized ones', () => {
    expect(() => decodeGif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a GIF/);
    expect(() => decodeGif(gif, { maxPixels: 100 })).toThrow(/too big/);
    expect(() => decodeGif(gif.subarray(0, 40))).toThrow();
  });
});

describe('depth to mesh', () => {
  it('normalises raw model output robustly (1 = near)', () => {
    const raw = Array.from({ length: 100 }, (_, i) => i);
    raw[0] = -1e6; // a hot pixel does not flatten the rest
    const d = normalizeDepth(raw, 10, 10);
    expect(d.data[99]).toBe(1);
    expect(d.data[0]).toBe(0);
    expect(d.data[50]).toBeGreaterThan(0.4);
    expect(d.data[50]).toBeLessThan(0.6);
    expect(normalizeDepth([5, 5, 5, 5], 2, 2).data[0]).toBe(0.5);
    expect(sampleDepth({ width: 2, height: 1, data: new Float32Array([0, 1]) }, 0.5, 0)).toBeCloseTo(0.5);
  });

  it('displaces vertices by depth: near parts come forward, z varies', () => {
    const m = buildPhotoMesh(stepDepth(), { aspect: 1.5, detail: 48, strength: 1, eye: [0, 2, 0] });
    const z = m.surface.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...z) - Math.min(...z)).toBeGreaterThan(2);
    // Centre vertex (on the raised square) is nearer the eye than a corner.
    const centre = Math.floor(m.rows / 2) * (m.cols + 1) + Math.floor(m.cols / 2);
    expect(m.surface.positions[centre * 3 + 2]!).toBeGreaterThan(m.surface.positions[2]!);
    // Every vertex sits on the eye's ray through its pixel: the picture looks unchanged from there.
    for (const v of [0, centre, m.surface.positions.length / 3 - 1]) {
      const x = m.surface.positions[v * 3]!, y = m.surface.positions[v * 3 + 1]! - 2, zz = -m.surface.positions[v * 3 + 2]!;
      const u = m.surface.uvs[v * 2]!, t = m.surface.uvs[v * 2 + 1]!;
      expect(x / zz).toBeCloseTo((u * 2 - 1) * Math.tan((25 * Math.PI) / 180) * 1.5, 5);
      expect(y / zz).toBeCloseTo((1 - t * 2) * Math.tan((25 * Math.PI) / 180), 5);
    }
    expect(m.focus[2]).toBeLessThan(-3);
    expect(m.back).not.toBeNull();
    expect(m.back!.min[2]).toBeLessThan(m.surface.min[2]);
  });

  it('cuts the rubber sheet at depth edges; smooth mode keeps every triangle', () => {
    const cut = buildPhotoMesh(stepDepth(), { aspect: 1.5, detail: 48, edge: 'cut' });
    const smooth = buildPhotoMesh(stepDepth(), { aspect: 1.5, detail: 48, edge: 'smooth' });
    const full = cut.cols * cut.rows * 2;
    expect(cut.cut).toBeGreaterThan(20);
    expect(cut.surface.indices.length / 3).toBe(full - cut.cut);
    expect(smooth.cut).toBe(0);
    expect(smooth.surface.indices.length / 3).toBe(full);
  });

  it('strength 0 is a flat picture with no back plate', () => {
    const m = buildPhotoMesh(stepDepth(), { aspect: 1, detail: 16, strength: 0 });
    const z = m.surface.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...z) - Math.min(...z)).toBeLessThan(1e-6);
    expect(m.back).toBeNull();
    expect(m.cut).toBe(0);
  });

  it('normals are unit length and face the eye; bounds match the data', () => {
    const m = buildPhotoMesh(syntheticDepth(picture().rgba, 96, 64), { aspect: 1.5, detail: 32 });
    const n = m.surface.normals;
    let facing = 0;
    for (let i = 0; i < n.length; i += 3) {
      expect(Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!)).toBeCloseTo(1, 4);
      if (n[i + 2]! > 0) facing++;
    }
    expect(facing / (n.length / 3)).toBeGreaterThan(0.95);
    const p = m.surface.positions;
    for (let k = 0; k < 3; k++) {
      const axis = p.filter((_, i) => i % 3 === k);
      expect(m.surface.min[k]).toBe(Math.min(...axis));
      expect(m.surface.max[k]).toBe(Math.max(...axis));
    }
  });
});

describe('GLB writer', () => {
  it('writes a valid glTF 2.0 binary with no extensions', () => {
    const m = buildPhotoMesh(stepDepth(), { aspect: 1, detail: 8 });
    const png = encodeDeterministicPng(2, 2, new Uint8Array(16).fill(200));
    const glb = writeGlb([{ name: 'photo', mesh: m.surface, material: 0, extras: { wgif: { collider: 'static' } } }], [{ name: 'p', color: [1, 1, 1, 1], glow: 0 }], [{ bytes: png, mimeType: 'image/png' }], 'test');
    const dv = new DataView(glb.buffer);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(8, true)).toBe(glb.length);
    expect(glb.length % 4).toBe(0);
    const json = readGlbJson(glb) as Record<string, unknown> & { accessors: { count: number }[]; materials: Record<string, unknown>[]; buffers: { byteLength: number }[] };
    expect(json.extensionsUsed).toBeUndefined();
    expect(json.accessors[0]!.count).toBe(m.surface.positions.length / 3);
    expect(json.materials[0]!.emissiveTexture).toEqual({ index: 0 });
    expect(dv.getUint32(20 + dv.getUint32(12, true), true)).toBe(json.buffers[0]!.byteLength);
  });
});

describe('the photo world export', () => {
  it('a picture becomes a valid 3D .wgif inside the budgets that the player re-opens', async () => {
    const pic = picture();
    const w = await buildPhotoWorld({ frames: [pic], depth: stepDepth(), mode: '3d', sourceName: 'test.png', created: '2026-11-22T00:00:00Z', depthInfo: { model: 'onnx-community/depth-anything-v2-small', revision: 'abc', license: 'Apache-2.0', backend: 'wasm', inputSize: [392, 266], ms: 1 } }, pngCodec);
    expect(w.bytes.length).toBeLessThanOrEqual(BUDGET.total);
    expect(w.sizes['world.glb']!).toBeLessThanOrEqual(BUDGET.glb);
    expect(w.sizes['assets/depth.png']).toBeGreaterThan(0);
    expect(w.cut).toBeGreaterThan(0);
    const world = await unpackWgif(w.bytes);
    const report = await validateWorld(world.manifest, world.files);
    expect(report.errors).toEqual([]);
    expect(JSON.stringify(world.manifest.extensions)).toContain('Apache-2.0');
    const opened = await open(w.bytes);
    expect(opened.doc.warnings).toEqual([]);
    expect(opened.built.warnings).toEqual([]);
    const photo = opened.doc.interactions.photos[0]!;
    expect(photo.node).toBe('photo');
    expect(photo.frames).toBeNull();
    // The mesh in the opened scene really is displaced.
    const node = opened.scene.getObjectByName('photo') as unknown as { geometry: { attributes: { position: { array: Float32Array } } } };
    const z = Array.from(node.geometry.attributes.position.array).filter((_, i) => i % 3 === 2);
    expect(Math.max(...z) - Math.min(...z)).toBeGreaterThan(1);
    // The walker stands on the floor, which now sits just below the bottom of the picture mesh.
    const ys = (name: string): number[] => {
      const g = opened.scene.getObjectByName(name) as unknown as { geometry: { attributes: { position: { array: Float32Array } } } };
      return Array.from(g.geometry.attributes.position.array).filter((_, i) => i % 3 === 1);
    };
    const floorY = Math.min(...ys('floor'));
    expect(floorY).toBeCloseTo(Math.min(...ys('photo')) - 0.02, 2);
    run(opened.runtime, 1);
    expect(opened.runtime.player.feet[1]).toBeGreaterThan(floorY - 0.05);
    expect(opened.runtime.player.feet[1]).toBeLessThan(floorY + 0.3);
  });

  it('never puts the floor above any part of the picture (near object across the bottom, far ground above it)', async () => {
    const w = 64, h = 48, data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = y > h * 0.85 ? 1 : 0.1;
    const made = await buildPhotoWorld({ frames: [picture()], depth: { width: w, height: h, data }, mode: '3d', sourceName: 'table.png', created: '2026-11-22T00:00:00Z' }, pngCodec);
    const opened = await open(made.bytes);
    const ys = (name: string): number[] => {
      const g = opened.scene.getObjectByName(name) as unknown as { geometry: { attributes: { position: { array: Float32Array } } } };
      return Array.from(g.geometry.attributes.position.array).filter((_, i) => i % 3 === 1);
    };
    expect(Math.max(...ys('floor'))).toBeLessThan(Math.min(...ys('photo')));
  });

  it('a GIF becomes an animated world with a frame sheet; the flat mode is a room', async () => {
    const frames = [0, 1, 2, 3, 4, 5].map((k) => {
      const p = picture(60, 40);
      for (let i = 0; i < p.rgba.length; i += 4) p.rgba[i] = (p.rgba[i]! + k * 40) & 255;
      return p;
    });
    for (const mode of ['3d', 'flat'] as const) {
      const w = await buildPhotoWorld({ frames, delaysMs: [100, 100, 100, 100, 100, 200], depth: syntheticDepth(frames[0]!.rgba, 60, 40), mode, sourceName: 'anim.gif' }, pngCodec);
      const world = await unpackWgif(w.bytes);
      expect((await validateWorld(world.manifest, world.files)).errors).toEqual([]);
      const { interactions, warnings } = parseInteractions(JSON.parse(new TextDecoder().decode(world.files['interactions.json']!)));
      expect(warnings).toEqual([]);
      const f = interactions.photos[0]!.frames!;
      expect(f.count).toBe(6);
      expect(f.columns * f.rows).toBeGreaterThanOrEqual(6);
      expect(f.delaysMs[5]).toBe(200);
      expect(world.files[f.file]).toBeDefined();
      expect(world.files['assets/depth.png'] !== undefined).toBe(mode === '3d');
      const opened = await open(w.bytes);
      expect(opened.doc.warnings).toEqual([]);
      run(opened.runtime, 1);
      expect(opened.runtime.player.feet[1]).toBeGreaterThan(-0.05);
    }
  });

  it('a big photo is shrunk to fit the budget', async () => {
    const big = resize(picture(), 2400, 1600);
    // Noise defeats PNG compression: the worst case for size.
    for (let i = 0; i < big.rgba.length; i += 4) big.rgba[i + 2] = (i * 2654435761) >>> 24;
    const w = await buildPhotoWorld({ frames: [big], depth: stepDepth(), mode: '3d' }, pngCodec);
    expect(w.bytes.length).toBeLessThanOrEqual(BUDGET.total);
    expect(w.sizes['world.glb']!).toBeLessThanOrEqual(BUDGET.glb);
  });

  it('the still background of a GIF drops what moves', () => {
    const frames = [0, 1, 2, 3, 4].map((k) => {
      const p = { width: 5, height: 1, rgba: new Uint8ClampedArray(20).fill(10) };
      p.rgba.fill(250, k * 4, k * 4 + 4); // a bright dot moving along the row
      return p;
    });
    expect(Array.from(medianFrame(frames).rgba)).toEqual(new Array(20).fill(10));
    expect(medianFrame(frames.slice(0, 1))).toBe(frames[0]);
  });

  it('lays GIF frames out on a near-square sheet within 2048 px', () => {
    const l = atlasLayout(48, 16 / 9, 320);
    expect(l.columns * l.rows).toBeGreaterThanOrEqual(48);
    expect(l.columns * l.cw).toBeLessThanOrEqual(2048);
    expect(l.rows * l.ch).toBeLessThanOrEqual(2048);
  });

  it('parses the photo entry defensively', () => {
    const bad = parseInteractions({ version: '0.1', interactions: [{ type: 'photo', id: 'p' }, { type: 'photo', id: 'q', node: 'n', focus: [0, 1, 2], frames: { file: '../x.jpg', count: 3 } }] });
    expect(bad.interactions.photos.length).toBe(1);
    expect(bad.interactions.photos[0]!.frames).toBeNull();
    expect(bad.warnings.length).toBe(2);
  });
});

describe('the committed example picture worlds', () => {
  it.each(['street-3d', 'bounce-3d'])('%s opens with no warnings, displaced, inside the budgets', async (name) => {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../examples/photo/${name}.wgif`, import.meta.url))));
    expect(bytes.length).toBeLessThanOrEqual(BUDGET.total);
    const w = await open(bytes);
    expect(w.doc.warnings).toEqual([]);
    expect(w.built.warnings).toEqual([]);
    const photo = w.doc.interactions.photos[0]!;
    expect(photo.frames !== null).toBe(name === 'bounce-3d');
    expect(w.doc.world.files['assets/depth.png']).toBeDefined();
    expect(JSON.stringify(w.doc.world.manifest.provenance)).toContain('depth-anything-v2-small');
    const mesh = w.scene.getObjectByName('photo') as unknown as { geometry: { attributes: { position: { array: Float32Array } } } };
    const z = Array.from(mesh.geometry.attributes.position.array).filter((_, i) => i % 3 === 2);
    expect(Math.max(...z) - Math.min(...z)).toBeGreaterThan(1);
  });
});
