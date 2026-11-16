/**
 * Minimal, zero-dependency RFC 2083 PNG decoder for 8-bit RGB (colorType 2),
 * 8-bit Grayscale (colorType 0), and 8-bit RGBA (colorType 6) non-interlaced PNGs.
 * Supports all 5 PNG scanline filters (0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth).
 */
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePngToRgba(pngBytes: Uint8Array): DecodedPng {
  if (pngBytes.byteLength < 33) {
    throw new Error('Invalid PNG: buffer too short');
  }
  for (let i = 0; i < 8; i++) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error('Invalid PNG signature');
    }
  }

  const dv = new DataView(
    pngBytes.buffer,
    pngBytes.byteOffset,
    pngBytes.byteLength
  );

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= pngBytes.byteLength) {
    const length = dv.getUint32(offset, false);
    const type = String.fromCharCode(
      pngBytes[offset + 4]!,
      pngBytes[offset + 5]!,
      pngBytes[offset + 6]!,
      pngBytes[offset + 7]!
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > pngBytes.byteLength) {
      throw new Error(`Invalid PNG chunk length for ${type}`);
    }

    if (type === 'IHDR') {
      width = dv.getUint32(dataStart, false);
      height = dv.getUint32(dataStart + 4, false);
      bitDepth = pngBytes[dataStart + 8]!;
      colorType = pngBytes[dataStart + 9]!;
      interlace = pngBytes[dataStart + 12]!;
    } else if (type === 'IDAT') {
      idatChunks.push(pngBytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip 4-byte CRC
  }

  if (width <= 0 || height <= 0) {
    throw new Error('Invalid PNG dimensions');
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(
      `Unsupported PNG format: bitDepth=${bitDepth}, interlace=${interlace} (expected 8-bit non-interlaced)`
    );
  }

  const bpp =
    colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (bpp === 0) {
    throw new Error(`Unsupported PNG colorType=${colorType} (expected 0, 2, or 6)`);
  }

  let totalIdat = 0;
  for (const c of idatChunks) totalIdat += c.byteLength;
  const compressed = new Uint8Array(totalIdat);
  let pos = 0;
  for (const c of idatChunks) {
    compressed.set(c, pos);
    pos += c.byteLength;
  }

  const inflated = new Uint8Array(inflateSync(compressed));
  const stride = width * bpp;
  if (inflated.byteLength < (stride + 1) * height) {
    throw new Error('Invalid PNG: inflated IDAT smaller than expected scanlines');
  }

  const curLine = new Uint8Array(stride);
  const prevLine = new Uint8Array(stride);
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const lineStart = y * (stride + 1);
    const filter = inflated[lineStart]!;
    for (let i = 0; i < stride; i++) {
      const raw = inflated[lineStart + 1 + i]!;
      const a = i >= bpp ? curLine[i - bpp]! : 0;
      const b = prevLine[i]!;
      const c = i >= bpp ? prevLine[i - bpp]! : 0;
      switch (filter) {
        case 0:
          curLine[i] = raw;
          break;
        case 1:
          curLine[i] = (raw + a) & 0xff;
          break;
        case 2:
          curLine[i] = (raw + b) & 0xff;
          break;
        case 3:
          curLine[i] = (raw + ((a + b) >>> 1)) & 0xff;
          break;
        case 4:
          curLine[i] = (raw + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG scanline filter=${filter}`);
      }
    }

    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * 4;
      if (bpp === 4) {
        const s = x * 4;
        rgba[outIdx] = curLine[s]!;
        rgba[outIdx + 1] = curLine[s + 1]!;
        rgba[outIdx + 2] = curLine[s + 2]!;
        rgba[outIdx + 3] = curLine[s + 3]!;
      } else if (bpp === 3) {
        const s = x * 3;
        rgba[outIdx] = curLine[s]!;
        rgba[outIdx + 1] = curLine[s + 1]!;
        rgba[outIdx + 2] = curLine[s + 2]!;
        rgba[outIdx + 3] = 255;
      } else {
        const g = curLine[x]!;
        rgba[outIdx] = g;
        rgba[outIdx + 1] = g;
        rgba[outIdx + 2] = g;
        rgba[outIdx + 3] = 255;
      }
    }
    prevLine.set(curLine);
  }

  return { width, height, rgba };
}
