// One-time generator for the PWA icons: node scripts/gen-pwa-icons.mjs
// Writes public/icons/icon-192.png and icon-512.png — dark background with
// a violet disc and a white ring, echoing the rebounder marker. Pure Node
// (zlib is built in); no image dependency, so the icons stay reproducible.
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BG = [11, 13, 23, 255];
const DISC = [139, 92, 246, 255];
const RING = [255, 255, 255, 255];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function draw(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size * 2 - 1;
      const ny = (y + 0.5) / size * 2 - 1;
      const r = Math.hypot(nx, ny);
      // Violet disc, soft edge; a white ring at 0.62 radius reads as a ball.
      const disc = 1 - smooth(0.76, 0.8, r);
      const ring = smooth(0.585, 0.6, r) * (1 - smooth(0.64, 0.655, r));
      const shade = 1 - 0.22 * Math.min(1, r / 0.78);
      const px = [
        BG[0] * (1 - disc) + DISC[0] * shade * disc * (1 - ring) + RING[0] * ring,
        BG[1] * (1 - disc) + DISC[1] * shade * disc * (1 - ring) + RING[1] * ring,
        BG[2] * (1 - disc) + DISC[2] * shade * disc * (1 - ring) + RING[2] * ring,
        255,
      ];
      const off = y * (1 + size * 4) + 1 + x * 4;
      raw[off] = Math.round(px[0]);
      raw[off + 1] = Math.round(px[1]);
      raw[off + 2] = Math.round(px[2]);
      raw[off + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = resolve(outDir, `icon-${size}.png`);
  writeFileSync(file, draw(size));
  console.log(`wrote ${file}`);
}
