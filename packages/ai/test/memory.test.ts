import { describe, expect, it } from 'vitest';
import {
  cellCenter,
  cellFor,
  createMemory,
  favoriteSpot,
  learnedHome,
  makeRate,
  MEMORY_GRID,
  parseMemory,
  recordShot,
  serializeMemory,
  type CourtBounds,
} from '../src/memory.js';

/** The court's playable bounds (the rebounder rules file's `court.bounds`). */
const BOUNDS: CourtBounds = { min: [-17, 0, -10], max: [17, 0, 10] };
const HOME: [number, number, number] = [0, 0, 6];

describe('rebounder memory (WGIF Memory, SPEC §10 DRAFT)', () => {
  it('starts empty and records makes, misses and where they happened', () => {
    let mem = createMemory(7);
    expect(mem.makes).toBe(0);
    expect(mem.misses).toBe(0);
    expect(makeRate(mem)).toBe(0);
    expect(favoriteSpot(mem, BOUNDS)).toBeNull();
    expect(learnedHome(mem, HOME, BOUNDS)).toEqual(HOME);

    // A make from the free-throw line, a miss that lands in the far corner.
    mem = recordShot(mem, 'make', [8.2, 1.7, 0], null, BOUNDS);
    mem = recordShot(mem, 'miss', [8.2, 1.7, 0], [-15, 0.12, -8], BOUNDS);
    expect(mem.makes).toBe(1);
    expect(mem.misses).toBe(1);
    expect(makeRate(mem)).toBe(0.5);
    // The favourite spot is the free-throw line (both shots came from there):
    // within half a cell of it (a cell is 8.5 x 5 m here).
    const fav = favoriteSpot(mem, BOUNDS);
    expect(fav).not.toBeNull();
    expect(Math.abs(fav![0] - 8.2)).toBeLessThanOrEqual((BOUNDS.max[0] - BOUNDS.min[0]) / MEMORY_GRID / 2);
    expect(Math.abs(fav![2] - 0)).toBeLessThanOrEqual((BOUNDS.max[2] - BOUNDS.min[2]) / MEMORY_GRID / 2);
    // The miss landed in the far corner, so the learned home has moved that way.
    const home = learnedHome(mem, HOME, BOUNDS);
    expect(home[0]).toBeLessThan(HOME[0]);
    expect(home[2]).toBeLessThan(HOME[2]);
    expect(home[0]).toBeGreaterThan(-17);
    expect(home[2]).toBeGreaterThan(-10);
  });

  it('recordShot does not mutate its input', () => {
    const mem = createMemory(7);
    const next = recordShot(mem, 'miss', [0, 0, 0], [1, 0, 1], BOUNDS);
    expect(mem.misses).toBe(0);
    expect(next.misses).toBe(1);
  });

  it('the learned home blends toward the miss centroid, never past halfway, and never leaves the court', () => {
    let mem = createMemory(7);
    // Twenty misses, all landing in the same far corner.
    for (let i = 0; i < 20; i++) mem = recordShot(mem, 'miss', [8.2, 1.7, 0], [-15, 0.12, -8], BOUNDS);
    const home = learnedHome(mem, HOME, BOUNDS);
    const cell = cellCenter(cellFor([-15, 0.12, -8], BOUNDS), BOUNDS);
    // Bias is 0.5 after 20 misses: halfway from the declared home to the centroid.
    expect(home[0]).toBeCloseTo((HOME[0] + cell[0]) / 2, 9);
    expect(home[2]).toBeCloseTo((HOME[2] + cell[2]) / 2, 9);
    // More misses do not push it further.
    for (let i = 0; i < 20; i++) mem = recordShot(mem, 'miss', [8.2, 1.7, 0], [-15, 0.12, -8], BOUNDS);
    const home2 = learnedHome(mem, HOME, BOUNDS);
    expect(home2[0]).toBeCloseTo(home[0], 9);
    expect(home2[2]).toBeCloseTo(home[2], 9);
  });

  it('serializes to a few hundred bytes and round-trips exactly', () => {
    let mem = createMemory(7);
    mem = recordShot(mem, 'make', [8.2, 1.7, 0], null, BOUNDS);
    mem = recordShot(mem, 'miss', [8.2, 1.7, 0], [-15, 0.12, -8], BOUNDS);
    mem = recordShot(mem, 'miss', [-8, 1.7, 3], [12, 0.12, 7], BOUNDS);
    const text = serializeMemory(mem);
    expect(text.length).toBeLessThan(512);
    expect(parseMemory(text)).toEqual(mem);
  });

  it('parseMemory rejects anything malformed, and the NPC starts fresh', () => {
    let mem = createMemory(7);
    mem = recordShot(mem, 'miss', [0, 0, 0], [1, 0, 1], BOUNDS);
    const good = serializeMemory(mem);
    expect(parseMemory(good)).toEqual(mem);
    expect(parseMemory('not json')).toBeNull();
    expect(parseMemory('')).toBeNull();
    expect(parseMemory('[]')).toBeNull();
    expect(parseMemory(JSON.stringify({ ...JSON.parse(good) as object, v: 2 }))).toBeNull();
    expect(parseMemory(JSON.stringify({ ...JSON.parse(good) as object, v: 1, misses: -1 }))).toBeNull();
    expect(parseMemory(JSON.stringify({ ...JSON.parse(good) as object, v: 1, misses: 1.5 }))).toBeNull();
    expect(parseMemory(JSON.stringify({ ...JSON.parse(good) as object, v: 1, miss: [1, 2, 3] }))).toBeNull();
    expect(parseMemory(JSON.stringify({ ...JSON.parse(good) as object, v: 1, miss: new Array(16).fill(256) }))).toBeNull();
    expect(parseMemory(JSON.stringify({ ...JSON.parse(good) as object, v: 1, shot: 'hot' }))).toBeNull();
  });

  it('cell counts decay when a cell passes the cap, so old misses fade', () => {
    let mem = createMemory(7);
    // 256 misses in one cell: the 256th pushes the cell over the cap and halves everything.
    for (let i = 0; i < 256; i++) mem = recordShot(mem, 'miss', [0, 0, 0], [1, 0, 1], BOUNDS);
    const cell = cellFor([1, 0, 1], BOUNDS);
    expect(mem.missHeat[cell]).toBeLessThanOrEqual(255);
    expect(mem.missHeat[cell]).toBeGreaterThan(0);
    expect(mem.missHeat.reduce((a, b) => a + b, 0)).toBeLessThan(256);
  });
});
