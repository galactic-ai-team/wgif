/** Strict ZIP preflight. No inflation or filesystem access occurs in this module. */
import { fromUtf8, isSafePath } from './util.js';

export interface ZipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number }
/** Validated local-entry spans, returned after central-directory preflight. */
export interface ZipEntry {
  name: string;
  method: 0 | 8;
  dataOffset: number;
  compressedSize: number;
  originalSize: number;
}
export class ZipSafetyError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'ZipSafetyError'; }
}
const fail = (code: string, message: string): never => { throw new ZipSafetyError(code, message); };
const U16 = (b: Uint8Array, p: number): number => b[p]! + b[p + 1]! * 256;
const U32 = (b: Uint8Array, p: number): number => (b[p]! + b[p + 1]! * 256 + b[p + 2]! * 65536 + b[p + 3]! * 16777216) >>> 0;
const SIGN = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50 };

/** v0.1 intentionally excludes ZIP64, encryption, descriptors, directories, and prepended GIF data. */
export function checkZipStructure(b: Uint8Array, limits: ZipLimits): ZipEntry[] {
  if (b.length < 22 || U32(b, 0) !== SIGN.local) fail('container.notzip', 'WGIF requires a ZIP with manifest.json first (no prefix)');
  let eocd = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--) {
    if (U32(b, p) === SIGN.end && p + 22 + U16(b, p + 20) === b.length) { eocd = p; break; }
  }
  if (eocd < 0) fail('container.corrupt', 'missing or malformed ZIP end directory');
  const count = U16(b, eocd + 10), countDisk = U16(b, eocd + 8);
  const dirSize = U32(b, eocd + 12), dirOffset = U32(b, eocd + 16);
  if (U16(b, eocd + 4) !== 0 || U16(b, eocd + 6) !== 0 || count !== countDisk)
    fail('container.unsupported', 'multi-disk ZIP is unsupported');
  if (count === 0xffff || dirOffset === 0xffffffff || dirSize === 0xffffffff)
    fail('container.unsupported', 'ZIP64 is unsupported in v0.1');
  if (count > limits.maxEntries) fail('container.entries', `more than ${limits.maxEntries} entries`);
  if (dirOffset + dirSize !== eocd || dirOffset >= b.length) fail('container.corrupt', 'invalid central directory bounds');

  function hasZip64Extra(begin: number, length: number): boolean {
    let at = begin;
    while (at + 4 <= begin + length) {
      const id = U16(b, at), len = U16(b, at + 2);
      if (at + 4 + len > begin + length) fail('container.corrupt', 'truncated ZIP extra field');
      if (id === 0x0001) return true;
      at += 4 + len;
    }
    if (at !== begin + length) fail('container.corrupt', 'malformed ZIP extra field');
    return false;
  }
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let total = 0, pos = dirOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > eocd || U32(b, pos) !== SIGN.central) fail('container.corrupt', 'bad central directory entry');
    const needed = U16(b, pos + 6);
    const flags = U16(b, pos + 8), method = U16(b, pos + 10);
    const crc = U32(b, pos + 16), compressed = U32(b, pos + 20), original = U32(b, pos + 24);
    const nameLen = U16(b, pos + 28), extraLen = U16(b, pos + 30), commentLen = U16(b, pos + 32);
    const disk = U16(b, pos + 34), external = U32(b, pos + 38), offset = U32(b, pos + 42);
    const end = pos + 46 + nameLen + extraLen + commentLen;
    if (needed >= 45 || hasZip64Extra(pos + 46 + nameLen, extraLen))
      fail('container.unsupported', 'ZIP64 is unsupported in v0.1');
    if (end > eocd || compressed === 0xffffffff || original === 0xffffffff || offset === 0xffffffff || disk !== 0)
      fail('container.unsupported', 'ZIP64 or malformed central entry');
    if ((flags & (1 | 8 | 0x40)) !== 0 || (method !== 0 && method !== 8))
      fail('container.unsupported', 'encrypted ZIP, data descriptor or unsupported compression method');
    if (((external >>> 16) & 0xf000) === 0xa000) fail('container.unsupported', 'ZIP symlinks are not allowed');
    let name = "";
    try { name = fromUtf8(b.subarray(pos + 46, pos + 46 + nameLen)); }
    catch { fail('container.corrupt', 'ZIP entry name is not valid UTF-8'); }
    if (!isSafePath(name) || name.endsWith('/')) fail('path.unsafe', `unsafe entry path "${name}"`);
    if (names.has(name)) fail('container.duplicate', `duplicate ZIP entry "${name}"`);
    if (name === 'manifest.json' && original > 1024 * 1024)
      fail('manifest.too-large', 'manifest.json exceeds 1 MiB limit');
    names.add(name);
    if (original > limits.maxEntryBytes) fail('container.entrysize', `"${name}" is too large`);
    total += original;
    if (total > limits.maxTotalBytes) fail('container.totalsize', 'uncompressed size exceeds limit');
    if (offset + 30 > dirOffset || U32(b, offset) !== SIGN.local) fail('container.corrupt', `bad local header for "${name}"`);
    const localFlags = U16(b, offset + 6), localMethod = U16(b, offset + 8);
    const localNameLen = U16(b, offset + 26), localExtraLen = U16(b, offset + 28);
    const data = offset + 30 + localNameLen + localExtraLen;
    if (data <= dirOffset && hasZip64Extra(offset + 30 + localNameLen, localExtraLen))
      fail('container.unsupported', 'ZIP64 local extra field is unsupported');
    if (data + compressed > dirOffset || localFlags !== flags || localMethod !== method || localNameLen !== nameLen ||
        U32(b, offset + 14) !== crc || U32(b, offset + 18) !== compressed || U32(b, offset + 22) !== original)
      fail('container.corrupt', `central/local ZIP metadata mismatch for "${name}"`);
    for (let j = 0; j < nameLen; j++) if (b[offset + 30 + j] !== b[pos + 46 + j])
      fail('container.corrupt', `central/local ZIP path mismatch for "${name}"`);
    if (name === 'manifest.json' && (offset !== 0 || method !== 0))
      fail('manifest.order', 'manifest.json MUST be the first, stored ZIP entry');
    if (method === 0 && compressed !== original)
      fail('container.corrupt', `stored ZIP entry has inconsistent size: ${name}`);
    entries.push({ name, method: method as 0 | 8, dataOffset: data, compressedSize: compressed, originalSize: original });
    ranges.push([offset, data + compressed]);
    pos = end;
  }
  if (pos !== eocd || !names.has('manifest.json')) fail('manifest.missing', 'manifest.json is missing or ZIP directory has trailing bytes');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1])
    fail('container.corrupt', 'overlapping ZIP entries');
  if (ranges[0]?.[0] !== 0 || ranges.at(-1)?.[1] !== dirOffset)
    fail('container.corrupt', 'unindexed or trailing data before ZIP central directory');
  return entries;
}
