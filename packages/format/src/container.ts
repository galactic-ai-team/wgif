import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { FileEntry, FileRole, ManifestInput, WgifFiles, WgifManifest, WgifWorld } from './types.js';
import { MANIFEST_PATH } from './types.js';
import { signingHash, verifyManifestSignature } from './signing.js';
import { validateWorld } from './validate.js';
import { fromUtf8, guessMediaType, isPrecompressed, isSafePath, sha256Hex, utf8 } from './util.js';

/** Reader safety limits (SPEC §9). Players may lower them; raising them is at the player's risk. */
export const DEFAULT_LIMITS = {
  maxEntries: 4096,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};
export type Limits = typeof DEFAULT_LIMITS;

export interface PackOptions {
  /** Timestamp written into every ZIP entry. Fixed default keeps output byte-for-byte reproducible. */
  mtime?: Date;
  /** Deflate level for compressible files (0-9). */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

// ZIP (DOS) timestamps have no timezone and fflate writes them in *local* time, so build the
// date from local fields: every machine then writes the same bytes (1980-based DOS 2000-01-01 00:00).
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

/** Computes `files[]` (sorted by path) for the given payload, keeping any mediaType/role the caller set. */
export async function buildFileEntries(manifest: ManifestInput, files: WgifFiles): Promise<FileEntry[]> {
  const hints = new Map((manifest.files ?? []).filter((f) => f.path).map((f) => [f.path as string, f]));
  const paths = Object.keys(files).sort();
  const entries: FileEntry[] = [];
  for (const path of paths) {
    if (path === MANIFEST_PATH) throw new Error('payload must not contain manifest.json');
    if (!isSafePath(path)) throw new Error(`unsafe path "${path}"`);
    const bytes = files[path] as Uint8Array;
    const hint = hints.get(path);
    const mediaType = hint?.mediaType ?? guessMediaType(path);
    entries.push({
      path,
      sha256: await sha256Hex(bytes),
      size: bytes.byteLength,
      ...(mediaType ? { mediaType } : {}),
      role: hint?.role ?? inferRole(manifest, path),
    });
  }
  return entries;
}

/** Fills in `files[]` hashes and serialises manifest + payload into a .wgif (ZIP) byte array. */
export async function packWgif(manifest: ManifestInput, files: WgifFiles, opts: PackOptions = {}): Promise<Uint8Array> {
  const full: WgifManifest = { ...manifest, files: await buildFileEntries(manifest, files) };
  return packManifestAndFiles(full, files, opts);
}

/**
 * Serialises an already-complete manifest (e.g. one that was just signed) without touching `files[]`.
 * manifest.json is always the first entry and always stored uncompressed so sniffers can find it.
 */
export function packManifestAndFiles(manifest: WgifManifest, files: WgifFiles, opts: PackOptions = {}): Uint8Array {
  const mtime = opts.mtime ?? reproducibleMtime();
  const level = opts.level ?? 9;
  const zippable: Zippable = {};
  zippable[MANIFEST_PATH] = [utf8(JSON.stringify(manifest, null, 2) + '\n'), { level: 0, mtime }];
  for (const path of Object.keys(files).sort()) {
    zippable[path] = [files[path] as Uint8Array, { level: isPrecompressed(path) ? 0 : level, mtime }];
  }
  return zipSync(zippable);
}

export class WgifReadError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'WgifReadError';
  }
}

/** Reads raw entries with zip-bomb and path-traversal guards. Does not validate the manifest. */
export function readContainer(bytes: Uint8Array, limits: Limits = DEFAULT_LIMITS): { manifestJson: unknown; files: WgifFiles } {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new WgifReadError('container.notzip', 'not a WGIF file (expected a ZIP container)');
  }
  let count = 0;
  let total = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        count++;
        total += f.originalSize;
        if (count > limits.maxEntries) throw new WgifReadError('container.entries', `more than ${limits.maxEntries} entries`);
        if (f.originalSize > limits.maxEntryBytes) throw new WgifReadError('container.entrysize', `"${f.name}" is too large`);
        if (total > limits.maxTotalBytes) throw new WgifReadError('container.totalsize', 'uncompressed size exceeds limit');
        if (!isSafePath(f.name)) throw new WgifReadError('path.unsafe', `unsafe entry path "${f.name}"`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof WgifReadError) throw e;
    throw new WgifReadError('container.corrupt', `could not read ZIP: ${(e as Error).message}`);
  }
  const manifestBytes = raw[MANIFEST_PATH];
  if (!manifestBytes) throw new WgifReadError('manifest.missing', 'manifest.json not found at container root');
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(fromUtf8(manifestBytes));
  } catch (e) {
    throw new WgifReadError('manifest.json', `manifest.json is not valid UTF-8 JSON: ${(e as Error).message}`);
  }
  const files: WgifFiles = {};
  for (const [name, data] of Object.entries(raw)) if (name !== MANIFEST_PATH) files[name] = data;
  return { manifestJson, files };
}

/** Opens a .wgif: reads the container and runs full validation. Never throws on a *valid ZIP*; check `report.ok`. */
export async function unpackWgif(bytes: Uint8Array, limits: Limits = DEFAULT_LIMITS): Promise<WgifWorld> {
  const { manifestJson, files } = readContainer(bytes, limits);
  const report = await validateWorld(manifestJson, files);
  return { manifest: manifestJson as WgifManifest, files, report };
}

/**
 * Re-exports an opened world after edits (SPEC §6/§8). Recomputes hashes, bumps `modified`,
 * appends a history entry, and drops a signature that no longer matches (recording the
 * original as provenance.parent). Refuses to export a locked world as an edit.
 */
export async function exportEditedWorld(
  world: Pick<WgifWorld, 'manifest' | 'files'>,
  edit: { by?: string; note?: string; at?: Date } = {},
  opts: PackOptions = {},
): Promise<Uint8Array> {
  const before = world.manifest;
  if (before.mode === 'locked') throw new WgifReadError('mode.locked', 'world is locked by its creator; compliant players do not export edits');
  const at = (edit.at ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next: WgifManifest = {
    ...before,
    modified: at,
    files: await buildFileEntries(before, world.files),
    provenance: {
      ...before.provenance,
      history: [...(before.provenance?.history ?? []), { action: 'edit', at, ...(edit.by ? { by: edit.by } : {}), ...(edit.note ? { note: edit.note } : {}) }],
    },
  };
  if (before.signature) {
    const stillValid = (await verifyManifestSignature({ ...next, signature: before.signature })) && (await verifyManifestSignature(before));
    if (!stillValid) {
      delete next.signature;
      next.provenance = { ...next.provenance, parent: { id: before.id, signingHash: await signingHash(before) } };
    }
  }
  return packManifestAndFiles(next, world.files, opts);
}
