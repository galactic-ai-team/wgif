const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return new Uint8Array(digest);
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> { return toHex(await sha256(bytes)); }

/** RFC 8785/JCS for JSON values. Reject unpaired UTF-16 surrogates and non-JSON primitives. */
export function canonicalJson(value: unknown): string {
  const stack = new Set<object>();
  function string(s: string): string {
    for (let i = 0; i < s.length; i++) {
      const n = s.charCodeAt(i);
      if (n >= 0xd800 && n <= 0xdbff) {
        const next = s.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('unpaired surrogate in canonical JSON');
      } else if (n >= 0xdc00 && n <= 0xdfff) throw new Error('unpaired surrogate in canonical JSON');
    }
    return JSON.stringify(s);
  }
  function convert(v: unknown): string {
    if (v === null) return 'null';
    if (typeof v === 'string') return string(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('non-finite number in canonical JSON');
      return JSON.stringify(v);
    }
    if (typeof v !== 'object') throw new Error(`non-JSON value in canonical JSON: ${typeof v}`);
    if (stack.has(v)) throw new Error('cycle in canonical JSON');
    stack.add(v);
    let result: string;
    if (Array.isArray(v)) {
      result = `[${v.map((x: unknown) => x === undefined ? 'null' : convert(x)).join(',')}]`;
    } else {
      const o = v as Record<string, unknown>;
      result = `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
        .map((k) => `${string(k)}:${convert(o[k])}`).join(',')}}`;
    }
    stack.delete(v);
    return result;
  }
  return convert(value);
}

const MEDIA_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', json: 'application/json', png: 'image/png',
  gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  ktx2: 'image/ktx2', onnx: 'application/onnx', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav',
};
export function guessMediaType(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? MEDIA_TYPES[ext] : undefined;
}
export function isPrecompressed(path: string): boolean {
  return /\.(png|gif|jpe?g|webp|ktx2|ogg|mp3|zip|wgif)$/i.test(path);
}
export function isSafePath(path: string): boolean {
  if (!path || path.length > 512 || path.startsWith('/') || path.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex -- intentional: reject control chars in archive paths
  if (/[\x00-\x1f\x7f]/.test(path) || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '' || seg === '__proto__');
}
