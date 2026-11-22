import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { mountPhoto } from '../src/photo/player.js';
import type { FrameExtra, WorldViewer } from '../src/viewer.js';
import { open } from './helpers.js';

const g = globalThis as unknown as Record<string, unknown>;
g.self ??= globalThis;
g.createImageBitmap = async () => ({ width: 1024, height: 1536, close() {} });

const load = async (name: string) => open(new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../examples/photo/${name}.wgif`, import.meta.url)))));

/** Just enough of the viewer for mountPhoto: the world, `attach`, a texture upload hook and the quality step. */
function fakeViewer(root: THREE.Group, level = 0) {
  const extras: FrameExtra[] = [];
  const viewer = { worldRoot: root, attach: (e: FrameExtra) => extras.push(e), renderer: { initTexture() {} }, qualityLevel: level } as unknown as WorldViewer;
  return { viewer, extras };
}

describe('the photo player draws the picture cheaply', () => {
  it('shows a still picture on an unlit twin of its material, outside the shadow pass, and gives the lit one back', async () => {
    const w = await load('street-3d');
    const photo = w.scene.getObjectByName('photo') as THREE.Mesh;
    const lit = photo.material as THREE.MeshStandardMaterial;
    const picture = lit.emissiveMap;
    expect(picture).toBeTruthy();
    const floor = w.scene.getObjectByName('floor') as THREE.Mesh;
    const { viewer, extras } = fakeViewer(w.scene);
    await mountPhoto(viewer, w.doc.interactions.photos[0]!, null, () => {});
    const basic = photo.material as THREE.MeshBasicMaterial;
    expect(basic.isMeshBasicMaterial).toBe(true);
    expect(basic.map).toBe(picture);
    expect(basic.toneMapped).toBe(false);
    expect(basic.side).toBe(lit.side);
    expect(photo.castShadow || photo.receiveShadow).toBe(false);
    expect((floor.material as THREE.Material).type).toBe('MeshBasicMaterial');
    // The back plate keeps its dim factor.
    const back = w.scene.getObjectByName('photo_back') as THREE.Mesh;
    expect((back.material as THREE.MeshBasicMaterial).color.r).toBeCloseTo(0.32, 2);
    // A still has nothing to do per frame.
    expect(extras[0]!.update(0.016)).toBe(false);
    extras[0]!.dispose();
    expect(photo.material).toBe(lit);
    expect((floor.material as THREE.Material).type).toBe('MeshStandardMaterial');
  });

  it('plays a GIF from the sheet, drawing only when the frame changes once the cross-fade is off', async () => {
    const w = await load('bounce-3d');
    const def = w.doc.interactions.photos[0]!;
    const f = def.frames!;
    const sheet = w.doc.world.files[f.file]!;
    const photo = w.scene.getObjectByName('photo') as THREE.Mesh;
    const { viewer, extras } = fakeViewer(w.scene, 3);
    const mounted = await mountPhoto(viewer, def, sheet, () => {});
    expect(mounted.frames).toBe(f.count);
    const extra = extras[0]!;
    const tex = (photo.material as THREE.MeshBasicMaterial).map!;
    // Cell 0 is inset by half a texel, so neighbours never bleed in.
    expect(tex.offset.x).toBeCloseTo(0.5 / 1024, 6);
    expect(tex.repeat.x).toBeCloseTo(1 / f.columns - 1 / 1024, 6);
    expect(extra.update(0.02)).toBe(false);
    expect(mounted.frame).toBe(0);
    expect(extra.update(0.06)).toBe(true); // 80 ms in: frame 1 (70 ms each)
    expect(mounted.frame).toBe(1);
    expect(tex.offset.x).toBeCloseTo(1 / f.columns + 0.5 / 1024, 6);
    expect(extra.update(0.005)).toBe(false);
    extra.dispose();
  });

  it('cross-fades between frames while the device keeps up, so a 14 fps GIF moves smoothly', async () => {
    const w = await load('bounce-3d');
    const def = w.doc.interactions.photos[0]!;
    const { viewer, extras } = fakeViewer(w.scene, 0);
    await mountPhoto(viewer, def, w.doc.world.files[def.frames!.file]!, () => {});
    const extra = extras[0]!;
    expect(extra.update(0.016)).toBe(true);
    expect(extra.update(0.016)).toBe(true); // the mix moved, so there is something new to draw
    extra.dispose();
  });
});
