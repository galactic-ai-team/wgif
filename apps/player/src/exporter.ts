import { exportEditedWorld, unpackWgif, utf8, type WgifFiles, type WgifManifest } from '@wgif/format';
import { applyEdits, compactOps, describeOp, isLayerOp, toLayer, type EditOp } from './edit.js';
import { PAYLOAD_VERSION, isJson, readJson, type GameState, type Json } from './interactions.js';
import type { WorldDocument } from './world.js';

export class WorldExportError extends Error {
  constructor(public code: 'locked' | 'nothing' | 'unsupported' | 'invalid', message: string) {
    super(message);
    this.name = 'WorldExportError';
  }
}

export interface ExportOptions {
  /** Unsaved edits from the edit panel. */
  ops?: EditOp[];
  /** Runtime state to write back (high score, where the ball lies). Editable worlds only; omit to leave the file's state alone. */
  state?: GameState | null;
  /** Who made the change, for provenance.history and the layer's author. */
  by?: string;
  note?: string;
  at?: Date;
}

export interface ExportResult {
  bytes: Uint8Array;
  fileName: string;
  manifest: WgifManifest;
  /** `edit`: base files were rewritten. `layer`: a layer was added and the base is untouched. */
  kind: 'edit' | 'layer';
  layerId?: string;
}

const json = (value: unknown): Uint8Array => utf8(JSON.stringify(value, null, 2) + '\n');
const tidy = (s: string | undefined, max: number): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function slug(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'world';
}

/** Writes runtime state into a game-state.json object, keeping the other fields the file already had. */
export function mergeRawState(raw: Json | null, state: GameState): Json {
  const minigames: Json = isJson(raw?.minigames) ? { ...raw.minigames } : {};
  for (const [id, value] of Object.entries(state.minigames)) minigames[id] = { ...(isJson(minigames[id]) ? minigames[id] : {}), ...value };
  const objects: Json = isJson(raw?.objects) ? { ...raw.objects } : {};
  for (const [id, value] of Object.entries(state.objects)) objects[id] = { ...(isJson(objects[id]) ? objects[id] : {}), position: [...value.position] };
  return { ...(raw ?? {}), version: PAYLOAD_VERSION, minigames, objects };
}

function nextLayerId(manifest: WgifManifest): string {
  const taken = new Set((manifest.layers ?? []).map((l) => l.id));
  const paths = new Set(manifest.files.map((f) => f.path));
  for (let n = taken.size + 1; ; n++) {
    const id = `layer-${n}`;
    if (!taken.has(id) && !paths.has(`layers/${id}.json`)) return id;
  }
}

/**
 * Builds a new .wgif from an open world plus the player's edits and state, following the creator's
 * mode (SPEC §6): locked worlds are refused, editable worlds get their base files rewritten, and
 * layered worlds get one new file under `layers/` while every base file stays byte-identical. Hashes,
 * `modified`, provenance and the signature are handled by `exportEditedWorld()` from @wgif/format.
 * The result is re-opened and validated before it is returned.
 */
export async function exportWorld(doc: WorldDocument, opts: ExportOptions = {}): Promise<ExportResult> {
  const before = doc.world.manifest;
  if (before.mode === 'locked') {
    throw new WorldExportError('locked', 'This world is locked by its creator. You can explore and play it, but not export a changed copy.');
  }
  const ops = compactOps(opts.ops ?? []);
  const at = opts.at ?? new Date();
  const by = tidy(opts.by, 80);
  const files: WgifFiles = { ...doc.world.files };
  let manifest: WgifManifest = { ...before };
  let kind: ExportResult['kind'] = 'edit';
  let layerId: string | undefined;
  let summary = ops.map(describeOp).join('; ');

  if (before.mode === 'layered') {
    const other = ops.find((op) => !isLayerOp(op));
    if (other) throw new WorldExportError('unsupported', `A layer can add, move and remove things, but cannot hold this change: ${describeOp(other)}.`);
    if (ops.length === 0) throw new WorldExportError('nothing', 'There is nothing to export yet. Add or move something first.');
    kind = 'layer';
    layerId = nextLayerId(before);
    const path = `layers/${layerId}.json`;
    files[path] = json(toLayer(ops));
    manifest = { ...before, layers: [...(before.layers ?? []), { id: layerId, path, author: by || 'anonymous', created: at.toISOString().replace(/\.\d{3}Z$/, 'Z') }] };
    summary = `${layerId}: ${summary}`;
  } else {
    const state = opts.state ?? null;
    if (ops.length === 0 && !state) throw new WorldExportError('nothing', 'There is nothing to export yet. Play or change something first.');
    const interactionsPath = before.entry.interactions;
    const edited = applyEdits(doc.interactionsRaw, ops);
    if (ops.length > 0 && interactionsPath && edited.interactions) files[interactionsPath] = json(edited.interactions);
    if (edited.spawn) {
      const lookAt = edited.spawn.lookAt ?? before.spawn?.lookAt;
      manifest = { ...before, spawn: { position: edited.spawn.position, ...(lookAt ? { lookAt } : {}) } };
    }
    const statePath = before.entry.state;
    if (state && statePath) {
      const raw = readJson(files[statePath]);
      files[statePath] = json(mergeRawState(isJson(raw) ? raw : null, state));
      if (!summary) summary = 'saved game state';
    }
  }

  const note = tidy(opts.note, 300) || tidy(summary, 300);
  const bytes = await exportEditedWorld({ manifest, files }, { at, ...(by ? { by } : {}), ...(note ? { note } : {}) });

  // Never hand out a file this player would refuse to open.
  const check = await unpackWgif(bytes);
  if (!check.report.ok) throw new WorldExportError('invalid', `The exported file failed validation: ${check.report.errors.map((e) => e.message).join('; ')}`);
  return { bytes, fileName: `${slug(before.title)}-${layerId ?? 'edit'}.wgif`, manifest: check.manifest, kind, ...(layerId ? { layerId } : {}) };
}
