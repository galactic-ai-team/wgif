/**
 * Deterministic Mulberry32 PRNG and byte-exact image encoders (PNG + GIF89a)
 * Zero external native dependencies to guarantee reproducible builds across OS/CPU.
 */
import { deflateSync } from 'node:zlib';

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return out;
}

/**
 * Encodes an RGBA8 buffer into a deterministic PNG buffer.
 */
export function encodeDeterministicPng(
  width: number,
  height: number,
  rgba: Uint8Array
): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None) for cross-platform zlib determinism
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const compressed = deflateSync(raw, { level: 6, memLevel: 8, strategy: 0 });
  const cIHDR = pngChunk('IHDR', ihdr);
  const cIDAT = pngChunk('IDAT', new Uint8Array(compressed));
  const cIEND = pngChunk('IEND', new Uint8Array(0));

  const total = signature.length + cIHDR.length + cIDAT.length + cIEND.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of [signature, cIHDR, cIDAT, cIEND]) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Minimal deterministic GIF89a LZW encoder (64-color global palette).
 */
export function encodeAnimatedGif89a(
  width: number,
  height: number,
  paletteRgb: Uint8Array, // 64 * 3 bytes
  framesIndexed: Uint8Array[], // each width * height with indices 0..63
  delayCs = 6
): Uint8Array {
  const bytes: number[] = [];
  const pushStr = (s: string) => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };
  const pushU16 = (v: number) => {
    bytes.push(v & 0xff, (v >>> 8) & 0xff);
  };

  // Header + Logical Screen Descriptor (64-color table => size flag 5 => 2^(5+1) = 64)
  pushStr('GIF89a');
  pushU16(width);
  pushU16(height);
  bytes.push(0x80 | (5 << 4) | 5, 0, 0);

  // Global Color Table (64 * 3 = 192 bytes)
  for (let i = 0; i < 192; i++) {
    bytes.push(paletteRgb[i] ?? 0);
  }

  // Netscape 2.0 infinite loop extension
  bytes.push(0x21, 0xff, 0x0b);
  pushStr('NETSCAPE2.0');
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const frame of framesIndexed) {
    // Graphic Control Extension
    bytes.push(0x21, 0xf9, 0x04, 0x00);
    pushU16(delayCs);
    bytes.push(0x00, 0x00);

    // Image Descriptor
    bytes.push(0x2c);
    pushU16(0);
    pushU16(0);
    pushU16(width);
    pushU16(height);
    bytes.push(0x00);

    // LZW Minimum Code Size = 6 (for 64 colors)
    const minCodeSize = 6;
    bytes.push(minCodeSize);
    const lzwData = lzwEncode(frame, minCodeSize);

    let pos = 0;
    while (pos < lzwData.length) {
      const chunkLen = Math.min(255, lzwData.length - pos);
      bytes.push(chunkLen);
      for (let i = 0; i < chunkLen; i++) {
        bytes.push(lzwData[pos + i]!);
      }
      pos += chunkLen;
    }
    bytes.push(0x00); // Block terminator
  }

  bytes.push(0x3b); // Trailer
  return new Uint8Array(bytes);
}

function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;

  const out: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;

  const emit = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  let table = new Map<number, number>();
  emit(clearCode);

  if (indices.length === 0) {
    emit(eoiCode);
    if (bitCount > 0) out.push(bitBuf & 0xff);
    return new Uint8Array(out);
  }

  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) {
      prefix = hit;
    } else {
      emit(prefix);
      if (nextCode < 4096) {
        table.set(key, nextCode++);
        if (nextCode > 1 << codeSize && codeSize < 12) {
          codeSize++;
        }
      } else {
        emit(clearCode);
        table = new Map<number, number>();
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = k;
    }
  }
  emit(prefix);
  emit(eoiCode);
  if (bitCount > 0) out.push(bitBuf & 0xff);
  return new Uint8Array(out);
}
