import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { isSky, sceneBounds } from '../src/sky.js';
import { open, run } from './helpers.js';

// Node has no image decoding. These worlds carry JPEG/PNG textures inside their GLB, so give
// GLTFLoader just enough of the browser (self + createImageBitmap) to load them as 1x1 bitmaps.
// Geometry, colliders and the simulation are what these tests check; pixels are checked by the
// headless-browser test (e2e/sample-worlds.e2e.mjs).
const g = globalThis as unknown as Record<string, unknown>;
g.self ??= globalThis;
g.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

/** The extra sample worlds from examples/worlds (gallery, rooftop, city), opened the way the player does. */
const sample = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../examples/worlds/${name}.wgif`, import.meta.url))));

describe('sample worlds open and run in the player', () => {
  it.each(['gallery', 'rooftop', 'city', 'car', 'music'])('%s opens with no warnings and settles', async (name) => {
    const w = await open(sample(name));
    expect(w.doc.warnings).toEqual([]);
    expect(w.built.warnings).toEqual([]);
    expect(w.built.solid.length).toBeGreaterThan(0);
    // The walker stands on the floor at the spawn, inside the bounds, after a second of physics.
    run(w.runtime, 1);
    const feet = w.runtime.player.feet;
    expect(feet[1]).toBeGreaterThan(-0.05);
    expect(feet[1]).toBeLessThan(0.3);
    for (const o of w.runtime.objects.values()) expect(Number.isFinite(o.body.pos[1])).toBe(true);
  });

  it('gallery is locked, so it cannot be exported as an edit', async () => {
    const w = await open(sample('gallery'));
    expect(w.doc.world.manifest.mode).toBe('locked');
    expect(w.doc.policy).toEqual({ canEdit: false, via: null });
    expect([...w.runtime.objects.keys()]).toEqual(['orb']);
  });

  it('rooftop runs its one-hoop Shootout and keeps the 360° sky out of the world bounds', async () => {
    const w = await open(sample('rooftop'));
    expect(w.runtime.shootout?.id).toBe('rooftop-shootout');
    expect(w.runtime.shootout?.rules.durationSec).toBe(45);
    expect(w.runtime.startShootout()).toBe(true);
    run(w.runtime, 4);
    expect(['playing', 'overtime']).toContain(w.runtime.shootout?.phase);
    const sky = w.scene.getObjectByName('sky_rooftop_night');
    expect(sky && isSky(sky)).toBe(true);
    const size = sceneBounds(w.scene).getSize(new THREE.Vector3());
    expect(size.x).toBeLessThan(30); // the deck, not the 300 m sky sphere
    expect(new THREE.Box3().setFromObject(w.scene).getSize(new THREE.Vector3()).x).toBeGreaterThan(250);
  });

  it('city applies its three layers on top of the signed base', async () => {
    const w = await open(sample('city'));
    expect(w.doc.world.report.signature).toBe('valid');
    expect(w.doc.layers.map((l) => [l.id, l.ok])).toEqual([['neon-signs', true], ['drone-swarm', true], ['remix', true]]);
    expect(w.scene.getObjectByName('sign_0')).toBeTruthy();
    expect(w.scene.getObjectByName('drone_0')).toBeTruthy();
    expect(w.scene.getObjectByName('tower_00_00')).toBeUndefined();
    expect(w.runtime.objects.size).toBe(12);
  });
});
