/**
 * Browser-safe, zero-dependency deterministic Mulberry32 PRNG,
 * RFC 1950/1951 ZLIB (Static Huffman + LZ77) encoder, PNG encoder, and GIF89a encoder.
 * Works identically in Browser, Web Worker, Deno, and Node.js without `node:zlib`.
 */

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

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function adler32(buf: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  let i = 0;
  const len = buf.length;
  while (i < len) {
    const end = Math.min(i + 5552, len);
    while (i < end) {
      a += buf[i++]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

function reverseBits(val: number, bits: number): number {
  let res = 0;
  for (let i = 0; i < bits; i++) {
    res = (res << 1) | (val & 1);
    val >>>= 1;
  }
  return res;
}

/**
 * Pure TypeScript RFC 1950 ZLIB + RFC 1951 Fixed-Huffman LZ77 compressor.
 * Produces 100% deterministic, compact output across Browser and Node without `node:zlib`.
 */
export function zlibCompressDeterministic(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x9c]; // ZLIB header (CM=8, CINFO=7, FCHECK)
  let bitBuf = 0;
  let bitCount = 0;

  const writeBits = (val: number, count: number) => {
    bitBuf |= val << bitCount;
    bitCount += count;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  const writeFixedSym = (sym: number) => {
    if (sym <= 143) {
      writeBits(reverseBits(0x30 + sym, 8), 8);
    } else if (sym <= 255) {
      writeBits(reverseBits(0x190 + (sym - 144), 9), 9);
    } else if (sym <= 279) {
      writeBits(reverseBits(sym - 256, 7), 7);
    } else {
      writeBits(reverseBits(0xc0 + (sym - 280), 8), 8);
    }
  };

  const findCode = (val: number, baseArr: number[]): number => {
    let idx = 0;
    for (let i = baseArr.length - 1; i >= 0; i--) {
      if (val >= baseArr[i]!) {
        idx = i;
        break;
      }
    }
    return idx;
  };

  // Block header: BFINAL = 1, BTYPE = 01 (Fixed Huffman)
  writeBits(1, 1);
  writeBits(1, 2);

  // Hash table for deterministic LZ77 3-byte prefix matching (32K window)
  const head = new Int32Array(8192).fill(-1);
  const prev = new Int32Array(raw.length).fill(-1);
  const hash3 = (p: number) =>
    (((raw[p]! << 10) ^ (raw[p + 1]! << 5) ^ raw[p + 2]!) & 0x1fff);

  let pos = 0;
  const len = raw.length;
  while (pos < len) {
    let bestLen = 0;
    let bestDist = 0;

    if (pos + 2 < len) {
      const h = hash3(pos);
      let cand = head[h]!;
      prev[pos] = cand;
      head[h] = pos;

      let chain = 0;
      while (cand >= 0 && pos - cand <= 32768 && chain < 24) {
        chain++;
        if (raw[cand + bestLen] === raw[pos + bestLen]) {
          let m = 0;
          const maxL = Math.min(258, len - pos);
          while (m < maxL && raw[cand + m] === raw[pos + m]) {
            m++;
          }
          if (m >= 3 && m > bestLen) {
            bestLen = m;
            bestDist = pos - cand;
            if (m === 258) break;
          }
        }
        cand = prev[cand]!;
      }
    }

    if (bestLen >= 3) {
      const lIdx = findCode(bestLen, LEN_BASE);
      writeFixedSym(257 + lIdx);
      const lExtra = LEN_EXTRA[lIdx]!;
      if (lExtra > 0) writeBits(bestLen - LEN_BASE[lIdx]!, lExtra);

      const dIdx = findCode(bestDist, DIST_BASE);
      writeBits(reverseBits(dIdx, 5), 5);
      const dExtra = DIST_EXTRA[dIdx]!;
      if (dExtra > 0) writeBits(bestDist - DIST_BASE[dIdx]!, dExtra);

      for (let step = 1; step < bestLen; step++) {
        if (pos + step + 2 < len) {
          const h = hash3(pos + step);
          prev[pos + step] = head[h]!;
          head[h] = pos + step;
        }
      }
      pos += bestLen;
    } else {
      writeFixedSym(raw[pos]!);
      pos++;
    }
  }

  // End-of-block symbol 256
  writeFixedSym(256);
  if (bitCount > 0) {
    out.push(bitBuf & 0xff);
  }

  // Append big-endian Adler-32 trailer
  const adler = adler32(raw);
  out.push(
    (adler >>> 24) & 0xff,
    (adler >>> 16) & 0xff,
    (adler >>> 8) & 0xff,
    adler & 0xff
  );

  return new Uint8Array(out);
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
 * Encodes an RGBA8 buffer into a deterministic PNG buffer (browser-safe, zero Node built-ins).
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
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const compressed = zlibCompressDeterministic(raw);
  const cIHDR = pngChunk('IHDR', ihdr);
  const cIDAT = pngChunk('IDAT', compressed);
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
  paletteRgb: Uint8Array,
  framesIndexed: Uint8Array[],
  delayCs = 6
): Uint8Array {
  const bytes: number[] = [];
  const pushStr = (s: string) => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };
  const pushU16 = (v: number) => {
    bytes.push(v & 0xff, (v >>> 8) & 0xff);
  };

  pushStr('GIF89a');
  pushU16(width);
  pushU16(height);
  bytes.push(0x80 | (5 << 4) | 5, 0, 0);

  for (let i = 0; i < 192; i++) {
    bytes.push(paletteRgb[i] ?? 0);
  }

  bytes.push(0x21, 0xff, 0x0b);
  pushStr('NETSCAPE2.0');
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const frame of framesIndexed) {
    bytes.push(0x21, 0xf9, 0x04, 0x00);
    pushU16(delayCs);
    bytes.push(0x00, 0x00);

    bytes.push(0x2c);
    pushU16(0);
    pushU16(0);
    pushU16(width);
    pushU16(height);
    bytes.push(0x00);

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
    bytes.push(0x00);
  }

  bytes.push(0x3b);
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