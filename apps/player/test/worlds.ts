import { generateKeyPair, packManifestAndFiles, packWgif, signManifest, unpackWgif, utf8, type WgifFiles, type WgifManifest } from '@wgif/format';
import { courtBytes } from './helpers.js';

/** Builds variants of the sample court for tests: other modes, layers, signatures, tampering. */
export interface Variant {
  mode?: WgifManifest['mode'];
  /** Layers to append, in order. Only valid on a layered world. */
  layers?: { id: string; body: unknown; author?: string }[];
  /** Sign the base world (before any layers are added). */
  sign?: boolean;
  /** Change a signed field after signing, so the signature no longer verifies. */
  tamper?: boolean;
  requires?: string[];
  /** Extra or replaced payload files. */
  files?: WgifFiles;
}

export async function courtVariant(v: Variant = {}): Promise<Uint8Array> {
  const court = await unpackWgif(courtBytes());
  const files: WgifFiles = { ...court.files, ...v.files };
  const base: WgifManifest = { ...court.manifest, mode: v.mode ?? court.manifest.mode, ...(v.requires ? { requires: v.requires } : {}) };
  let manifest = (await unpackWgif(await packWgif({ ...base, files: undefined }, files))).manifest;
  if (v.sign) manifest = await signManifest(manifest, (await generateKeyPair()).secretKey);
  if (v.tamper) manifest = { ...manifest, title: `${manifest.title} (changed)` };
  if (!v.layers?.length) return packManifestAndFiles(manifest, files);
  for (const layer of v.layers) files[`layers/${layer.id}.json`] = utf8(JSON.stringify(layer.body));
  const layers = v.layers.map((l) => ({ id: l.id, path: `layers/${l.id}.json`, author: l.author ?? 'tester', created: '2026-11-16T12:00:00Z' }));
  return packWgif({ ...manifest, layers, files: undefined }, files);
}
