import * as ed from '@noble/ed25519';
import type { WgifManifest } from './types.js';
import { canonicalJson, fromHex, sha256, toHex, utf8 } from './util.js';

/**
 * The part of a manifest the creator signs (SPEC §7). It is the hash list of
 * every non-layer file plus every field that defines what the world *is* and
 * how it may be edited. Fields that layered edits are allowed to change
 * (`layers`, layer files, `modified`, `provenance.history`) and the signature
 * itself are excluded, so adding a layer keeps the base signature valid.
 */
export function signedView(manifest: WgifManifest): Record<string, unknown> {
  const { signature: _sig, layers: _layers, modified: _mod, provenance, files, ...rest } = manifest;
  const view: Record<string, unknown> = { ...rest };
  view.files = files
    .filter((f) => f.role !== 'layer')
    .map((f) => ({ path: f.path, sha256: f.sha256, size: f.size }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (provenance) {
    const { history: _history, ...prov } = provenance;
    if (Object.keys(prov).length > 0) view.provenance = prov;
  }
  return view;
}

/** SHA-256 of the canonical JSON of the signed view (hex). Also the id used in provenance.parent. */
export async function signingHash(manifest: WgifManifest): Promise<string> {
  return toHex(await sha256(utf8(canonicalJson(signedView(manifest)))));
}

export interface KeyPair {
  secretKey: Uint8Array;
  publicKeyHex: string;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  return { secretKey, publicKeyHex: toHex(publicKey) };
}

/** Returns a copy of the manifest with `creator.publicKey` and `signature` set. */
export async function signManifest(manifest: WgifManifest, secretKey: Uint8Array): Promise<WgifManifest> {
  const publicKeyHex = toHex(await ed.getPublicKeyAsync(secretKey));
  const unsigned: WgifManifest = { ...manifest, creator: { ...manifest.creator, publicKey: publicKeyHex } };
  delete unsigned.signature;
  const digest = fromHex(await signingHash(unsigned));
  const sig = await ed.signAsync(digest, secretKey);
  return { ...unsigned, signature: { alg: 'ed25519', publicKey: publicKeyHex, value: toHex(sig) } };
}

export async function verifyManifestSignature(manifest: WgifManifest): Promise<boolean> {
  const s = manifest.signature;
  if (!s || s.alg !== 'ed25519') return false;
  if (manifest.creator.publicKey && manifest.creator.publicKey !== s.publicKey) return false;
  try {
    const digest = fromHex(await signingHash(manifest));
    return await ed.verifyAsync(fromHex(s.value), digest, fromHex(s.publicKey));
  } catch {
    return false;
  }
}
