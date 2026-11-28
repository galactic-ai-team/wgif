/**
 * Rebounder memory: what the court rebounder remembers across sessions
 * (WGIF Memory, SPEC §10 DRAFT). The rules model and the ONNX clone are
 * stateless — the same shot plays the same way every time — so memory lives
 * here, as a small layer on top of the NPC: player stats (makes, misses,
 * favourite shooting spots) and a learned home position, all derived from
 * a fixed-size heatmap so the serialized form is bounded and the update is
 * deterministic (no randomness, no wall-clock time).
 *
 * The memory is a save delta, not part of the .wgif: it is stored keyed to
 * the world's hash (SPEC §10), serializes to a few hundred bytes of JSON,
 * and is validated on load — anything malformed is discarded and the NPC
 * starts fresh, never crashes. It applies to the NPC whichever runtime is
 * driving it (rules or the ONNX clone): it biases where the NPC waits, not
 * how the model thinks.
 */
import type { Vec3 } from './types.js';

/** The memory format version. A loader MUST reject any other version. */
export const MEMORY_VERSION = 1;
/** The heatmap is a fixed grid over the court's playable bounds. */
export const MEMORY_GRID = 4;
/** A cell count above this is halved across the grid (old misses fade). */
const MEMORY_CELL_CAP = 255;

export interface RebounderMemory {
  version: 1;
  /** The model's seed (the memory belongs to the model that made it). */
  seed: number;
  makes: number;
  misses: number;
  /** Where missed shots landed, 16 cells over the court's bounds (row-major, x then z). */
  missHeat: number[];
  /** Where the player shot from, same grid. The hottest cell is their favourite spot. */
  shotHeat: number[];
}

/** An empty memory for a model with the given seed. */
export function createMemory(seed = 7): RebounderMemory {
  return { version: 1, seed, makes: 0, misses: 0, missHeat: new Array(MEMORY_GRID * MEMORY_GRID).fill(0), shotHeat: new Array(MEMORY_GRID * MEMORY_GRID).fill(0) };
}

export interface CourtBounds {
  min: Vec3;
  max: Vec3;
}

/** Which heatmap cell a court position falls in (clamped to the grid). */
export function cellFor(pos: Vec3, bounds: CourtBounds): number {
  const gx = Math.min(MEMORY_GRID - 1, Math.max(0, Math.floor(((pos[0] - bounds.min[0]) / (bounds.max[0] - bounds.min[0])) * MEMORY_GRID)));
  const gz = Math.min(MEMORY_GRID - 1, Math.max(0, Math.floor(((pos[2] - bounds.min[2]) / (bounds.max[2] - bounds.min[2])) * MEMORY_GRID)));
  return gz * MEMORY_GRID + gx;
}

/** The centre of a heatmap cell, in court coordinates. */
export function cellCenter(cell: number, bounds: CourtBounds): Vec3 {
  const gx = cell % MEMORY_GRID;
  const gz = Math.floor(cell / MEMORY_GRID);
  return [
    bounds.min[0] + ((gx + 0.5) / MEMORY_GRID) * (bounds.max[0] - bounds.min[0]),
    0,
    bounds.min[2] + ((gz + 0.5) / MEMORY_GRID) * (bounds.max[2] - bounds.min[2]),
  ];
}

/**
 * Records one shot and returns a new memory (the input is not mutated).
 * `landedAt` is where a missed ball came to rest; it is ignored for a make.
 * When a cell count passes the cap, every cell is halved (floor), so old
 * misses fade and the counts stay bounded.
 */
export function recordShot(
  mem: RebounderMemory,
  outcome: 'make' | 'miss',
  shotFrom: Vec3,
  landedAt: Vec3 | null,
  bounds: CourtBounds,
): RebounderMemory {
  const next: RebounderMemory = {
    version: 1,
    seed: mem.seed,
    makes: mem.makes + (outcome === 'make' ? 1 : 0),
    misses: mem.misses + (outcome === 'miss' ? 1 : 0),
    missHeat: [...mem.missHeat],
    shotHeat: [...mem.shotHeat],
  };
  next.shotHeat[cellFor(shotFrom, bounds)] = (next.shotHeat[cellFor(shotFrom, bounds)] ?? 0) + 1;
  if (outcome === 'miss' && landedAt) {
    const cell = cellFor(landedAt, bounds);
    next.missHeat[cell] = (next.missHeat[cell] ?? 0) + 1;
    if ((next.missHeat[cell] ?? 0) > MEMORY_CELL_CAP) {
      for (let i = 0; i < next.missHeat.length; i++) next.missHeat[i] = Math.floor((next.missHeat[i] ?? 0) / 2);
      for (let i = 0; i < next.shotHeat.length; i++) next.shotHeat[i] = Math.floor((next.shotHeat[i] ?? 0) / 2);
    }
  }
  return next;
}

/** The player's make rate, 0 when they have not shot yet. */
export function makeRate(mem: RebounderMemory): number {
  const total = mem.makes + mem.misses;
  return total === 0 ? 0 : mem.makes / total;
}

/** The centre of the hottest shot cell — where the player shoots from most — or null before any shot. */
export function favoriteSpot(mem: RebounderMemory, bounds: CourtBounds): Vec3 | null {
  let best = -1;
  let bestCount = 0;
  for (let i = 0; i < mem.shotHeat.length; i++) {
    const count = mem.shotHeat[i] ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = i;
    }
  }
  return best < 0 ? null : cellCenter(best, bounds);
}

/**
 * The home the NPC should wait at, given what it has learned: the declared
 * home blended toward the centroid of where misses land. The blend grows
 * with the evidence (0 with no misses, 0.5 after 20 misses) and never
 * abandons the post entirely — the NPC is still a rebounder, not a camper.
 */
export function learnedHome(mem: RebounderMemory, declaredHome: Vec3, bounds: CourtBounds): Vec3 {
  const total = mem.missHeat.reduce((a, b) => a + b, 0);
  if (total === 0) return [...declaredHome];
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < mem.missHeat.length; i++) {
    const count = mem.missHeat[i] ?? 0;
    if (count === 0) continue;
    const c = cellCenter(i, bounds);
    cx += c[0] * count;
    cz += c[2] * count;
  }
  const centroid: Vec3 = [cx / total, 0, cz / total];
  const bias = Math.min(0.5, mem.misses / 20);
  return [
    declaredHome[0] + (centroid[0] - declaredHome[0]) * bias,
    0,
    declaredHome[2] + (centroid[2] - declaredHome[2]) * bias,
  ];
}

/** Serializes a memory to compact JSON (a few hundred bytes). */
export function serializeMemory(mem: RebounderMemory): string {
  return JSON.stringify({
    v: mem.version,
    seed: mem.seed,
    makes: mem.makes,
    misses: mem.misses,
    miss: mem.missHeat,
    shot: mem.shotHeat,
  });
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isHeat = (a: unknown): a is number[] =>
  Array.isArray(a) && a.length === MEMORY_GRID * MEMORY_GRID && a.every((n) => isInt(n) && n <= MEMORY_CELL_CAP);

/**
 * Parses a serialized memory. Anything malformed — bad JSON, the wrong
 * version, the wrong shape, a negative or non-integer count, a heatmap of
 * the wrong length — returns null, and the caller starts fresh. A save
 * file is user data; it is never trusted.
 */
export function parseMemory(text: string): RebounderMemory | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['v'] !== MEMORY_VERSION || !isInt(o['seed']) || !isInt(o['makes']) || !isInt(o['misses'])) return null;
  if (!isHeat(o['miss']) || !isHeat(o['shot'])) return null;
  return { version: 1, seed: o['seed'] as number, makes: o['makes'] as number, misses: o['misses'] as number, missHeat: [...(o['miss'] as number[])], shotHeat: [...(o['shot'] as number[])] };
}
