import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import manifestSchema from '../schema/manifest.v0.1.schema.json';
import interactionsSchema from '../schema/interactions.v0.1.schema.json';
import gameStateSchema from '../schema/game-state.v0.1.schema.json';
import layerSchema from '../schema/layer.v0.1.schema.json';
import { knownCapability } from './capabilities.js';
import { externalGlbUris } from './glb.js';
import { verifyManifestSignature } from './signing.js';
import type { ValidationIssue, ValidationReport, WgifFiles, WgifManifest } from './types.js';
import { WGIF_VERSION } from './types.js';
import { fromUtf8, isSafePath, sha256Hex } from './util.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const schemaValidate = ajv.compile(manifestSchema);
const payloadValidators: Record<'interactions' | 'state' | 'layer', ValidateFunction> = {
  interactions: ajv.compile(interactionsSchema),
  state: ajv.compile(gameStateSchema),
  layer: ajv.compile(layerSchema),
};
const SUPPORTED_MAJOR = Number(WGIF_VERSION.split('.')[0]);
const SUPPORTED_MINOR = Number(WGIF_VERSION.split('.')[1]);
const MAX_JSON_BYTES = 1024 * 1024;

function ajvIssue(e: ErrorObject): ValidationIssue {
  return {
    level: 'error', code: `schema.${e.keyword}`,
    message: `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`,
    path: e.instancePath || undefined,
  };
}

/** Schema-only check; full payload and archive verification requires validateWorld/unpackWgif. */
export function validateManifestSchema(manifest: unknown): ValidationIssue[] {
  if (schemaValidate(manifest)) return [];
  return (schemaValidate.errors ?? []).map(ajvIssue);
}

/** Validates hashes, references, declared capability names and declarative JSON payloads. */
export async function validateWorld(manifest: unknown, files: WgifFiles): Promise<ValidationReport> {
  const errors: ValidationIssue[] = validateManifestSchema(manifest);
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string, path?: string) => errors.push({ level: 'error', code, message, path });
  const warn = (code: string, message: string, path?: string) => warnings.push({ level: 'warning', code, message, path });
  if (errors.length) return { ok: false, errors, warnings, signature: 'absent' };
  const m = manifest as WgifManifest;

  const [major, minor] = m.wgif.split('.').map(Number) as [number, number];
  if (major !== SUPPORTED_MAJOR) err('version.major', `unsupported WGIF major ${m.wgif}; reader supports ${WGIF_VERSION}`);
  else if (minor > SUPPORTED_MINOR) warn('version.minor', `newer WGIF minor ${m.wgif}; preview or partial support may be necessary`);
  for (const cap of m.requires ?? []) if (!knownCapability(cap)) warn('requires.unknown', `unknown required capability "${cap}"; player should show preview`, cap);

  const declared = new Map<string, (typeof m.files)[number]>();
  for (const f of m.files) {
    if (!isSafePath(f.path)) err('path.unsafe', `unsafe path "${f.path}"`, f.path);
    if (f.path === 'manifest.json') err('files.manifest', 'manifest.json must not list itself', f.path);
    if (declared.has(f.path)) err('files.duplicate', `duplicate file entry "${f.path}"`, f.path);
    declared.set(f.path, f);
    if (/\.(?:[cm]?js|wasm|html?|sh|exe|dll|bat|ps1)$/i.test(f.path))
      err('payload.executable', `executable payloads are forbidden in WGIF v0.1: "${f.path}"`, f.path);
    if (f.role === 'layer' && !f.path.startsWith('layers/')) err('layer.path', 'layer-role files must be below layers/', f.path);
  }

  const refs: Array<[string, string]> = [['entry.scene', m.entry.scene], ['entry.preview', m.entry.preview]];
  if (m.entry.interactions) refs.push(['entry.interactions', m.entry.interactions]);
  if (m.entry.state) refs.push(['entry.state', m.entry.state]);
  for (const model of m.models ?? []) refs.push([`models.${model.id}`, model.path]);
  for (const layer of m.layers ?? []) refs.push([`layers.${layer.id}`, layer.path]);
  for (const [field, path] of refs) {
    if (!isSafePath(path)) err('path.unsafe', `${field} uses an unsafe path`, path);
    if (!declared.has(path)) err('ref.missing', `${field} points to "${path}", not present in files[]`, path);
  }
  if (!/\.glb$/i.test(m.entry.scene)) err('entry.scene.type', 'v0.1 scene MUST be a .glb');
  if (!/\.(gif|png|jpe?g|webp)$/i.test(m.entry.preview)) err('entry.preview.type', 'unsupported preview image extension');
  if (m.entry.interactions && !m.entry.interactions.endsWith('.json')) err('entry.interactions.type', 'interactions MUST be JSON');
  if (m.entry.state && !m.entry.state.endsWith('.json')) err('entry.state.type', 'state MUST be JSON');

  for (const path of Object.keys(files)) {
    if (!isSafePath(path)) err('path.unsafe', `unsafe container path "${path}"`, path);
    if (!declared.has(path)) err('files.undeclared', `container has "${path}" not listed in files[]`, path);
  }
  for (const [path, entry] of declared) {
    const bytes = files[path];
    if (!bytes) { err('files.absent', `files[] declares missing "${path}"`, path); continue; }
    if (bytes.byteLength !== entry.size) err('files.size', `"${path}" is ${bytes.byteLength} bytes, manifest says ${entry.size}`, path);
    if (await sha256Hex(bytes) !== entry.sha256) err('files.hash', `"${path}" hash mismatch`, path);
  }

  const glb = files[m.entry.scene];
  if (glb && externalGlbUris(glb).length > 0)
    err('scene.external-uri', 'GLB contains an external URI; only embedded data is permitted', m.entry.scene);

  if (m.mode === 'layered' && !m.layers?.length) warn('mode.layered', 'layered mode without layers[] is permitted');
  if (m.mode !== 'layered' && m.layers?.length) err('mode.layers', `layers[] requires mode "layered", got "${m.mode}"`);
  const uniqueLayerPaths = new Set<string>();
  for (const layer of m.layers ?? []) {
    if (!layer.path.startsWith('layers/') || !layer.path.endsWith('.json')) err('layer.path', `layer must be a JSON file inside layers/: ${layer.path}`, layer.path);
    if (uniqueLayerPaths.has(layer.path)) err('layer.duplicate', `layer path reused: ${layer.path}`, layer.path);
    uniqueLayerPaths.add(layer.path);
    if (declared.get(layer.path)?.role !== 'layer') err('layer.role', `layer must have role "layer": ${layer.path}`, layer.path);
  }
  for (const f of m.files.filter((f) => f.role === 'layer')) {
    if (!uniqueLayerPaths.has(f.path)) err('layer.unreferenced', `layer file not declared in layers[]: ${f.path}`, f.path);
  }

  function validateJson(path: string | undefined, kind: 'interactions' | 'state' | 'layer'): void {
    if (!path || !files[path]) return;
    const bytes = files[path]!;
    if (bytes.byteLength > MAX_JSON_BYTES) { err('payload.too-large', `${path} exceeds 1 MiB JSON limit`, path); return; }
    let data: unknown;
    try { data = JSON.parse(fromUtf8(bytes)); }
    catch { err('payload.json', `${path} is not valid UTF-8 JSON`, path); return; }
    const check = payloadValidators[kind];
    if (!check(data)) for (const issue of check.errors ?? [])
      err(`payload.${kind}.${issue.keyword}`, `${path}${issue.instancePath} ${issue.message ?? 'invalid'}`, path);
    if (data && typeof data === 'object' && 'version' in data) {
      const version = (data as { version: unknown }).version;
      if (version === '0.1-draft') warn('payload.version.draft', `${path} uses legacy 0.1-draft tag; writer SHOULD use 0.1`, path);
    } else warn('payload.version.absent', `${path} has no version; writer SHOULD add "version": "0.1"`, path);
  }
  validateJson(m.entry.interactions, 'interactions');
  validateJson(m.entry.state, 'state');
  for (const layer of m.layers ?? []) validateJson(layer.path, 'layer');

  let signature: ValidationReport['signature'] = 'absent';
  if (m.signature) {
    signature = await verifyManifestSignature(m) ? 'valid' : 'invalid';
    if (signature === 'invalid') warn('signature.invalid', 'creator signature invalid: treat origin as unverified');
  } else if (m.mode === 'locked') warn('signature.absent', 'locked world is unsigned: mode is policy, not DRM');
  return { ok: errors.length === 0, errors, warnings, signature };
}
