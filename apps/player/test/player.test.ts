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
    // Corrupt one hex digit of the first sha256 in the manifest itself: the
    // manifest still parses, but the hash no longer matches the file, so
    // validation must reject it. (Flipping a byte near the end of the archive
    // used to work, but that lands in the ZIP central directory, which the
    // reader tolerates — and its position shifts as files are added.)
    const broken = court.slice();
    const text = new TextDecoder().decode(broken);
    const at = text.indexOf('"sha256": "') + '"sha256": "'.length;
    expect(at).toBeGreaterThan(0);
    broken[at] = broken[at] === 0x30 ? 0x31 : 0x30; // '0' <-> '1'
    await expect(openWorld(broken)).rejects.toThrow();
  });
});
