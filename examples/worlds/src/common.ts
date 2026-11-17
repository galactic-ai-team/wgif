import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utf8 } from '@wgif/format';
import { encodePng } from '../../court/src/preview.js';

export const WORLDS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ASSETS = resolve(WORLDS_ROOT, 'assets');

export const asset = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(ASSETS, name)));

/** JPEG pixel size from the SOF marker (enough for the committed baseline JPEGs). */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('not a JPEG marker stream');
    const marker = bytes[i + 1]!;
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    i += 2 + len;
  }
  throw new Error('JPEG has no SOF marker');
}

export const json = (v: unknown): Uint8Array => utf8(JSON.stringify(v, null, 2) + '\n');

/**
 * The world's preview: a real render of the world committed under assets/previews/ (made by
 * scripts/capture-previews.mjs from the built player), or, before one exists, a flat placeholder
 * in the world's colours so the generator never needs a browser.
 */
export function preview(name: string, fallback: [number, number, number], accent: [number, number, number]): Uint8Array {
  const committed = resolve(ASSETS, 'previews', `${name}.png`);
  if (existsSync(committed)) return new Uint8Array(readFileSync(committed));
  const w = 320, h = 192, rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 3, band = y > h * 0.62 && y < h * 0.7;
      const c = band ? accent : fallback;
      rgb[k] = c[0]; rgb[k + 1] = c[1]; rgb[k + 2] = c[2];
    }
  }
  return encodePng(w, h, rgb);
}

export interface Credit {
  /** Path of the payload inside the .wgif that carries this work. */
  file: string;
  title: string;
  author: string;
  source: string;
  license: string;
}
