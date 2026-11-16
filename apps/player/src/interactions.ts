import type { Vec3 } from '@wgif/format';
import { clamp, isVec3 } from './sim/vec.js';

/**
 * Typed readers for a world's declarative data: `interactions.json` and `game-state.json` (SPEC §5,
 * `interactions.v0.1.schema.json`, `game-state.v0.1.schema.json`). The format validator has already
 * checked the shape by the time a world opens; this layer is defence in depth and turns the data
 * into what the simulation needs. Nothing here throws: unknown or unusable parts are dropped with a
 * warning, numbers are clamped to sane ranges, and the player falls back to plain exploring.
 */

export type Json = Record<string, unknown>;

export interface CameraRules {
  spawn: Vec3 | null;
  lookAt: Vec3 | null;
  firstPersonHeight: number;
  bounds: { min: Vec3; max: Vec3 } | null;
}

export interface SpherePhysics {
  radius: number;
  restitution: number;
  friction: number;
}

/** The built-in events a trigger can raise (interactions.v0.1 `event.event`). */
export type TriggerEventName = 'score' | 'reset' | 'activate';
export const TRIGGER_EVENTS: readonly TriggerEventName[] = ['score', 'reset', 'activate'];

/**
 * One `on.*` handler. How this player runs them:
 * - `score`: a basket. Only a released shot can score, and only once per shot; it counts for the
 *   Shootout when the trigger is one of the minigame's targets.
 * - `reset`: the object goes back to its spawn point (the object that went in for `enter` /
 *   `enterFromAbove`; the named `target` for `grab`).
 * - `activate`: raised as a `trigger` runtime event for the host (sound, flash, agents).
 */
export interface TriggerEvent {
  event: TriggerEventName;
  /** `enter` / `enterFromAbove`: the object that has to go in (null = any). `grab`: the object acted on. */
  target: string | null;
}

export interface GrabbableDef {
  kind: 'grabbable';
  id: string;
  node: string | null;
  physics: SpherePhysics;
  spawn: Vec3 | null;
  /** `on.grab`: raised when the player or an agent picks this object up. */
  onGrab: TriggerEvent | null;
}

export interface TriggerDef {
  kind: 'trigger';
  id: string;
  node: string | null;
  shape: { type: 'cylinder'; center: Vec3; radius: number; height: number };
  /** `on.enterFromAbove`: raised when an object comes in through the top face and out through the bottom. */
  enterFromAbove: TriggerEvent | null;
  /** `on.enter`: raised when an object's centre comes into the cylinder from any side. */
  enter: TriggerEvent | null;
}

export type ObjectDef = GrabbableDef | TriggerDef;

export interface ShootingRules {
  durationSec: number;
  pointsPerBasket: number;
  /** Shots released further than this from the rim score one extra point. Null turns that off. */
  threePointRadius: number | null;
}

export interface MinigameDef {
  id: string;
  type: string;
  title: string;
  ball: string;
  targets: string[];
  rules: ShootingRules;
}

export interface Interactions {
  version: string;
  camera: CameraRules;
  objects: ObjectDef[];
  /** Node names that are solid. Null means the file does not say, so `extras.wgif.collider` hints apply. */
  staticColliders: string[] | null;
  minigames: MinigameDef[];
  /**
   * Trigger features the file uses that this player cannot run (an `on.*` handler it has no
   * semantics for). They are never silently dropped: they become warnings, and a world that lists
   * `interaction.trigger` in `requires[]` is refused for interactive play (see world.ts).
   */
  unsupported: string[];
}

export interface GameState {
  version: string;
  minigames: Record<string, { highScore: number; plays: number }>;
  objects: Record<string, { position: Vec3 }>;
}

export const BASKETBALL_SHOOTING = 'basketball-shooting';
/** Version tag this player writes into payload files. */
export const PAYLOAD_VERSION = '0.1';
export const DEFAULT_RULES: ShootingRules = { durationSec: 60, pointsPerBasket: 2, threePointRadius: null };
/** Same ranges as the schema, minus zero-point baskets and games too short to shoot in. */
export const RULE_LIMITS = { durationSec: [5, 86400], pointsPerBasket: [1, 1000], threePointRadius: [0.5, 1000] } as const;

const MAX_ITEMS = 1024;
/** Ids as the v0.1 schemas define them. */
export const ID = /^[A-Za-z0-9_:.-]{1,128}$/;

export const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null);
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const id = (v: unknown): string | null => (isId(v) ? v : null);
const num = (v: unknown, fallback: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
const vec3 = (v: unknown): Vec3 | null => (isVec3(v) && v.every((n) => Math.abs(n) <= 1e6) ? [v[0], v[1], v[2]] : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);

export function emptyInteractions(): Interactions {
  return { version: PAYLOAD_VERSION, camera: { spawn: null, lookAt: null, firstPersonHeight: 1.7, bounds: null }, objects: [], staticColliders: null, minigames: [], unsupported: [] };
}

/** Clamps minigame rules to playable ranges. Used for files and for the edit panel alike. */
export function sanitizeRules(raw: unknown, base: ShootingRules = DEFAULT_RULES): ShootingRules {
  const r = isJson(raw) ? raw : {};
  const three = r.threePointRadius === null ? null : typeof r.threePointRadius === 'number' && Number.isFinite(r.threePointRadius) && r.threePointRadius > 0
    ? clamp(r.threePointRadius, ...RULE_LIMITS.threePointRadius)
    : base.threePointRadius;
  return {
    durationSec: Math.round(num(r.durationSec, base.durationSec, ...RULE_LIMITS.durationSec)),
    pointsPerBasket: Math.round(num(r.pointsPerBasket, base.pointsPerBasket, ...RULE_LIMITS.pointsPerBasket)),
    threePointRadius: three,
  };
}

/** Reads one `on.<key>` handler. Unknown event names are reported, never guessed at. */
function parseHandler(on: Json | null, key: string, oid: string, unsupported: (m: string) => void): TriggerEvent | null {
  if (!on || on[key] === undefined) return null;
  const h = on[key];
  const event = isJson(h) ? h.event : undefined;
  if (!isJson(h) || typeof event !== 'string' || !(TRIGGER_EVENTS as readonly string[]).includes(event)) {
    unsupported(`object "${oid}": on.${key} event ${JSON.stringify(isJson(h) ? h.event : h)} is not one of ${TRIGGER_EVENTS.join(', ')}`);
    return null;
  }
  return { event: event as TriggerEventName, target: id(h.target) };
}

function parseObject(raw: unknown, warn: (m: string) => void, unsupported: (m: string) => void): ObjectDef | null {
  if (!isJson(raw)) return null;
  const oid = id(raw.id);
  if (!oid) {
    warn('an object without a valid id was ignored');
    return null;
  }
  const node = str(raw.node);
  const on = isJson(raw.on) ? raw.on : null;
  if (on) {
    const allowed = raw.kind === 'grabbable' ? ['grab'] : raw.kind === 'trigger' ? ['enterFromAbove', 'enter'] : [];
    for (const key of Object.keys(on)) {
      if (!allowed.includes(key)) unsupported(`object "${oid}": on.${key} on a ${String(raw.kind)} object has no meaning in this player`);
    }
  }
  if (raw.kind === 'grabbable') {
    let onGrab = parseHandler(on, 'grab', oid, unsupported);
    if (onGrab?.event === 'score') {
      unsupported(`object "${oid}": on.grab "score" is not supported (only a shot through a trigger scores)`);
      onGrab = null;
    } else if (onGrab?.event === 'reset' && (onGrab.target === null || onGrab.target === oid)) {
      unsupported(`object "${oid}": on.grab "reset" needs a target other than the object being picked up`);
      onGrab = null;
    }
    const p = isJson(raw.physics) ? raw.physics : {};
    if (p.shape !== undefined && p.shape !== 'sphere') warn(`object "${oid}": only sphere physics is supported, treating it as a sphere`);
    return {
      kind: 'grabbable',
      id: oid,
      node,
      physics: { radius: num(p.radius, 0.12, 0.01, 5), restitution: num(p.restitution, 0.6, 0, 0.98), friction: num(p.friction, 0.5, 0, 1) },
      spawn: vec3(raw.spawn),
      onGrab,
    };
  }
  if (raw.kind === 'trigger') {
    const s = isJson(raw.shape) ? raw.shape : {};
    const center = vec3(s.center);
    if (s.type !== 'cylinder' || !center) {
      unsupported(`trigger "${oid}": only cylinder shapes with a center are supported`);
      return null;
    }
    return {
      kind: 'trigger',
      id: oid,
      node,
      shape: { type: 'cylinder', center, radius: num(s.radius, 0.25, 0.01, 1000), height: num(s.height, 0.1, 0.01, 1000) },
      enterFromAbove: parseHandler(on, 'enterFromAbove', oid, unsupported),
      enter: parseHandler(on, 'enter', oid, unsupported),
    };
  }
  // `static` and `dynamic` are valid kinds with no behaviour of their own in this player.
  if (raw.kind !== 'static' && raw.kind !== 'dynamic') warn(`object "${oid}": unknown kind ${JSON.stringify(raw.kind)}, ignored`);
  return null;
}

/** Reads interactions.json. Pass the parsed JSON (or null/undefined when the world has none). */
export function parseInteractions(raw: unknown): { interactions: Interactions; warnings: string[] } {
  const out = emptyInteractions();
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (warnings.length < 20) warnings.push(`interactions: ${m}`);
  };
  const unsupported = (m: string): void => {
    if (out.unsupported.length < 50) out.unsupported.push(m);
    warn(`${m} (unsupported, ignored)`);
  };
  if (raw === null || raw === undefined) return { interactions: out, warnings };
  if (!isJson(raw)) {
    warn('not a JSON object, ignored');
    return { interactions: out, warnings };
  }
  out.version = str(raw.version) ?? out.version;
  if (!out.version.startsWith('0.1')) warn(`version ${out.version} is newer than this player, some of it may be ignored`);

  if (isJson(raw.camera)) {
    const c = raw.camera;
    out.camera.spawn = vec3(c.spawn);
    out.camera.lookAt = vec3(c.lookAt);
    out.camera.firstPersonHeight = num(c.firstPersonHeight, 1.7, 0.3, 3);
    const min = isJson(c.bounds) ? vec3(c.bounds.min) : null, max = isJson(c.bounds) ? vec3(c.bounds.max) : null;
    if (min && max && min.every((v, i) => v < max[i]!)) out.camera.bounds = { min, max };
    else if (c.bounds !== undefined) warn('camera.bounds needs min < max on every axis, ignored');
  }

  const seen = new Set<string>();
  for (const item of list(raw.objects)) {
    const obj = parseObject(item, warn, unsupported);
    if (!obj) continue;
    if (seen.has(obj.id)) {
      warn(`duplicate object id "${obj.id}", keeping the first`);
      continue;
    }
    seen.add(obj.id);
    out.objects.push(obj);
  }

  if (Array.isArray(raw.interactions) && raw.interactions.length > 0) {
    unsupported(`interactions[] (${raw.interactions.length} free-form entr${raw.interactions.length === 1 ? 'y' : 'ies'}) has no defined behaviour in v0.1`);
  }

  if (isJson(raw.colliders) && Array.isArray(raw.colliders.static)) {
    out.staticColliders = [...new Set(list(raw.colliders.static).map(str).filter((s): s is string => s !== null))];
  }

  for (const item of list(raw.minigames)) {
    if (!isJson(item)) continue;
    const mid = id(item.id), type = str(item.type), ball = id(item.ball);
    if (!mid || !type) {
      warn('a minigame without an id and type was ignored');
      continue;
    }
    if (type !== BASKETBALL_SHOOTING) {
      warn(`minigame "${mid}" has type "${type}", which this player cannot run yet`);
      continue;
    }
    const targets = list(item.targets).map(id).filter((t): t is string => t !== null);
    const ballDef = out.objects.find((o) => o.id === ball && o.kind === 'grabbable');
    const rims = targets.filter((t) => out.objects.some((o) => o.id === t && o.kind === 'trigger'));
    if (!ball || !ballDef || rims.length === 0) {
      warn(`minigame "${mid}" needs a grabbable ball and at least one trigger target, ignored`);
      continue;
    }
    out.minigames.push({ id: mid, type, title: str(item.title) ?? 'Shootout', ball, targets: rims, rules: sanitizeRules(item.rules) });
  }
  return { interactions: out, warnings };
}

export function emptyState(): GameState {
  return { version: PAYLOAD_VERSION, minigames: {}, objects: {} };
}

/** Reads game-state.json (or a saved copy of it). Unknown parts are dropped. */
export function parseGameState(raw: unknown): GameState {
  const out = emptyState();
  if (!isJson(raw)) return out;
  if (isJson(raw.minigames)) {
    for (const [key, value] of Object.entries(raw.minigames).slice(0, MAX_ITEMS)) {
      if (!ID.test(key) || !isJson(value)) continue;
      out.minigames[key] = { highScore: Math.round(num(value.highScore, 0, 0, 1e9)), plays: Math.round(num(value.plays, 0, 0, 1e9)) };
    }
  }
  if (isJson(raw.objects)) {
    for (const [key, value] of Object.entries(raw.objects).slice(0, MAX_ITEMS)) {
      const position = isJson(value) ? vec3(value.position) : null;
      if (ID.test(key) && position) out.objects[key] = { position };
    }
  }
  return out;
}

/**
 * Lists the game-state.json fields that are valid v0.1 but that this player does not apply, so
 * they are reported instead of silently ignored: the running `score` (top level and per minigame,
 * since a Shootout always starts from 0) and an object's `rotation`, `scale` and `enabled` (the
 * runtime only places objects). Export keeps them in the file untouched (see exporter.ts).
 */
export function unsupportedStateFields(raw: unknown): string[] {
  const out: string[] = [];
  if (!isJson(raw)) return out;
  if (raw.score !== undefined) out.push('score');
  if (isJson(raw.minigames)) {
    for (const [key, value] of Object.entries(raw.minigames).slice(0, MAX_ITEMS)) {
      if (isJson(value) && value.score !== undefined) out.push(`minigames.${key}.score`);
    }
  }
  if (isJson(raw.objects)) {
    for (const [key, value] of Object.entries(raw.objects).slice(0, MAX_ITEMS)) {
      if (!isJson(value)) continue;
      for (const field of ['rotation', 'scale', 'enabled']) if (value[field] !== undefined) out.push(`objects.${key}.${field}`);
    }
  }
  return out;
}

/** Later state wins per minigame and per object. */
export function mergeState(base: GameState, over: GameState | null | undefined): GameState {
  if (!over) return { version: base.version, minigames: { ...base.minigames }, objects: { ...base.objects } };
  return { version: PAYLOAD_VERSION, minigames: { ...base.minigames, ...over.minigames }, objects: { ...base.objects, ...over.objects } };
}

const MAX_JSON_BYTES = 1024 * 1024;

/** Decodes a small UTF-8 JSON payload file. Returns undefined (never throws) when it is missing or invalid. */
export function readJson(bytes: Uint8Array | undefined): unknown {
  if (!bytes || bytes.byteLength > MAX_JSON_BYTES) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
