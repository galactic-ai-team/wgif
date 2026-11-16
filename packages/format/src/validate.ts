import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import manifestSchema from '../schema/manifest.v0.1.schema.json' with { type: 'json' };
import interactionsSchema from '../schema/interactions.v0.1.schema.json' with { type: 'json' };
import gameStateSchema from '../schema/game-state.v0.1.schema.json' with { type: 'json' };
import layerSchema from '../schema/layer.v0.1.schema.json' with { type: 'json' };
import { knownCapability } from './capabilities.js';
import { externalGlbUris } from './glb.js';
import { checkGlbExtensions } from './glbExtensions.js';
import { verifyManifestSignature } from './signing.js';
import type { ValidationIssue, ValidationReport, WgifFiles, WgifManifest } from './types.js';
import { MODEL_SIZE_CAPS, WGIF_VERSION } from './types.js';
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

  // Embedded AI descriptors (§4.1). Keep these checks here, after RC1's full
  // file-integrity checks; never replace validateWorld() with the pre-RC1 copy.
  const modelIds = new Set<string>();
  const modelPaths = new Set<string>();
  const modelById = new Map((m.models ?? []).map((model) => [model.id, model]));
  for (const model of m.models ?? []) {
    const loc = `models.${model.id}`;
    if (modelIds.has(model.id)) err('models.duplicate', `duplicate model id "${model.id}"`, loc);
    modelIds.add(model.id);
    if (modelPaths.has(model.path)) err('models.duplicate-path', `two models use "${model.path}"`, model.path);
    modelPaths.add(model.path);
    if (!model.path.startsWith('models/') || !isSafePath(model.path))
      err('models.path', `model "${model.id}" MUST use a safe models/ path`, model.path);
    if (model.runtime === 'onnx' && !model.path.endsWith('.onnx'))
      err('models.type', `ONNX model "${model.id}" must have .onnx path`, model.path);
    if (model.runtime === 'rules' && !model.path.endsWith('.json'))
      err('models.type', `rules model "${model.id}" must have .json path`, model.path);
    const bytes = files[model.path];
    if (bytes) {
      const cap = model.sizeBytesMax ?? MODEL_SIZE_CAPS[model.runtime];
      if (bytes.byteLength > cap) err('models.oversize', `model "${model.id}" is ${bytes.byteLength} bytes; cap ${cap}`, model.path);
      if (model.runtime === 'rules') {
        try { JSON.parse(fromUtf8(bytes)); }
        catch { err('models.rules.json', `rules model "${model.id}" must be UTF-8 JSON`, model.path); }
      }
    }
    if (model.runtime === 'rules' && model.deterministic !== true)
      err('models.deterministic', `rules model "${model.id}" MUST declare deterministic: true`, loc);
    if (model.deterministic === true && model.seed === undefined)
      err('models.seed', `deterministic model "${model.id}" requires a uint32 seed`, loc);
    for (const side of ['inputs', 'outputs'] as const) {
      const fields = model[side];
      if (model.runtime === 'onnx' && !fields?.length) {
        err('models.tensor', `ONNX model "${model.id}" must declare ${side}`, loc);
        continue;
      }
      const names = new Set<string>();
      for (const field of fields ?? []) {
        if (names.has(field.name)) err('models.tensor', `duplicate ${side} name "${field.name}"`, loc);
        names.add(field.name);
        if (model.runtime === 'onnx') {
          if (!field.shape?.length || !field.dtype)
            err('models.tensor', `ONNX ${side} "${field.name}" needs shape and dtype`, loc);
          if (field.shape && (field.shape[0] !== 1 || field.shape.reduce((a, n) => a * n, 1) > 65536))
            err('models.tensor', `ONNX ${side} "${field.name}" exceeds v0.1 tensor shape limits`, loc);
        } else if (field.shape || field.dtype) {
          err('models.tensor', `rules ${side} "${field.name}" must be a named field, not a tensor`, loc);
        }
        if (field.range && field.range[0] > field.range[1])
          err('models.tensor', `invalid value range for ${side} "${field.name}"`, loc);
      }
    }
    if (model.fallback !== undefined) {
      const target = modelById.get(model.fallback);
      if (model.runtime !== 'onnx') err('models.fallback', `only ONNX models can declare fallback`, loc);
      if (model.fallback === model.id) err('models.fallback', `model "${model.id}" cannot fall back to itself`, loc);
      else if (!target) err('models.fallback', `unknown fallback "${model.fallback}"`, loc);
      else {
        if (target.fallback !== undefined) err('models.fallback', `fallback chains are forbidden`, loc);
        if (target.runtime !== 'rules') err('models.fallback', `fallback "${target.id}" MUST use rules runtime`, loc);
        if (!model.purpose || model.purpose !== target.purpose)
          err('models.fallback', `fallback "${target.id}" MUST share the purpose of "${model.id}"`, loc);
      }
    }
  }

  const glb = files[m.entry.scene];
  if (glb && externalGlbUris(glb).length > 0)
    err('scene.external-uri', 'GLB contains an external URI; only embedded data is permitted', m.entry.scene);
  if (glb) for (const issue of checkGlbExtensions(glb, m.requires ?? []))
    err(issue.code, issue.message, m.entry.scene);

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
