import { Ajv, type ErrorObject } from 'ajv';
import schema from '../schema/manifest.v0.1.schema.json';
import { verifyManifestSignature } from './signing.js';
import type { ValidationIssue, ValidationReport, WgifFiles, WgifManifest } from './types.js';
import { WGIF_VERSION } from './types.js';
import { isSafePath, sha256Hex } from './util.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const schemaValidate = ajv.compile(schema);

const SUPPORTED_MAJOR = Number(WGIF_VERSION.split('.')[0]);
const SUPPORTED_MINOR = Number(WGIF_VERSION.split('.')[1]);

function ajvIssue(e: ErrorObject): ValidationIssue {
  return {
    level: 'error',
    code: `schema.${e.keyword}`,
    message: `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`,
    path: e.instancePath || undefined,
  };
}

/** Schema-only check. Pure and synchronous; use for editors and quick lint. */
export function validateManifestSchema(manifest: unknown): ValidationIssue[] {
  if (schemaValidate(manifest)) return [];
  return (schemaValidate.errors ?? []).map(ajvIssue);
}

/**
 * Full check of a manifest against the payload files (SPEC §9 reader rules):
 * schema, version, path safety, entry points, declared-vs-present files,
 * sizes, SHA-256 hashes, models/layers references and the creator signature.
 */
export async function validateWorld(manifest: unknown, files: WgifFiles): Promise<ValidationReport> {
  const errors: ValidationIssue[] = validateManifestSchema(manifest);
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string, path?: string) => errors.push({ level: 'error', code, message, path });
  const warn = (code: string, message: string, path?: string) => warnings.push({ level: 'warning', code, message, path });

  if (errors.length > 0) return { ok: false, errors, warnings, signature: 'absent' };
  const m = manifest as WgifManifest;

  const [major, minor] = m.wgif.split('.').map(Number) as [number, number];
  if (major !== SUPPORTED_MAJOR) err('version.major', `unsupported WGIF major version ${m.wgif} (reader supports ${WGIF_VERSION})`);
  else if (minor > SUPPORTED_MINOR) warn('version.minor', `world uses newer minor version ${m.wgif}; unknown fields may be ignored`);

  const declared = new Map<string, (typeof m.files)[number]>();
  for (const f of m.files) {
    if (!isSafePath(f.path)) err('path.unsafe', `unsafe path "${f.path}"`, f.path);
    if (f.path === 'manifest.json') err('files.manifest', 'manifest.json must not list itself', f.path);
    if (declared.has(f.path)) err('files.duplicate', `duplicate file entry "${f.path}"`, f.path);
    declared.set(f.path, f);
  }

  const refs: [string, string][] = [
    ['entry.scene', m.entry.scene],
    ['entry.preview', m.entry.preview],
  ];
  if (m.entry.interactions) refs.push(['entry.interactions', m.entry.interactions]);
  if (m.entry.state) refs.push(['entry.state', m.entry.state]);
  for (const model of m.models ?? []) refs.push([`models.${model.id}`, model.path]);
  for (const layer of m.layers ?? []) refs.push([`layers.${layer.id}`, layer.path]);
  for (const [field, path] of refs) {
    if (!declared.has(path)) err('ref.missing', `${field} points to "${path}", which is not in files[]`, path);
  }
  if (!/\.(glb|gltf)$/i.test(m.entry.scene)) warn('entry.scene.type', 'entry.scene should be a .glb (v0.1 players are only required to read GLB)');
  if (!/\.(gif|png|jpe?g|webp)$/i.test(m.entry.preview)) warn('entry.preview.type', 'entry.preview should be a GIF/PNG/JPEG/WebP image');

  for (const path of Object.keys(files)) {
    if (!declared.has(path)) err('files.undeclared', `container has "${path}" but files[] does not declare it`, path);
  }
  for (const [path, entry] of declared) {
    const bytes = files[path];
    if (!bytes) {
      err('files.absent', `files[] declares "${path}" but it is not in the container`, path);
      continue;
    }
    if (bytes.byteLength !== entry.size) err('files.size', `"${path}" is ${bytes.byteLength} bytes, manifest says ${entry.size}`, path);
    const hash = await sha256Hex(bytes);
    if (hash !== entry.sha256) err('files.hash', `"${path}" hash mismatch`, path);
  }

  if (m.mode === 'layered' && !m.layers) warn('mode.layered', 'mode is "layered" but no layers[] are present yet');
  if (m.mode !== 'layered' && m.layers && m.layers.length > 0) err('mode.layers', `layers[] requires mode "layered" (got "${m.mode}")`);

  let signature: ValidationReport['signature'] = 'absent';
  if (m.signature) {
    signature = (await verifyManifestSignature(m)) ? 'valid' : 'invalid';
    if (signature === 'invalid') warn('signature.invalid', 'creator signature does not verify; treat the world as modified/unsigned');
  } else if (m.mode === 'locked') {
    warn('signature.absent', 'locked world without a creator signature; players cannot tell the lock is authentic');
  }

  return { ok: errors.length === 0, errors, warnings, signature };
}
