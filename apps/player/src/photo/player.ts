/**
 * The `photo` component at play time: shows the picture at its own colours (no tone mapping) and,
 * for a GIF, runs its frames from the sprite sheet on the mesh (a flipbook). A separate chunk,
 * loaded only for worlds that have a photo entry.
 */
import * as THREE from 'three';
import type { PhotoDef } from '../interactions.js';
import type { FrameExtra, WorldViewer } from '../viewer.js';

type Mat = THREE.MeshStandardMaterial;

function materialsOf(root: THREE.Object3D, names: string[]): Mat[] {
  const out = new Set<Mat>();
  for (const name of names) {
    root.getObjectByName(name)?.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) out.add(mat as Mat);
    });
  }
  return [...out];
}

export interface MountedPhoto {
  frames: number;
  /** Frame on screen now (for tests). */
  readonly frame: number;
}

export async function mountPhoto(viewer: WorldViewer, def: PhotoDef, sheetBytes: Uint8Array | null, warn: (m: string) => void): Promise<MountedPhoto> {
  const root = viewer.worldRoot;
  const state = { frame: 0 };
  const mounted: MountedPhoto = { frames: 1, get frame() { return state.frame; } };
  if (!root) return mounted;
  const mats = materialsOf(root, [def.node, ...def.alsoNodes]);
  if (mats.length === 0) {
    warn(`photo "${def.id}": node "${def.node}" is not in the scene`);
    return mounted;
  }
  for (const m of mats) {
    m.toneMapped = false;
    m.needsUpdate = true;
  }
  const f = def.frames;
  if (!f || !sheetBytes) {
    if (f && !sheetBytes) warn(`photo "${def.id}": ${f.file} is not in the world, shown still`);
    return mounted;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([sheetBytes as Uint8Array<ArrayBuffer>]), { imageOrientation: 'none', premultiplyAlpha: 'none' });
  } catch {
    warn(`photo "${def.id}": the frame sheet could not be read, shown still`);
    return mounted;
  }
  if (viewer.worldRoot !== root) {
    bitmap.close();
    return mounted; // another world opened meanwhile
  }
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false; // glTF convention, like the mesh's own texture
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false; // mipmaps would bleed neighbouring frames together
  tex.minFilter = THREE.LinearFilter;
  tex.repeat.set(1 / f.columns, 1 / f.rows);
  tex.needsUpdate = true;
  const show = (i: number): void => {
    state.frame = i;
    tex.offset.set((i % f.columns) / f.columns, Math.floor(i / f.columns) / f.rows);
  };
  show(0);
  const originals = mats.map((m) => ({ m, map: m.map, emissiveMap: m.emissiveMap }));
  for (const m of mats) {
    if (m.emissiveMap) m.emissiveMap = tex;
    if (m.map) m.map = tex;
    m.needsUpdate = true;
  }
  mounted.frames = f.count;
  let t = 0;
  const total = f.delaysMs.reduce((s, d) => s + d, 0);
  const extra: FrameExtra = {
    update(dt) {
      t = (t + dt * 1000) % total;
      let acc = 0, i = 0;
      while (i < f.count - 1 && acc + f.delaysMs[i]! <= t) acc += f.delaysMs[i++]!;
      if (i !== state.frame) show(i);
      return true;
    },
    dispose() {
      for (const o of originals) {
        o.m.map = o.map;
        o.m.emissiveMap = o.emissiveMap;
      }
      tex.dispose();
      bitmap.close();
    },
  };
  viewer.attach(extra);
  return mounted;
}
