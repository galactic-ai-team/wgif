import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyEdits, parseLayer } from '../src/edit.js';
import { findNodes } from '../src/sceneBridge.js';
import { LAYER_SOLID, newContact } from '../src/sim/colliders.js';
import { describeMode, describeTrust, openWorld } from '../src/world.js';
import { courtBytes, open, run } from './helpers.js';
import { courtVariant } from './worlds.js';

describe('creator modes', () => {
  it('editable: edits rewrite the base; an unsigned file says anyone could have changed it', async () => {
    const { doc } = await open();
    expect(doc.world.manifest.mode).toBe('editable');
    expect(doc.policy).toEqual({ canEdit: true, via: 'base' });
    expect(describeMode(doc)).toMatch(/^Editable/);
    expect(describeTrust(doc.world)).toMatchObject({ label: 'unsigned', tone: 'absent' });
    expect(describeTrust(doc.world).detail).toMatch(/anyone could have made or changed/);
  });

  it('locked: nothing can be edited, and an unsigned lock says it cannot be checked', async () => {
    const { doc } = await open(await courtVariant({ mode: 'locked' }));
    expect(doc.policy).toEqual({ canEdit: false, via: null });
    expect(describeMode(doc)).toMatch(/^Locked/);
    expect(describeTrust(doc.world)).toMatchObject({ label: 'unsigned · unverified', tone: 'absent' });
    expect(doc.world.report.warnings.map((w) => w.code)).toContain('signature.absent');
  });

  it('locked and signed: says the signature is valid, and what that does and does not prove', async () => {
    const { doc } = await open(await courtVariant({ mode: 'locked', sign: true }));
    const trust = describeTrust(doc.world);
    expect(doc.world.report.signature).toBe('valid');
    expect(trust).toMatchObject({ label: 'signature valid', tone: 'valid' });
    expect(trust.detail).toContain(doc.world.manifest.signature!.publicKey.slice(0, 12));
    expect(trust.detail).toMatch(/not who "Galactic AI Team" is/);
    expect(doc.policy.canEdit).toBe(false);
  });

  it('a tampered copy is shown as invalid, never as verified', async () => {
    const { doc } = await open(await courtVariant({ mode: 'locked', sign: true, tamper: true }));
    expect(doc.world.report.signature).toBe('invalid');
    expect(describeTrust(doc.world)).toMatchObject({ label: 'signature invalid', tone: 'invalid' });
    expect(describeTrust(doc.world).detail).toMatch(/origin as unknown/);
  });

  it('layered: edits become layers, and a signed base stays valid under them', async () => {
    const bytes = await courtVariant({ mode: 'layered', sign: true, layers: [{ id: 'l1', body: { version: '0.1', add: [{ id: 'crate', primitive: 'box', position: [0, 0.5, 3] }] } }] });
    const { doc } = await open(bytes);
    expect(doc.policy).toEqual({ canEdit: true, via: 'layer' });
    expect(describeMode(doc)).toMatch(/^Layered/);
    expect(doc.world.report.signature).toBe('valid');
    expect(describeTrust(doc.world).detail).toMatch(/Layers added since are not covered/);
    expect(doc.layers).toMatchObject([{ id: 'l1', author: 'tester', ok: true }]);
  });

  it('refuses a world that needs features this player lacks, and keeps its preview to show', async () => {
    const bytes = await courtVariant({ requires: ['scene.glb', 'runtime.onnx', 'gltf.ext-meshopt-compression'] });
    const error = await openWorld(bytes).catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'This world requires unsupported player features', details: ['requires: runtime.onnx', 'requires: gltf.ext-meshopt-compression'] });
    expect((error as { preview?: { mediaType: string; bytes: Uint8Array } }).preview?.mediaType).toBe('image/png');
    expect((error as { preview?: { bytes: Uint8Array } }).preview?.bytes.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it('opens a world that requires the minigame and layers, now that the player has them', async () => {
    const bytes = await courtVariant({ requires: ['scene.glb', 'runtime.rules', 'interaction.grab', 'interaction.trigger', 'minigame.basketball-shooting', 'state.initial', 'layer.primitives'] });
    await expect(openWorld(bytes)).resolves.toBeTruthy();
  });
});

describe('layers', () => {
  it('reads layer files tolerantly: bad operations are skipped and counted', () => {
    const { layer, skipped, ok } = parseLayer({
      version: '0.1',
      add: [{ id: 'a', primitive: 'box', position: [0, 1, 0], size: [1, 2, 3], color: '#ff0000' }, { id: 'b', primitive: 'cone', position: [0, 0, 0] }, { id: 'c', primitive: 'sphere', position: [0, 0, 'x'] }],
      move: [{ id: 'ball', position: [1, 2, 3], rotation: [0, 0, 0, 1] }, { id: 'x' }],
      remove: ['bleachers', 'bad id!'],
    });
    expect(ok).toBe(true);
    expect(skipped).toBe(4);
    expect(layer.add).toEqual([{ id: 'a', primitive: 'box', position: [0, 1, 0], size: [1, 2, 3], color: '#ff0000' }]);
    expect(layer.move).toEqual([{ id: 'ball', position: [1, 2, 3], rotation: [0, 0, 0, 1] }]);
    expect(layer.remove).toEqual(['bleachers']);
    expect(parseLayer('nope').ok).toBe(false);
  });

  it('applies remove, then add, then move, and resolves ids to objects before nodes', () => {
    const interactions = {
      objects: [
        { id: 'ball', node: 'ball', kind: 'grabbable', spawn: [9, 0.12, 1.2] },
        { id: 'rim_home', node: 'rim_home', kind: 'trigger', shape: { type: 'cylinder', center: [12.425, 3.05, 0], radius: 0.225, height: 0.1 } },
      ],
    };
    const r = applyEdits(interactions, [
      { op: 'remove', id: 'bleachers' },
      { op: 'add', id: 'crate', primitive: 'box', position: [0, 0.5, 3] },
      { op: 'add', id: 'crate', primitive: 'sphere', position: [1, 1, 1] },
      { op: 'move', id: 'ball', position: [2, 0.12, 2] },
      { op: 'move', id: 'rim_home', position: [12, 3, 0.5] },
      { op: 'move', id: 'court_lines', position: [0, 0.01, 0] },
    ], 'l1');
    expect(r.warnings).toEqual(['l1: cannot add "crate", that id is already in use']);
    expect(interactions.objects[0]!.spawn).toEqual([9, 0.12, 1.2]); // the input is not changed
    const objects = (r.interactions!.objects as { id: string; spawn?: number[]; shape?: { center: number[] } }[]);
    expect(objects.find((o) => o.id === 'ball')?.spawn).toEqual([2, 0.12, 2]);
    expect(objects.find((o) => o.id === 'rim_home')?.shape?.center).toEqual([12, 3, 0.5]);
    expect(r.sceneOps.map((o) => o.kind)).toEqual(['remove', 'add', 'move', 'move']);
    const rimMove = r.sceneOps[2] as { delta: number[] };
    expect(rimMove.delta.map((v) => +v.toFixed(3))).toEqual([-0.425, -0.05, 0.5]);
    expect([...r.ids].sort()).toEqual(['ball', 'crate', 'rim_home']);
  });

  it('changes the world it is played in: removed things are gone, added ones are solid, moved ones move', async () => {
    const bytes = await courtVariant({
      mode: 'layered',
      layers: [
        { id: 'l1', body: { version: '0.1', remove: ['bleachers'], add: [{ id: 'crate', primitive: 'box', position: [0, 0.5, 4], size: [2, 1, 1] }] } },
        { id: 'l2', body: { version: '0.1', move: [{ id: 'ball', position: [-3, 0.12, 2] }, { id: 'rim_home', position: [12.425, 3.3, 0] }, { id: 'crate', position: [0, 0.5, 5] }] } },
      ],
    });
    const { doc, scene, built, runtime } = await open(bytes);
    expect(doc.warnings).toEqual([]);
    expect(built.warnings).toEqual([]);
    expect(findNodes(scene, 'bleachers')).toHaveLength(0);
    expect(built.solid).not.toContain('bleachers');
    expect(built.solid).toContain('crate');
    // The crate is where the second layer moved it, and it is solid: walking into it stops you.
    const crate = findNodes(scene, 'crate')[0]!;
    expect(crate.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([0, 0.5, 5]);
    const contact = newContact();
    expect(built.colliders.closest(0, 0.5, 5.6, 0.2, LAYER_SOLID, contact)).toBe(true);
    expect(built.colliders.groups[contact.group]?.name).toBe('crate');
    runtime.player.spawn([0, 1.7, 8], [0, 1.7, 0]);
    run(runtime, 2, { forward: 1, right: 0, run: false, charging: false });
    expect(runtime.player.feet[2]).toBeCloseTo(5.5 + runtime.player.radius, 2);
    // The ball starts where the layer put it; the rim trigger moved up with its node.
    expect(runtime.objects.get('ball')!.spawn).toEqual([-3, 0.12, 2]);
    expect(doc.interactions.objects.find((o) => o.id === 'rim_home')).toMatchObject({ shape: { center: [12.425, 3.3, 0] } });
    const rim = findNodes(scene, 'rim_home')[0]!;
    expect(new THREE.Box3().setFromObject(rim).getCenter(new THREE.Vector3()).y).toBeCloseTo(3.3, 2);
  });

  it('skips what it cannot use, with a warning, and still opens', async () => {
    const bytes = await courtVariant({
      mode: 'layered',
      layers: [
        { id: 'l1', body: { version: '0.1', move: [{ id: 'nothing_here', position: [0, 0, 0] }], add: [{ id: 'floor_court', primitive: 'box', position: [0, 0, 0] }] } },
      ],
    });
    const { doc, built } = await open(bytes);
    expect(doc.layers[0]?.ok).toBe(true);
    expect(built.warnings).toEqual(['layer: cannot add "floor_court", a node with that name exists', 'layer: nothing called "nothing_here" to move']);
    expect(built.solid).toContain('floor_court');
  });

  it('ignores layers in a world that is not layered', async () => {
    const { doc } = await open(courtBytes());
    expect(doc.layers).toEqual([]);
    expect(doc.sceneOps).toEqual([]);
  });
});
