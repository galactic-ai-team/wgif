import { unzipSync, zipSync, type Zippable } from 'fflate';
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
export function readContainer(bytes: Uint8Array, limits: Limits = DEFAULT_LIMITS): { manifestJson: unknown; files: WgifFiles } {
  try { checkZipStructure(bytes, limits); }
  catch (e) {
    if (e instanceof ZipSafetyError) throw new WgifReadError(e.code, e.message);
    throw e;
  }
  let count = 0, total = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, { filter: (f) => {
      count++;
      total += f.originalSize;
      if (count > limits.maxEntries) throw new WgifReadError('container.entries', `more than ${limits.maxEntries} entries`);
      if (f.originalSize > limits.maxEntryBytes) throw new WgifReadError('container.entrysize', `"${f.name}" is too large`);
      if (total > limits.maxTotalBytes) throw new WgifReadError('container.totalsize', 'uncompressed size exceeds limit');
      if (!isSafePath(f.name)) throw new WgifReadError('path.unsafe', `unsafe entry path "${f.name}"`);
      return true;
    } });
  } catch (e) {
    if (e instanceof WgifReadError) throw e;
    throw new WgifReadError('container.corrupt', `could not read ZIP: ${(e as Error).message}`);
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
  world: Pick<WgifWorld, 'manifest' | 'files'>,
  edit: { by?: string; note?: string; at?: Date } = {},
  opts: PackOptions = {},
): Promise<Uint8Array> {
  const before = world.manifest;
  if (before.mode === 'locked') throw new WgifReadError('mode.locked', 'compliant players do not export edited locked worlds');
  const at = (edit.at ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next: WgifManifest = {
    ...before, modified: at, files: await buildFileEntries(before, world.files),
    provenance: { ...before.provenance,
      history: [...(before.provenance?.history ?? []),
        { action: 'edit', at, ...(edit.by ? { by: edit.by } : {}), ...(edit.note ? { note: edit.note } : {}) }] },
  };
  if (before.signature) {
    const stillValid = (await verifyManifestSignature({ ...next, signature: before.signature })) &&
      (await verifyManifestSignature(before));
    if (!stillValid) {
      delete next.signature;
      next.provenance = { ...next.provenance, parent: { id: before.id, signingHash: await signingHash(before) } };
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
