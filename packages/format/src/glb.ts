import { fromUtf8 } from './util.js';

const U32 = (b: Uint8Array, p: number): number => (b[p]! + b[p + 1]! * 256 + b[p + 2]! * 65536 + b[p + 3]! * 16777216) >>> 0;
const GLTF_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

/**
 * Conservative inspection of valid glTF 2.0 GLB JSON chunks for non-embedded URI references.
 * A full glTF parser and loading guard remain responsibilities of the player lane.
 * For compatibility with the existing unit-test dummy GLBs, this does not classify
 * structurally invalid GLB files; the renderer will still need to reject them.
 */
export function externalGlbUris(bytes: Uint8Array): string[] {
  if (bytes.length < 20 || U32(bytes, 0) !== GLTF_MAGIC || U32(bytes, 4) !== 2 || U32(bytes, 8) !== bytes.length)
    return [];
  const length = U32(bytes, 12);
  if (length > 8 * 1024 * 1024 || U32(bytes, 16) !== JSON_CHUNK || 20 + length > bytes.length) return [];
  let json: unknown;
  try { json = JSON.parse(fromUtf8(bytes.subarray(20, 20 + length))); }
  catch { return []; }
  const violations: string[] = [];
  function visit(value: unknown, depth: number): void {
    if (depth > 64 || violations.length >= 32 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'uri' && typeof child === 'string' && !child.startsWith('data:')) violations.push(child.slice(0, 160));
        else visit(child, depth + 1);
      }
    }
  }
  visit(json, 0);
  return violations;
}
