/** v0.1 glTF-extension interoperability check; does not execute GLB content. */
export const GLTF_V01_CAPABILITIES = {
  KHR_mesh_quantization: 'gltf.khr-mesh-quantization',
  KHR_texture_basisu: 'gltf.khr-texture-basisu',
  EXT_meshopt_compression: 'gltf.ext-meshopt-compression',
} as const;

export interface GlbExtensionIssue { code: string; message: string }

const u32 = (b: Uint8Array, p: number): number =>
  (b[p]! + b[p + 1]! * 256 + b[p + 2]! * 65536 + b[p + 3]! * 16777216) >>> 0;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Reads the leading glTF 2.0 JSON chunk. Null means the bytes are not a
 * structurally readable GLB. The runtime renderer performs full glTF validation.
 */
export function readGlbJson(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length < 20 || u32(bytes, 0) !== 0x46546c67 || u32(bytes, 4) !== 2 || u32(bytes, 8) !== bytes.length)
    return null;
  const length = u32(bytes, 12);
  if (length === 0 || length > 8 * 1024 * 1024 || length % 4 !== 0 ||
    u32(bytes, 16) !== 0x4e4f534a || 20 + length > bytes.length) return null;
  try {
    const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + length)));
    if (!isRecord(json) || !isRecord(json.asset) || json.asset.version !== '2.0') return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * Both extensionsUsed and extensionsRequired must be from the closed v0.1 set,
 * and each used extension must be declared using manifest.requires[]. There is
 * no WGIF manifest.requiredExtensions field. Strict mode rejects malformed GLBs
 * for release artifacts; the normal validator tolerates legacy dummy GLB fixtures.
 */
export function checkGlbExtensions(
  bytes: Uint8Array,
  requires: readonly string[],
  strictGlb = false,
): GlbExtensionIssue[] {
  const json = readGlbJson(bytes);
  if (!json) return strictGlb ? [{ code: 'glb.invalid', message: 'scene must contain a valid glTF 2.0 GLB JSON chunk' }] : [];
  const document = json;
  const issues: GlbExtensionIssue[] = [];
  function readList(key: 'extensionsUsed' | 'extensionsRequired'): string[] {
    const value = document[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((x) => typeof x === 'string' && x.length > 0)) {
      issues.push({ code: 'glb.extension.invalid', message: `${key} must be an array of non-empty strings` });
      return [];
    }
    const entries = value as string[];
    if (new Set(entries).size !== entries.length)
      issues.push({ code: 'glb.extension.duplicate', message: `${key} contains duplicates` });
    return entries;
  }
  const used = readList('extensionsUsed');
  const required = readList('extensionsRequired');
  const requiredSet = new Set(required);
  const usedSet = new Set(used);
  for (const extension of new Set([...used, ...required])) {
    const capability = Object.prototype.hasOwnProperty.call(GLTF_V01_CAPABILITIES, extension)
      ? GLTF_V01_CAPABILITIES[extension as keyof typeof GLTF_V01_CAPABILITIES] : undefined;
    if (!capability) {
      issues.push({ code: 'glb.extension.unsupported', message: `unsupported v0.1 glTF extension "${extension}"` });
      continue;
    }
    if (usedSet.has(extension) && !requires.includes(capability))
      issues.push({ code: 'glb.extension.undeclared', message: `${extension} must be declared as "${capability}" in manifest.requires[]` });
  }
  for (const extension of requiredSet) {
    if (!usedSet.has(extension))
      issues.push({ code: 'glb.extension.not-used', message: `extensionsRequired lists "${extension}" but extensionsUsed does not` });
  }
  return issues;
}
