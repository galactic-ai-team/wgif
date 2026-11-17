import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { unpackWgif } from '@wgif/format';
import { exportWorld } from '../src/exporter.js';
import {
  DESKTOP_ACCEPT, PREVIEW_MAX_BYTES, SHARE_CACHE, SHARE_KEY, WGIF_MEDIA_TYPE, fitWithin, imageNameFor, isAppleMobile, looksLikeWgif, nameFromUrl, notAWorld,
  pickerAccept, pngSize, previewFits, readSrcParam,
} from '../src/opening.js';
import { describeTrust, openWorld } from '../src/world.js';
import { courtBytes, open } from './helpers.js';
import { courtVariant } from './worlds.js';

const playerRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${playerRoot}/${rel}`, 'utf8');
const AT = new Date('2026-11-16T20:00:00Z');

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 };
const IPAD_AS_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', maxTouchPoints: 5 };
const MAC = { ...IPAD_AS_MAC, maxTouchPoints: 0 };
const ANDROID = { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36', maxTouchPoints: 5 };
const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', maxTouchPoints: 0 };

/** A real, decodable RGB PNG of w x h (noise when `noisy`, so it does not compress). */
function makePng(w: number, h: number, noisy = false): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let seed = 0x9e3779b9;
  const next = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) & 0xff;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = noisy ? next() : (x + y) & 0xff;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

describe('opening from the iOS Files picker', () => {
  it('tells iPhones, iPads (even as "Mac") and Android apart from desktops', () => {
    expect(isAppleMobile(IPHONE)).toBe(true);
    expect(isAppleMobile(IPAD_AS_MAC)).toBe(true);
    expect(isAppleMobile(MAC)).toBe(false);
    expect(isAppleMobile(ANDROID)).toBe(false);
  });

  it('gives phones an unfiltered picker, so iOS does not grey out the .wgif, and keeps the filter on desktop', () => {
    expect(pickerAccept(IPHONE)).toBeNull();
    expect(pickerAccept(IPAD_AS_MAC)).toBeNull();
    expect(pickerAccept(ANDROID)).toBeNull();
    expect(pickerAccept(WINDOWS)).toBe(DESKTOP_ACCEPT);
    expect(pickerAccept(MAC)).toBe(DESKTOP_ACCEPT);
    expect(DESKTOP_ACCEPT.split(',')).toEqual(['.wgif', WGIF_MEDIA_TYPE, 'application/zip']);
  });

  it('ships the picker with no accept attribute; the script adds it on desktop only', () => {
    const input = read('index.html').match(/<input id="file"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('type="file"');
    expect(input).not.toContain('accept');
    const main = read('src/main.ts');
    expect(main).toContain('pickerAccept(navigator)');
    expect(main).toContain("fileInput.removeAttribute('accept')");
  });

  it('recognises a world by its bytes, whatever the file is called, and says what anything else is', () => {
    const court = courtBytes();
    expect(looksLikeWgif(court)).toBe(true);
    expect(notAWorld(court, 'galactic-court-edit.wgif')).toBeNull();
    expect(notAWorld(court, 'galactic-court-edit.wgif.zip')).toBeNull();
    expect(notAWorld(makePng(4, 4), 'IMG_0001.png')).toMatch(/is an image/);
    expect(notAWorld(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'IMG_0002.jpg')).toMatch(/is an image/);
    expect(notAWorld(new TextEncoder().encode('hello'), 'notes.txt')).toMatch(/not a \.wgif world/);
    expect(notAWorld(new Uint8Array(), 'empty.wgif')).toMatch(/not a \.wgif world/);
  });

  it('re-opens a file exported on the phone, picked from Files under any name', async () => {
    const { doc, runtime } = await open();
    const result = await exportWorld(doc, { ops: [{ op: 'move', id: 'ball', position: [-4, 0.12, 3] }], state: runtime.snapshot(), at: AT });
    expect(result.fileName).toBe('galactic-court-edit.wgif');
    // What Safari saved to Files is these bytes; the picker hands them back unchanged.
    const file = new File([result.bytes as Uint8Array<ArrayBuffer>], 'galactic-court-edit.wgif', { type: '' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(notAWorld(bytes, file.name)).toBeNull();
    const again = await open(bytes);
    expect(again.runtime.objects.get('ball')?.spawn).toEqual([-4, 0.12, 3]);
  });
});

describe('?src= links to a hosted .wgif', () => {
  const base = 'https://wgif-player.example/app/?x=1';
  it('accepts https and same-origin links, resolving relative ones', () => {
    expect(readSrcParam('', base)).toBeNull();
    expect(readSrcParam('?src=', base)).toBeNull();
    expect(readSrcParam('?src=https%3A%2F%2Fcdn.example%2Fw%2Fcourt.wgif', base)).toEqual({ url: new URL('https://cdn.example/w/court.wgif') });
    expect(readSrcParam('?src=samples/court.wgif', base)).toEqual({ url: new URL('https://wgif-player.example/app/samples/court.wgif') });
    expect(readSrcParam('?src=http://localhost:5173/court.wgif', base)).toEqual({ url: new URL('http://localhost:5173/court.wgif') });
  });

  it('refuses anything that is not a web download', () => {
    for (const bad of ['javascript:alert(1)', 'data:application/zip;base64,UEsDBA==', 'file:///etc/passwd', 'blob:https://x/1', 'http://evil.example/w.wgif', 'ftp://x/w.wgif']) {
      const r = readSrcParam(`?src=${encodeURIComponent(bad)}`, base);
      expect(r && 'error' in r, bad).toBe(true);
    }
  });

  it('names the world after the last path segment', () => {
    expect(nameFromUrl(new URL('https://x.example/a/My%20Court.wgif?v=2'))).toBe('My Court.wgif');
    expect(nameFromUrl(new URL('https://x.example/'))).toBe('world.wgif');
  });
});

describe('installed app: file handler and share target', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
    file_handlers: { action: string; accept: Record<string, string[]> }[];
    share_target: { action: string; method: string; enctype: string; params: { files: { name: string; accept: string[] }[] } };
  };
  it('registers .wgif as a file type the installed desktop app opens (launchQueue)', () => {
    expect(manifest.file_handlers).toEqual([expect.objectContaining({ action: './', accept: { [WGIF_MEDIA_TYPE]: ['.wgif'] } })]);
    expect(read('src/main.ts')).toContain('launchQueue?.setConsumer');
  });

  it('takes a shared .wgif on Android and the service worker hands it to the page', () => {
    expect(manifest.share_target).toMatchObject({ action: './share-target', method: 'POST', enctype: 'multipart/form-data' });
    expect(manifest.share_target.params.files[0]).toMatchObject({ name: 'world' });
    expect(manifest.share_target.params.files[0]!.accept).toEqual(expect.arrayContaining(['.wgif', WGIF_MEDIA_TYPE]));
    const sw = read('src/sw.ts');
    expect(sw).toContain("new URL('./share-target', sw.location.href).pathname");
    expect(sw).toContain("form.getAll('world')");
    expect(sw).toContain(`const SHARE_CACHE = '${SHARE_CACHE}'`);
    expect(sw).toContain(`const SHARE_KEY = '${SHARE_KEY}'`);
    // The share cache is not a versioned app cache, so activating a new worker does not wipe a pending share.
    expect(SHARE_CACHE.startsWith('wgif-player-')).toBe(false);
  });
});

describe('export with an image', () => {
  it('reads PNG sizes and holds previews to the SPEC §4 limits', () => {
    expect(pngSize(makePng(480, 288))).toEqual({ width: 480, height: 288 });
    expect(previewFits(makePng(480, 288))).toBe(true);
    expect(previewFits(makePng(513, 100))).toBe(false);
    const noisy = makePng(400, 240, true);
    expect(noisy.byteLength).toBeGreaterThan(PREVIEW_MAX_BYTES);
    expect(previewFits(noisy)).toBe(false);
    expect(previewFits(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(fitWithin(1170, 2532, 512)).toEqual({ width: 237, height: 512 });
    expect(fitWithin(300, 200, 512)).toEqual({ width: 300, height: 200 });
    expect(imageNameFor('galactic-court-edit.wgif')).toBe('galactic-court-edit.png');
    expect(imageNameFor('.wgif')).toBe('world.png');
  });

  it('puts a fresh preview of the edited world into an editable export, which validates and re-opens', async () => {
    const { doc, runtime } = await open();
    const png = makePng(480, 288);
    const result = await exportWorld(doc, { ops: [{ op: 'move', id: 'ball', position: [-4, 0.12, 3] }], state: runtime.snapshot(), at: AT, preview: png });
    expect(result.preview).toBe('refreshed');
    const out = await openWorld(result.bytes);
    expect(out.report.ok).toBe(true);
    expect(out.report.errors).toEqual([]);
    expect(out.files['preview.png']).toEqual(png);
    const entry = out.manifest.files.find((f) => f.path === 'preview.png');
    expect(entry).toMatchObject({ size: png.byteLength, mediaType: 'image/png', role: 'preview' });
    expect(out.manifest.provenance?.history?.at(-1)?.note).toMatch(/new preview image$/);
    // Strict v0.1 reader too.
    expect((await unpackWgif(result.bytes)).report.ok).toBe(true);
    // The scene itself is untouched.
    expect(out.files['world.glb']).toEqual(doc.world.files['world.glb']);
  });

  it('a signed editable world: the new preview goes in with the edit, the signature is dropped and the parent recorded', async () => {
    const { doc } = await open(await courtVariant({ sign: true }));
    const result = await exportWorld(doc, { ops: [{ op: 'move', id: 'ball', position: [0, 0.12, 0] }], at: AT, preview: makePng(320, 192) });
    expect(result.preview).toBe('refreshed');
    const out = await openWorld(result.bytes);
    expect(out.report.ok).toBe(true);
    expect(out.manifest.signature).toBeUndefined();
    expect(out.manifest.provenance?.parent?.signingHash).toBe(doc.signingHash);
    expect(describeTrust(out).label).toBe('unsigned');
  });

  it('a layered export keeps the base preview byte for byte, so the base signature still verifies', async () => {
    const { doc } = await open(await courtVariant({ mode: 'layered', sign: true }));
    const result = await exportWorld(doc, { ops: [{ op: 'remove', id: 'bleachers' }], by: 'Dee', at: AT, preview: makePng(480, 288) });
    expect(result).toMatchObject({ kind: 'layer', preview: 'layered' });
    const out = await openWorld(result.bytes);
    expect(out.report.signature).toBe('valid');
    expect(out.files['preview.png']).toEqual(doc.world.files['preview.png']);
  });

  it('keeps the original preview when the render is missing, too big, or not a PNG', async () => {
    const { doc, runtime } = await open();
    const ops = [{ op: 'move' as const, id: 'ball', position: [-4, 0.12, 3] as [number, number, number] }];
    const none = await exportWorld(doc, { ops, state: runtime.snapshot(), at: AT });
    expect(none.preview).toBe('none-given');
    const big = await exportWorld(doc, { ops, at: AT, preview: makePng(400, 240, true) });
    expect(big.preview).toBe('too-big');
    const jpeg = await exportWorld(doc, { ops, at: AT, preview: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]) });
    expect(jpeg.preview).toBe('too-big');
    for (const r of [none, big, jpeg]) expect((await openWorld(r.bytes)).files['preview.png']).toEqual(doc.world.files['preview.png']);
  });
});
