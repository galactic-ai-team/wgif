import type { Vec3 } from '@wgif/format';
import { PAYLOAD_VERSION, isId, isJson, sanitizeRules, type Json, type ShootingRules } from './interactions.js';
import { isVec3 } from './sim/vec.js';

/**
 * Edits as data, and the v0.1 overlay layer (SPEC §7, `layer.v0.1.schema.json`).
 *
 * A layer file holds bounded `add`, `move` and `remove` operations and nothing else. How this
 * player applies them (the Player lane's answer to the open question on layer semantics):
 *
 * - Layers apply in `manifest.layers[]` order. Inside one layer: `remove`, then `add`, then `move`.
 * - An id names, in this order: an interactions.json object, a primitive added by a layer, a scene node.
 * - `remove` drops the object or primitive, or hides the node and makes it non-solid.
 * - `add` puts a solid primitive in the world. `position` is its centre, `size` its full extents
 *   (box: x, y, z; sphere: diameter per axis; cylinder: diameter, height, diameter; default 1 m).
 * - `move` sets a grabbable's spawn point, a trigger's shape centre (its node moves by the same
 *   amount), or a node's or primitive's translation. `rotation` (quaternion x, y, z, w) and
 *   `scale` apply to the node.
 * - An operation whose id is unknown, or an `add` whose id is taken, is skipped with a warning.
 *
 * In an `editable` world the same edits are written into the base files on export instead; that is
 * also the only place rule and spawn changes can live, since a layer has no field for them.
 */
export type Primitive = 'box' | 'sphere' | 'cylinder';
export type Quat = [number, number, number, number];

export interface LayerAdd {
  id: string;
  primitive: Primitive;
  position: Vec3;
  size?: Vec3;
  color?: string;
}

export interface LayerMove {
  id: string;
  position: Vec3;
  rotation?: Quat;
  scale?: Vec3;
}

export interface LayerFile {
  version: string;
  add: LayerAdd[];
  move: LayerMove[];
  remove: string[];
}

/** One unsaved edit. `spawn` and `rules` only exist for editable worlds. */
export type EditOp =
  | ({ op: 'add' } & LayerAdd)
  | ({ op: 'move' } & LayerMove)
  | { op: 'remove'; id: string }
  | { op: 'spawn'; position: Vec3; lookAt?: Vec3 }
  | { op: 'rules'; minigame: string; rules: Partial<ShootingRules> };

/** What a layer does to the scene graph, in order. The scene bridge applies these to the three.js scene. */
export type SceneOp =
  | { kind: 'remove'; id: string }
  | ({ kind: 'add' } & Required<LayerAdd>)
  | { kind: 'move'; id: string; position?: Vec3; delta?: Vec3; rotation?: Quat; scale?: Vec3 };

export const DEFAULT_SIZE: Vec3 = [1, 1, 1];
export const DEFAULT_COLOR = '#9aa0c8';
const MAX_OPS = 10000;
const SIZE_LIMIT = 1000;

const point = (v: unknown): Vec3 | null => (isVec3(v) && v.every((n) => Math.abs(n) <= 1e6) ? [v[0], v[1], v[2]] : null);
const extent = (v: unknown): Vec3 | null => (isVec3(v) && v.every((n) => n > 0 && n <= SIZE_LIMIT) ? [v[0], v[1], v[2]] : null);
const quat = (v: unknown): Quat | null =>
  Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && Math.hypot(...(v as number[])) > 1e-6 ? (v.slice() as Quat) : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_OPS) : []);

function parseAdd(raw: unknown): LayerAdd | null {
  if (!isJson(raw) || !isId(raw.id)) return null;
  const position = point(raw.position);
  if (!position || (raw.primitive !== 'box' && raw.primitive !== 'sphere' && raw.primitive !== 'cylinder')) return null;
  const size = extent(raw.size);
  const color = typeof raw.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(raw.color) ? raw.color : null;
  return { id: raw.id, primitive: raw.primitive, position, ...(size ? { size } : {}), ...(color ? { color } : {}) };
}

function parseMove(raw: unknown): LayerMove | null {
  if (!isJson(raw) || !isId(raw.id)) return null;
  const position = point(raw.position);
  if (!position) return null;
  const rotation = quat(raw.rotation), scale = extent(raw.scale);
  return { id: raw.id, position, ...(rotation ? { rotation } : {}), ...(scale ? { scale } : {}) };
}

/** Reads a layer file. Never throws; operations it cannot use are counted in `skipped`. */
export function parseLayer(raw: unknown): { layer: LayerFile; skipped: number; ok: boolean } {
  const layer: LayerFile = { version: PAYLOAD_VERSION, add: [], move: [], remove: [] };
  if (!isJson(raw)) return { layer, skipped: 0, ok: false };
  if (typeof raw.version === 'string') layer.version = raw.version;
  let skipped = 0;
  for (const item of list(raw.remove)) {
    if (isId(item)) layer.remove.push(item);
    else skipped++;
  }
  for (const item of list(raw.add)) {
    const add = parseAdd(item);
    if (add) layer.add.push(add);
    else skipped++;
  }
  for (const item of list(raw.move)) {
    const move = parseMove(item);
    if (move) layer.move.push(move);
    else skipped++;
  }
  return { layer, skipped, ok: true };
}

export const layerOps = (layer: LayerFile): EditOp[] => [
  ...layer.remove.map((id): EditOp => ({ op: 'remove', id })),
  ...layer.add.map((a): EditOp => ({ op: 'add', ...a })),
  ...layer.move.map((m): EditOp => ({ op: 'move', ...m })),
];

export interface Resolved {
  /** interactions.json with the edits applied (a copy; the input is not touched). */
  interactions: Json | null;
  sceneOps: SceneOp[];
  /** Eye position and look target, when an edit moved the visitor's start. */
  spawn: { position: Vec3; lookAt?: Vec3 } | null;
  /** Ids in use after the edits: interaction objects and added primitives. */
  ids: Set<string>;
  warnings: string[];
}

const objectsOf = (raw: Json): Json[] => (Array.isArray(raw.objects) ? raw.objects.filter(isJson) : []);

/**
 * Applies edits, in order, to a parsed interactions.json. Returns the new interactions and the
 * matching list of scene operations. Works on raw JSON so that an export changes only what was edited.
 */
export function applyEdits(interactions: Json | null, ops: EditOp[], label = 'edit'): Resolved {
  const out = interactions ? (structuredClone(interactions) as Json) : null;
  const sceneOps: SceneOp[] = [];
  const warnings: string[] = [];
  const added = new Set<string>();
  let spawn: Resolved['spawn'] = null;
  const find = (id: string): Json | undefined => (out ? objectsOf(out).find((o) => o.id === id) : undefined);

  for (const op of ops) {
    if (op.op === 'remove') {
      const object = find(op.id);
      if (object && out) out.objects = (out.objects as unknown[]).filter((o) => o !== object);
      added.delete(op.id);
      sceneOps.push({ kind: 'remove', id: object && typeof object.node === 'string' ? object.node : op.id });
    } else if (op.op === 'add') {
      if (find(op.id) || added.has(op.id)) {
        warnings.push(`${label}: cannot add "${op.id}", that id is already in use`);
        continue;
      }
      added.add(op.id);
      sceneOps.push({ kind: 'add', id: op.id, primitive: op.primitive, position: op.position, size: op.size ?? DEFAULT_SIZE, color: op.color ?? DEFAULT_COLOR });
    } else if (op.op === 'move') {
      const object = find(op.id);
      const extra = { ...(op.rotation ? { rotation: op.rotation } : {}), ...(op.scale ? { scale: op.scale } : {}) };
      const node = object && typeof object.node === 'string' ? object.node : op.id;
      if (object?.kind === 'grabbable') {
        object.spawn = [...op.position];
        if (op.rotation || op.scale) sceneOps.push({ kind: 'move', id: node, ...extra });
      } else if (object?.kind === 'trigger' && isJson(object.shape) && isVec3(object.shape.center)) {
        const c = object.shape.center;
        sceneOps.push({ kind: 'move', id: node, delta: [op.position[0] - c[0], op.position[1] - c[1], op.position[2] - c[2]], ...extra });
        object.shape.center = [...op.position];
      } else {
        sceneOps.push({ kind: 'move', id: node, position: op.position, ...extra });
      }
    } else if (op.op === 'spawn') {
      spawn = { position: op.position, ...(op.lookAt ? { lookAt: op.lookAt } : {}) };
      if (out) {
        if (!isJson(out.camera)) out.camera = {};
        const camera = out.camera as Json;
        camera.spawn = [...op.position];
        if (op.lookAt) camera.lookAt = [...op.lookAt];
      }
    } else if (out) {
      const game = (Array.isArray(out.minigames) ? out.minigames : []).find((m) => isJson(m) && m.id === op.minigame);
      if (isJson(game)) {
        const rules = sanitizeRules({ ...(isJson(game.rules) ? game.rules : {}), ...op.rules });
        game.rules = { durationSec: rules.durationSec, pointsPerBasket: rules.pointsPerBasket, ...(rules.threePointRadius !== null ? { threePointRadius: rules.threePointRadius } : {}) };
      } else {
        warnings.push(`${label}: no minigame "${op.minigame}" to change`);
      }
    }
  }
  const ids = new Set<string>([...(out ? objectsOf(out).map((o) => String(o.id)) : []), ...added]);
  return { interactions: out, sceneOps, spawn, ids, warnings };
}
