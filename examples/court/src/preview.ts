import { crc32 } from 'node:zlib';
import { zlibSync } from 'fflate';
import { COURT, rimCenter } from './court.js';

/** Minimal RGB PNG encoder (no dependencies beyond node:zlib). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 9 })), // pure-JS deflate: identical bytes on every machine
    chunk('IEND', new Uint8Array()),
  ]);
  return new Uint8Array(png);
}

/** Top-down illustration of the court, used as the static preview (SPEC §3: preview for non-WGIF platforms). */
export function renderPreviewPng(width = 320, height = 192): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const L = COURT.length, W = COURT.width;
  const scale = Math.min(width / (L + 4), height / (W + 3));
  const t = Math.max(1.2 / scale, COURT.line * 1.5); // at least ~1px wide lines
  const near = (v: number, target: number) => Math.abs(v - target) <= t / 2;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const x = (px + 0.5 - width / 2) / scale;
      const z = (py + 0.5 - height / 2) / scale;
      let c: [number, number, number] = [30, 52, 115]; // apron
      const inCourt = Math.abs(x) <= L / 2 && Math.abs(z) <= W / 2;
      if (inCourt) {
        const grain = ((Math.floor((z + 20) * 3) % 2) * 10);
        c = [199 - grain, 140 - grain, 82 - grain];
        const side = x >= 0 ? 1 : -1;
        const fromBase = L / 2 - Math.abs(x);
        if (fromBase <= 5.8 && Math.abs(z) <= 2.45) c = [178, 46, 31];
        const [rx] = rimCenter(side as 1 | -1);
        const sign = side;
        const baseLineX = rx + sign * 1.2;
        const hashOffsets = [1.75, 2.65, 3.55, 4.45];
        let onHash = false;
        if (Math.abs(z) >= 2.45 && Math.abs(z) <= 2.90) {
          for (let hi = 0; hi < hashOffsets.length; hi++) {
            const hx = baseLineX - sign * hashOffsets[hi]!;
            const tickW = hi === 0 ? 0.18 : 0.08;
            if (Math.abs(x - hx) <= tickW / 2) {
              onHash = true;
              break;
            }
          }
        }
        const d3 = Math.hypot(x - rx, z);
        const onArc = Math.abs(z) <= 6.6 ? near(d3, 6.75) && Math.abs(x) < Math.abs(rx) : near(Math.abs(z), 6.6) && fromBase <= 3;
        const onKey = (fromBase <= 5.8 && near(Math.abs(z), 2.45)) || (near(fromBase, 5.8) && Math.abs(z) <= 2.45);
        const onCircle = near(Math.hypot(x, z), 1.8) || (near(Math.hypot(Math.abs(x) - (L / 2 - 5.8), z), 1.8) && fromBase > 5.8);
        const onBoundary = near(Math.abs(x), L / 2) || near(Math.abs(z), W / 2) || near(x, 0);
        if (onArc || onKey || onCircle || onBoundary || onHash) c = [245, 245, 245];
        if (near(Math.hypot(x - rx, z), COURT.rimRadius * 2)) c = [255, 96, 16];
      } else if (Math.abs(z) > W / 2 + 2.5) {
        c = [70, 74, 86]; // bleachers
      }
      rgb.set(c, (py * width + px) * 3);
    }
  }
  return encodePng(width, height, rgb);
}
