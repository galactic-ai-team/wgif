/**
 * A small, dependency-free GIF decoder (GIF87a / GIF89a): global and local palettes, transparency,
 * interlacing and the three disposal methods. Frames come out fully composited (RGBA, the size of
 * the GIF's logical screen), the way a browser would show them. Runs in the page or in Node.
 *
 * Long GIFs are sampled: at most `maxFrames` frames are kept, evenly spread, and each kept frame
 * shows for the frames it stands for (their delays are added up), so the loop keeps its timing.
 */
export interface GifFrame {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** How long it shows, ms. */
  delayMs: number;
}

export interface DecodedGif {
  width: number;
  height: number;
  frames: GifFrame[];
  /** Frames in the file, before sampling. */
  sourceFrames: number;
}

export interface GifLimits {
  maxFrames?: number;
  /** Width x height of the logical screen. */
  maxPixels?: number;
  /** Frames read from the file at most (decoding work), before sampling. */
  maxSourceFrames?: number;
  /** Longest side of a kept frame, px. Larger frames are nearest-neighbour downscaled before they are stored. */
  maxSide?: number;
}

export class GifError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GifError';
  }
}

/** Browsers show delays under 20 ms as 100 ms; so do we, or a "0 delay" GIF would spin. */
const MIN_DELAY_MS = 20;
const DEFAULT_DELAY_MS = 100;

export const isGif = (b: Uint8Array): boolean => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;

interface RawFrame {
  left: number;
  top: number;
  w: number;
  h: number;
  interlaced: boolean;
  palette: Uint8Array;
  minCode: number;
  data: Uint8Array;
  delayMs: number;
  disposal: number;
  transparent: number;
}

/** Reads the block structure (no pixel decoding yet). */
function parse(b: Uint8Array, limits: Required<GifLimits>): { width: number; height: number; frames: RawFrame[] } {
  if (!isGif(b)) throw new GifError('not a GIF file');
  let p = 6;
  const need = (n: number): void => {
    if (p + n > b.length) throw new GifError('the GIF is cut short');
  };
  need(7);
  const width = b[p]! | (b[p + 1]! << 8), height = b[p + 2]! | (b[p + 3]! << 8);
  const flags = b[p + 4]!;
  p += 7;
  if (width === 0 || height === 0) throw new GifError('the GIF has no size');
  if (width * height > limits.maxPixels) throw new GifError(`the GIF is too big (${width}×${height})`);
  let global: Uint8Array = new Uint8Array(0);
  if (flags & 0x80) {
    const n = 3 * (1 << ((flags & 7) + 1));
    need(n);
    global = b.subarray(p, p + n);
    p += n;
  }
  const subBlocks = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      need(1);
      const len = b[p++]!;
      if (len === 0) break;
      need(len);
      parts.push(b.subarray(p, p + len));
      total += len;
      p += len;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const part of parts) {
      out.set(part, o);
      o += part.length;
    }
    return out;
  };
  const frames: RawFrame[] = [];
  let gce = { delayMs: DEFAULT_DELAY_MS, disposal: 0, transparent: -1 };
  while (p < b.length) {
    const tag = b[p++]!;
    if (tag === 0x3b) break; // trailer
    if (tag === 0x21) {
      need(1);
      const label = b[p++]!;
      if (label === 0xf9) {
        const block = subBlocks();
        if (block.length >= 4) {
          const cs = block[1]! | (block[2]! << 8);
          gce = { delayMs: cs * 10 < MIN_DELAY_MS ? DEFAULT_DELAY_MS : cs * 10, disposal: (block[0]! >> 2) & 7, transparent: block[0]! & 1 ? block[3]! : -1 };
        }
      } else subBlocks();
    } else if (tag === 0x2c) {
      need(10);
      const left = b[p]! | (b[p + 1]! << 8), top = b[p + 2]! | (b[p + 3]! << 8);
      const w = b[p + 4]! | (b[p + 5]! << 8), h = b[p + 6]! | (b[p + 7]! << 8);
      const f = b[p + 8]!;
      p += 9;
      // The pixel buffer for a frame is w x h, whatever the screen size: a frame claiming
      // 65535 x 65535 would ask for 4 GB. A real frame fits its screen, which is already capped.
      if (w * h > limits.maxPixels) throw new GifError(`a GIF frame is too big (${w}×${h})`);
      let palette = global;
      if (f & 0x80) {
        const n = 3 * (1 << ((f & 7) + 1));
        need(n);
        palette = b.subarray(p, p + n);
        p += n;
      }
      need(1);
      const minCode = b[p++]!;
      if (minCode < 2 || minCode > 11) throw new GifError('the GIF has a bad image block');
      const data = subBlocks();
      if (palette.length === 0) throw new GifError('a GIF frame has no colour table');
      frames.push({ left, top, w, h, interlaced: !!(f & 0x40), palette, minCode, data, ...gce });
      gce = { delayMs: DEFAULT_DELAY_MS, disposal: 0, transparent: -1 };
      if (frames.length >= limits.maxSourceFrames) break;
    } else if (tag === 0x00) {
      continue; // stray padding some encoders leave
    } else {
      break; // unknown block: keep what we have
    }
  }
  if (frames.length === 0) throw new GifError('the GIF has no frames');
  return { width, height, frames };
}

/** GIF LZW: code stream -> palette indices (exactly `count` of them, padded with 0). */
export function lzwDecode(data: Uint8Array, minCode: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  const clear = 1 << minCode, eoi = clear + 1;
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
  }
  let size = minCode + 1, next = eoi + 1, prev = -1, o = 0, bits = 0, acc = 0, i = 0;
  const stack = new Uint8Array(4096);
  while (o < count) {
    while (bits < size) {
      if (i >= data.length) return out;
      acc |= data[i++]! << bits;
      bits += 8;
    }
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    bits -= size;
    if (code === clear) {
      size = minCode + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    let c = code;
    if (code >= next) {
      // KwKwK: the code being defined right now.
      if (prev < 0) break;
      c = prev;
    }
    // Write the string for c backwards into the stack.
    let sp = 0;
    while (c >= clear && sp < 4096) {
      stack[sp++] = suffix[c]!;
      c = prefix[c]!;
    }
    stack[sp++] = c;
    const head = stack[sp - 1]!;
    while (sp > 0 && o < count) out[o++] = stack[--sp]!;
    if (code >= next && o < count) out[o++] = head;
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = head;
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    prev = code;
  }
  return out;
}

/** Row order of an interlaced image: rows 0,8,16.. then 4,12.. then 2,6.. then 1,3.. */
function interlacedRows(h: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) for (let y = start; y < h; y += step) rows.push(y);
  return rows;
}

export function decodeGif(bytes: Uint8Array, limits: GifLimits = {}): DecodedGif {
  const lim: Required<GifLimits> = { maxFrames: limits.maxFrames ?? 48, maxPixels: limits.maxPixels ?? 2048 * 2048, maxSourceFrames: limits.maxSourceFrames ?? 600, maxSide: limits.maxSide ?? 2048 };
  const { width, height, frames } = parse(bytes, lim);
  const step = Math.max(1, Math.ceil(frames.length / lim.maxFrames));
  // Downscale the stored frames so a big GIF's 48 kept frames do not each
  // cost w*h*4 bytes. The working canvas stays at native size; only the
  // output copies shrink.
  const outScale = Math.min(1, lim.maxSide / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * outScale));
  const outH = Math.max(1, Math.round(height * outScale));
  const canvas = new Uint8ClampedArray(width * height * 4);
  const out: GifFrame[] = [];
  let saved: Uint8ClampedArray | null = null;
  let prev: RawFrame | null = null;
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k]!;
    // The previous frame's disposal happens before this one is drawn.
    if (prev) {
      if (prev.disposal === 2) {
        for (let y = Math.max(0, prev.top); y < Math.min(height, prev.top + prev.h); y++) canvas.fill(0, (y * width + Math.max(0, prev.left)) * 4, (y * width + Math.min(width, prev.left + prev.w)) * 4);
      } else if (prev.disposal === 3 && saved) canvas.set(saved);
    }
    saved = f.disposal === 3 ? canvas.slice() : null;
    const idx = lzwDecode(f.data, f.minCode, f.w * f.h);
    const rows = f.interlaced ? interlacedRows(f.h) : null;
    const pal = f.palette, colours = pal.length / 3;
    for (let r = 0; r < f.h; r++) {
      const y = f.top + (rows ? rows[r]! : r);
      if (y < 0 || y >= height) continue;
      for (let x = 0; x < f.w; x++) {
        const cx = f.left + x;
        if (cx < 0 || cx >= width) continue;
        const ci = idx[r * f.w + x]!;
        if (ci === f.transparent || ci >= colours) continue;
        const o = (y * width + cx) * 4;
        canvas[o] = pal[ci * 3]!;
        canvas[o + 1] = pal[ci * 3 + 1]!;
        canvas[o + 2] = pal[ci * 3 + 2]!;
        canvas[o + 3] = 255;
      }
    }
    if (k % step === 0) {
      // Downscale before storing so a big GIF's kept frames do not each cost
      // w*h*4 bytes: with the working canvas at full size, 48 kept frames of
      // a 2048x2048 GIF would be ~800 MB.
      const rgba = outW === width && outH === height
        ? canvas.slice()
        : nnResize(canvas, width, height, outW, outH);
      out.push({ rgba, width: outW, height: outH, delayMs: f.delayMs });
    } else out[out.length - 1]!.delayMs += f.delayMs;
    prev = f;
  }
  return { width, height, frames: out, sourceFrames: frames.length };
}

/** Nearest-neighbour resize of an RGBA buffer. Fast; the kept frames are downscaled before they are stored. */
function nnResize(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = src[si]!;
      out[di + 1] = src[si + 1]!;
      out[di + 2] = src[si + 2]!;
      out[di + 3] = src[si + 3]!;
    }
  }
  return out;
}
