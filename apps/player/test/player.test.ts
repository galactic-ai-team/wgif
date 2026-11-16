import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { parseGlb } from '../src/viewer.js';
import { cameraHints, openWorld } from '../src/world.js';

const court = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../examples/court/court.wgif', import.meta.url))));

describe('player pipeline (headless)', () => {
  it('opens the sample court and parses its GLB into a scene graph', async () => {
    const world = await openWorld(court);
    const hints = cameraHints(world);
    expect(hints.eyeHeight).toBe(1.7);
    expect(hints.bounds?.max[0]).toBe(17);
    const group = await parseGlb(world.files[world.manifest.entry.scene]!);
    const names: string[] = [];
    group.traverse((o) => o.name && names.push(o.name));
    expect(names).toEqual(expect.arrayContaining(['floor_court', 'rim_home', 'rim_away', 'ball']));
    const box = new THREE.Box3().setFromObject(group);
    expect(box.max.x - box.min.x).toBeGreaterThan(28);
  });

  it('rejects a corrupted file with a readable error', async () => {
    const broken = court.slice();
    const i = broken.length - 200;
    broken[i] = (broken[i] ?? 0) ^ 0xff;
    await expect(openWorld(broken)).rejects.toThrow();
  });
});
