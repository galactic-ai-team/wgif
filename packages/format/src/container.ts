import { Inflate, zipSync, type Zippable } from 'fflate';
import type { FileEntry, FileRole, ManifestInput, WgifFiles, WgifManifest, WgifWorld } from './types.js';
import { MANIFEST_PATH } from './types.js';
import { signingHash, verifyManifestSignature } from './signing.js';
import { validateWorld } from './validate.js';
import { fromUtf8, guessMediaType, isPrecompressed, isSafePath, sha256Hex, utf8 } from './util.js';
import { checkZipStructure, ZipSafetyError } from './zipSafety.js';

/** Uncompressed untrusted-archive ceilings. Readers MAY impose tighter device limits. */
export const DEFAULT_LIMITS = {
  maxEntries: 256,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};
export type Limits = typeof DEFAULT_LIMITS;
export interface PackOptions {
  mtime?: Date;
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}
const reproducibleMtime = (): Date => new Date(2000, 0, 1, 0, 0, 0);

function inferRole(m: ManifestInput, path: string): FileRole {
  if (path === m.entry.scene) return 'scene';
  if (path === m.entry.preview) return 'preview';
  if (path === m.entry.interactions) return 'interactions';
  if (path === m.entry.state) return 'state';
  if (m.models?.some((x) => x.path === path) || path.startsWith('models/')) return 'model';
  if (m.layers?.some((x) => x.path === path) || path.startsWith('layers/')) return 'layer';
  if (path.startsWith('assets/')) return 'asset';
  return 'other';
}

export async function buildFileEntries(manifest: ManifestInput, files: WgifFiles): Promise<FileEntry[]> {
  const hints = new Map((manifest.files ?? []).filter((f) => f.path).map((f) => [f.path as string, f]));
  const entries: FileEntry[] = [];
  for (const path of Object.keys(files).sort()) {
    if (path === MANIFEST_PATH) throw new Error('payload must not contain manifest.json');
    if (!isSafePath(path)) throw new Error(`unsafe path "${path}"`);
    const bytes = files[path] as Uint8Array;
    const hint = hints.get(path);
    const mediaType = hint?.mediaType ?? guessMediaType(path);
    entries.push({ path, sha256: await sha256Hex(bytes), size: bytes.byteLength,
      ...(mediaType ? { mediaType } : {}), role: hint?.role ?? inferRole(manifest, path) });
  }
  return entries;
}

/** Recalculates file hashes. Signed manifests MUST be signed after packing. */
export async function packWgif(manifest: ManifestInput, files: WgifFiles, opts: PackOptions = {}): Promise<Uint8Array> {
  const full: WgifManifest = { ...manifest, files: await buildFileEntries(manifest, files) };
  return packManifestAndFiles(full, files, opts);
}

export function packManifestAndFiles(manifest: WgifManifest, files: WgifFiles, opts: PackOptions = {}): Uint8Array {
  const mtime = opts.mtime ?? reproducibleMtime();
  const level = opts.level ?? 9;
  const zippable: Zippable = Object.create(null) as Zippable;
  zippable[MANIFEST_PATH] = [utf8(JSON.stringify(manifest, null, 2) + '\n'), { level: 0, mtime }];
  for (const path of Object.keys(files).sort()) {
    if (path === MANIFEST_PATH || !isSafePath(path)) throw new Error(`unsafe or reserved payload path "${path}"`);
    zippable[path] = [files[path] as Uint8Array, { level: isPrecompressed(path) ? 0 : level, mtime }];
  }
  return zipSync(zippable);
}

export class WgifReadError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'WgifReadError'; }
}

/** Preflights ZIP offsets, methods, paths, duplicates and entry limits before decompression. */
/** Small compressed chunks bound transient expansion before each budget check. */
const INFLATE_SOURCE_CHUNK_BYTES = 256;

/** Reads ZIP entries from validated local spans, checking actual output as it inflates. */
export function readContainer(bytes: Uint8Array, limits: Limits = DEFAULT_LIMITS): { manifestJson: unknown; files: WgifFiles } {
  let entries: ReturnType<typeof checkZipStructure>;
  try { entries = checkZipStructure(bytes, limits); }
  catch (e) {
    if (e instanceof ZipSafetyError) throw new WgifReadError(e.code, e.message);
    throw e;
  }

  // Never trust the central directory's advertised originalSize as an
  // inflation allowance: it can lie. Limit the actual decompressed output
  // incrementally; do not use unzipSync's single preallocated output buffer.
  const raw: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let expandedTotal = 0;
  for (const entry of entries) {
    const source = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    const chunks: Uint8Array[] = [];
    let expanded = 0;
    const append = (chunk: Uint8Array): void => {
      const next = expanded + chunk.byteLength;
      if (next > limits.maxEntryBytes)
        throw new WgifReadError('container.entrysize', `"${entry.name}" exceeds the uncompressed entry limit`);
      if (expandedTotal + next > limits.maxTotalBytes)
        throw new WgifReadError('container.totalsize', 'actual inflated bytes exceed the total limit');
      if (next > entry.originalSize)
        throw new WgifReadError('container.corrupt', `"${entry.name}" inflates beyond its declared size`);
      expanded = next;
      if (chunk.byteLength) chunks.push(chunk.slice());
    };
  try {
      if (entry.method === 0) append(source);
      else {
        const stream = new Inflate((chunk) => append(chunk));
        if (source.byteLength === 0) stream.push(new Uint8Array(0), true);
        for (let i = 0; i < source.byteLength; i += INFLATE_SOURCE_CHUNK_BYTES) {
          const end = Math.min(i + INFLATE_SOURCE_CHUNK_BYTES, source.byteLength);
          stream.push(source.subarray(i, end), end === source.byteLength);
        }
      }
  } catch (e) {
    if (e instanceof WgifReadError) throw e;
      throw new WgifReadError('container.corrupt', `could not inflate "${entry.name}": ${(e as Error).message}`);
    }
    if (expanded !== entry.originalSize)
      throw new WgifReadError('container.corrupt', `"${entry.name}" inflated to ${expanded} bytes, declared ${entry.originalSize}`);
    const output = new Uint8Array(expanded);
    let written = 0;
    for (const chunk of chunks) { output.set(chunk, written); written += chunk.byteLength; }
    raw[entry.name] = output;
    expandedTotal += expanded;
  }

  const manifestBytes = raw[MANIFEST_PATH];
  if (!manifestBytes) throw new WgifReadError('manifest.missing', 'manifest.json not found at container root');
  if (manifestBytes.byteLength > 1024 * 1024)
    throw new WgifReadError('manifest.too-large', 'manifest.json exceeds 1 MiB limit');
  let manifestJson: unknown;
  try { manifestJson = JSON.parse(fromUtf8(manifestBytes)); }
  catch (e) { throw new WgifReadError('manifest.json', `invalid UTF-8 JSON: ${(e as Error).message}`); }
  const files: WgifFiles = Object.create(null) as WgifFiles;
  for (const [name, data] of Object.entries(raw)) if (name !== MANIFEST_PATH) files[name] = data;
  return { manifestJson, files };
}
export async function unpackWgif(bytes: Uint8Array, limits: Limits = DEFAULT_LIMITS): Promise<WgifWorld> {
  const { manifestJson, files } = readContainer(bytes, limits);
  const report = await validateWorld(manifestJson, files);
  return { manifest: manifestJson as WgifManifest, files, report };
}

export async function exportEditedWorld(
  world: Pick<WgifWorld, 'manifest' | 'files'> & {
    /** Unmodified source manifest for signed edits that already changed manifest fields (such as spawn). */
    originalManifest?: WgifManifest;
  },
  edit: { by?: string; note?: string; at?: Date } = {},
  opts: PackOptions = {},
): Promise<Uint8Array> {
  const before = world.originalManifest ?? world.manifest;
  const edited = world.manifest;
  if (before.mode === 'locked' || edited.mode === 'locked') throw new WgifReadError('mode.locked', 'compliant players do not export edited locked worlds');
  const at = (edit.at ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next: WgifManifest = {
    ...edited, modified: at, files: await buildFileEntries(edited, world.files),
    provenance: { ...edited.provenance,
      history: [...(edited.provenance?.history ?? []),
        { action: 'edit', at, ...(edit.by ? { by: edit.by } : {}), ...(edit.note ? { note: edit.note } : {}) }] },
  };
  if (before.signature) {
    const stillValid = (await verifyManifestSignature({ ...next, signature: before.signature })) &&
      (await verifyManifestSignature(before));
    if (!stillValid) {
      delete next.signature;
      next.provenance = { ...next.provenance, parent: { id: before.id, signingHash: await signingHash(before) } };
    } else {
      next.signature = before.signature;
    }
  }
  // Export is a portability boundary: an edit must not produce an archive that
  // another v0.1 reader immediately rejects. Reopen the serialized bytes so
  // ZIP safety, file hashes, declarative payloads and signatures are checked.
  const archive = packManifestAndFiles(next, world.files, opts);
  let reopened: WgifWorld;
  try { reopened = await unpackWgif(archive); }
  catch (error) {
    throw new WgifReadError('export.invalid', `edited archive failed to reopen: ${(error as Error).message}`);
  }
  if (!reopened.report.ok || reopened.report.signature === 'invalid') {
    const errors = reopened.report.errors.map((issue) => `${issue.code}: ${issue.message}`);
    if (reopened.report.signature === 'invalid') errors.push('signature.invalid: edited archive has an invalid signature');
    throw new WgifReadError('export.invalid', `edited archive failed validation: ${errors.join('; ')}`);
  }
  return archive;
}
