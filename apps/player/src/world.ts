import { unpackWgif, type Vec3, type WgifWorld } from '@wgif/format';
import { applyEdits, layerOps, parseLayer, type EditOp, type LayerFile, type SceneOp } from './edit.js';
import { isJson, parseGameState, parseInteractions, readJson, type GameState, type Interactions } from './interactions.js';

/** Capabilities actually implemented by this player, not merely known to the WGIF spec. */
const PLAYER_CAPABILITIES = new Set([
  'scene.glb',
  'interaction.camera',
  // @wgif/ai ships the rules runtime (rebounder NPC); the court requires it.
  // 'runtime.onnx' is deliberately NOT listed: the player runs ONNX models
  // only through the JS MLP evaluator for small MLPs, not arbitrary graphs,
  // and the court does not require it (rules fallback).
  'runtime.rules',
  // The world runtime in src/sim/: grabbing, cylinder triggers (enterFromAbove),
  // the Shootout, and the initial game-state.json seed.
  'interaction.grab',
  'interaction.trigger',
  'minigame.basketball-shooting',
  'state.initial',
  // Overlay layers (add / move / remove primitives), applied in src/edit.ts.
  'layer.primitives',
]);

export class WorldOpenError extends Error {
  /** The world's own preview image, when it can be shown instead of a world this player cannot run. */
  preview?: { bytes: Uint8Array; mediaType: string };

  constructor(message: string, public details: string[] = []) {
    super(message);
    this.name = 'WorldOpenError';
  }
}

const PREVIEW_TYPES: Record<string, string> = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function previewOf(world: WgifWorld): WorldOpenError['preview'] {
  const path = world.manifest.entry.preview;
  const bytes = path ? world.files[path] : undefined;
  const mediaType = PREVIEW_TYPES[path?.split('.').pop()?.toLowerCase() ?? ''];
  return bytes && mediaType ? { bytes, mediaType } : undefined;
}

/** Opens and validates a .wgif. Throws WorldOpenError with readable details if it cannot be played. */
export async function openWorld(bytes: Uint8Array): Promise<WgifWorld> {
  let world: WgifWorld;
  try {
    world = await unpackWgif(bytes);
  } catch (e) {
    throw new WorldOpenError(`Could not open file: ${(e as Error).message}`);
  }
  if (!world.report.ok) {
    throw new WorldOpenError('This .wgif failed validation', world.report.errors.map((e) => `${e.code}: ${e.message}`));
  }
  const missing = (world.manifest.requires ?? []).filter((cap) => !PLAYER_CAPABILITIES.has(cap));
  if (missing.length) {
    const error = new WorldOpenError('This world requires unsupported player features', missing.map((cap) => `requires: ${cap}`));
    // A world this player cannot run still shows what it is (its preview), with what is missing.
    error.preview = previewOf(world);
    throw error;
  }
  return world;
}

export interface LoadedLayer {
  id: string;
  path: string;
  author: string;
  created?: string;
  file: LayerFile;
  /** False when the layer file could not be read; it is listed but changes nothing. */
  ok: boolean;
}

/** What the creator's mode allows (SPEC §7). */
export type EditPolicy =
  /** Edits rewrite the base files; a creator signature over them is dropped on export. */
  | { canEdit: true; via: 'base' }
  /** Edits become a new layer; the base world and its signature stay intact. */
  | { canEdit: true; via: 'layer' }
  | { canEdit: false; via: null };

/** A world as the player runs it: the container plus its interactions, layers and initial state, resolved. */
export interface WorldDocument {
  world: WgifWorld;
  /** Interactions with every layer applied. */
  interactions: Interactions;
  /** What the layers do to the scene graph, in order (see src/sceneBridge.ts). */
  sceneOps: SceneOp[];
  layers: LoadedLayer[];
  /** Where the visitor starts: the manifest, else interactions.json. */
  spawn: { position: Vec3; lookAt?: Vec3 } | null;
  /** game-state.json as read from the file. */
  initialState: GameState;
  policy: EditPolicy;
  warnings: string[];
}

export function editPolicy(mode: WgifWorld['manifest']['mode']): EditPolicy {
  return mode === 'editable' ? { canEdit: true, via: 'base' } : mode === 'layered' ? { canEdit: true, via: 'layer' } : { canEdit: false, via: null };
}

/** Reads a validated world's interactions, layers and state. Never throws: what it cannot use becomes a warning. */
export async function loadDocument(world: WgifWorld): Promise<WorldDocument> {
  const { manifest, files } = world;
  const warnings: string[] = [];
  const interactionsPath = manifest.entry.interactions, statePath = manifest.entry.state;
  const rawInteractions = interactionsPath ? readJson(files[interactionsPath]) : null;

  // Layers only count in a layered world (the validator rejects them anywhere else).
  const layers: LoadedLayer[] = [];
  const ops: EditOp[] = [];
  for (const entry of manifest.mode === 'layered' ? (manifest.layers ?? []) : []) {
    const parsed = parseLayer(readJson(files[entry.path]));
    layers.push({ id: entry.id, path: entry.path, author: entry.author, ...(entry.created ? { created: entry.created } : {}), file: parsed.layer, ok: parsed.ok });
    if (!parsed.ok) warnings.push(`layer "${entry.id}" could not be read and was skipped`);
    else if (parsed.skipped > 0) warnings.push(`layer "${entry.id}": ${parsed.skipped} operation(s) could not be used and were skipped`);
    ops.push(...layerOps(parsed.layer));
  }
  const resolved = applyEdits(isJson(rawInteractions) ? rawInteractions : null, ops, 'layer');
  const parsed = parseInteractions(resolved.interactions);
  const cam = parsed.interactions.camera;
  return {
    world,
    interactions: parsed.interactions,
    sceneOps: resolved.sceneOps,
    layers,
    spawn: manifest.spawn ?? (cam.spawn ? { position: cam.spawn, ...(cam.lookAt ? { lookAt: cam.lookAt } : {}) } : null),
    initialState: parseGameState(statePath ? readJson(files[statePath]) : null),
    policy: editPolicy(manifest.mode),
    warnings: [...warnings, ...resolved.warnings, ...parsed.warnings],
  };
}

/**
 * What the signature badge says, and the sentence under it. A valid signature proves which key
 * signed the world and that the signed part is unchanged; it does not prove who the creator is
 * (SPEC §8: no PKI). An invalid one is never shown as a verified origin.
 */
export function describeTrust(world: WgifWorld): { label: string; tone: 'valid' | 'invalid' | 'absent'; detail: string } {
  const { manifest, report } = world;
  if (report.signature === 'valid') {
    const key = manifest.signature?.publicKey.slice(0, 12) ?? '';
    const layered = (manifest.layers?.length ?? 0) > 0 ? ' Layers added since are not covered by it.' : '';
    return {
      label: 'signature valid',
      tone: 'valid',
      detail: `Unchanged since it was signed with key ${key}…. The key is what is proven, not who "${manifest.creator.name}" is: check the key with the creator.${layered}`,
    };
  }
  if (report.signature === 'invalid') {
    return { label: 'signature invalid', tone: 'invalid', detail: 'Changed after it was signed, or signed by a different key. Treat its origin as unknown.' };
  }
  return {
    label: manifest.mode === 'locked' ? 'unsigned · unverified' : 'unsigned',
    tone: 'absent',
    detail: manifest.mode === 'locked' ? 'Locked by its creator but not signed, so its origin cannot be checked.' : 'No creator signature: anyone could have made or changed this file.',
  };
}

/** One sentence on what the creator allows, shown next to the mode badge. */
export function describeMode(doc: WorldDocument): string {
  const mode = doc.world.manifest.mode;
  if (mode === 'locked') return 'Locked by its creator: explore and play. Nothing here can be changed or exported.';
  if (mode === 'layered') return 'Layered: changes are added as layers on top. The original world stays untouched.';
  return 'Editable: you can change it and export your own copy.';
}

export interface CameraHints {
  position: [number, number, number];
  lookAt: [number, number, number];
  eyeHeight: number;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/** Reads spawn/camera hints from the manifest and (optionally) interactions.json. */
export function cameraHints(world: WgifWorld): CameraHints {
  const hints: CameraHints = {
    position: world.manifest.spawn?.position ?? [0, 1.7, 8],
    lookAt: world.manifest.spawn?.lookAt ?? [0, 1, 0],
    eyeHeight: 1.7,
  };
  const path = world.manifest.entry.interactions;
  const raw = path ? world.files[path] : undefined;
  if (raw) {
    try {
      const cam = (JSON.parse(new TextDecoder().decode(raw)) as { camera?: Partial<CameraHints> & { firstPersonHeight?: number } }).camera;
      if (cam?.firstPersonHeight) hints.eyeHeight = cam.firstPersonHeight;
      if (cam?.bounds) hints.bounds = cam.bounds;
    } catch {
      /* interactions.json is optional for the proof player */
    }
  }
  return hints;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
