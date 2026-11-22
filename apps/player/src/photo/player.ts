/**
 * The `photo` component at play time: shows the picture at its own colours (no tone mapping) and,
 * for a GIF, runs its frames from the sprite sheet on the mesh (a flipbook). A separate chunk,
 * loaded only for worlds that have a photo entry.
 */
import * as THREE from 'three';
import type { PhotoDef } from '../interactions.js';
import type { FrameExtra, WorldViewer } from '../viewer.js';

type Mat = THREE.MeshStandardMaterial;

/** A frame whose delay is at least this long (ms) is cross-faded into the next one; faster GIFs already look continuous. */
const BLEND_MIN_DELAY_MS = 40;
/** From this quality step down (see QualityGovernor) the cross-fade is dropped, so a struggling device draws only when the frame changes. */
const BLEND_MAX_QUALITY_LEVEL = 2;

function meshesOf(root: THREE.Object3D, names: string[]): THREE.Mesh[] {
  const out = new Set<THREE.Mesh>();
  for (const name of names) {
    root.getObjectByName(name)?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.material) out.add(mesh);
    });
  }
  return [...out];
}

/**
 * The picture is drawn as itself, not as a lit surface: the glTF has a black base and the picture as
 * an emissive map (so it keeps its colours in any light), which means all the light, IBL and shadow
 * maths of a standard material produces nothing but cost. A basic (unlit) material with the same
 * texture and factor looks the same and is far cheaper per pixel.
 */
export function unlit(m: THREE.Material): THREE.MeshBasicMaterial | null {
  const s = m as Mat;
  if (!s.isMeshStandardMaterial || !s.emissiveMap) return null;
  const color = s.emissive.clone().multiplyScalar(s.emissiveIntensity);
  return new THREE.MeshBasicMaterial({ name: s.name, map: s.emissiveMap, color, side: s.side, toneMapped: false, fog: false });
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
  const meshes = meshesOf(root, [def.node, ...def.alsoNodes]);
  if (meshes.length === 0) {
    warn(`photo "${def.id}": node "${def.node}" is not in the scene`);
    return mounted;
  }
  // Swap each lit material for an unlit twin (shared between meshes that shared one) and take the
  // picture out of the shadow pass.
  const swaps = new Map<THREE.Material, THREE.MeshBasicMaterial | null>();
  const originals: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[]; cast: boolean; receive: boolean }[] = [];
  const shown: THREE.MeshBasicMaterial[] = [];
  /** Other unlit materials made here, disposed with the rest. */
  const spare: THREE.MeshBasicMaterial[] = [];
  for (const mesh of meshes) {
    originals.push({ mesh, material: mesh.material, cast: mesh.castShadow, receive: mesh.receiveShadow });
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (Array.isArray(mesh.material)) continue;
    const key = mesh.material;
    if (!swaps.has(key)) swaps.set(key, unlit(key));
    const twin = swaps.get(key);
    if (twin) {
      mesh.material = twin;
      if (!shown.includes(twin)) shown.push(twin);
    } else {
      (key as Mat).toneMapped = false;
      key.needsUpdate = true;
    }
  }
  // A 3D picture stands on a dark floor that nothing casts onto: draw it unlit too (same colour, no light maths).
  const floor = root.getObjectByName('floor') as THREE.Mesh | undefined;
  if (floor?.isMesh && meshes.some((m) => m.name === 'photo_back') && !Array.isArray(floor.material)) {
    const lit = floor.material as Mat;
    if (lit.isMeshStandardMaterial && !lit.map && !lit.emissiveMap) {
      originals.push({ mesh: floor, material: lit, cast: floor.castShadow, receive: floor.receiveShadow });
      const flat = new THREE.MeshBasicMaterial({ name: lit.name, color: lit.color.clone().add(lit.emissive), side: lit.side, toneMapped: false, fog: false });
      floor.material = flat;
      floor.castShadow = floor.receiveShadow = false;
      spare.push(flat);
    }
  }
  const restore = (): void => {
    for (const o of originals) {
      o.mesh.material = o.material;
      o.mesh.castShadow = o.cast;
      o.mesh.receiveShadow = o.receive;
    }
  };
  const f = def.frames;
  if (!f || !sheetBytes) {
    if (f && !sheetBytes) warn(`photo "${def.id}": ${f.file} is not in the world, shown still`);
    viewer.attach({ update: () => false, dispose() { restore(); for (const t of [...shown, ...spare]) t.dispose(); } });
    return mounted;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([sheetBytes as Uint8Array<ArrayBuffer>]), { imageOrientation: 'none', premultiplyAlpha: 'none' });
  } catch {
    warn(`photo "${def.id}": the frame sheet could not be read, shown still`);
    viewer.attach({ update: () => false, dispose() { restore(); for (const t of [...shown, ...spare]) t.dispose(); } });
    return mounted;
  }
  if (viewer.worldRoot !== root) {
    bitmap.close();
    restore();
    for (const t of [...shown, ...spare]) t.dispose();
    return mounted; // another world opened meanwhile
  }
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false; // glTF convention, like the mesh's own texture
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false; // mipmaps would bleed neighbouring frames together
  tex.minFilter = THREE.LinearFilter;
  // A cell is inset by half a texel on every side, so linear filtering never reaches into its neighbour.
  const sw = Math.max(1, bitmap.width), sh = Math.max(1, bitmap.height);
  const cellW = 1 / f.columns, cellH = 1 / f.rows;
  tex.repeat.set(cellW - 1 / sw, cellH - 1 / sh);
  const cellX = (i: number): number => (i % f.columns) * cellW + 0.5 / sw;
  const cellY = (i: number): number => Math.floor(i / f.columns) * cellH + 0.5 / sh;
  tex.needsUpdate = true;
  // The next frame is sampled a fixed offset away from this one, and the two are mixed in the shader.
  const blend = { uNext: { value: new THREE.Vector2() }, uMix: { value: 0 } };
  for (const m of shown) {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uNext = blend.uNext;
      shader.uniforms.uMix = blend.uMix;
      shader.fragmentShader = `uniform vec2 uNext;\nuniform float uMix;\n${shader.fragmentShader}`.replace(
        '#include <map_fragment>',
        'vec4 sampledDiffuseColor = mix( texture2D( map, vMapUv ), texture2D( map, vMapUv + uNext ), uMix );\ndiffuseColor *= sampledDiffuseColor;',
      );
    };
    m.customProgramCacheKey = () => 'photo-blend';
    m.map = tex;
    m.needsUpdate = true;
  }
  // Stand-ins that kept the lit material (no emissive map) show the sheet the old way.
  const lit = [...swaps.entries()].filter(([, twin]) => !twin).map(([m]) => m as Mat);
  const litOriginals = lit.map((m) => ({ m, map: m.map, emissiveMap: m.emissiveMap }));
  for (const m of lit) {
    if (m.emissiveMap) m.emissiveMap = tex;
    if (m.map) m.map = tex;
    m.needsUpdate = true;
  }
  const show = (i: number): void => {
    state.frame = i;
    tex.offset.set(cellX(i), cellY(i));
  };
  show(0);
  // Upload the sheet now rather than inside the first animated frame.
  viewer.renderer.initTexture(tex);
  mounted.frames = f.count;
  let t = 0, mixShown = 0;
  const total = f.delaysMs.reduce((s, d) => s + d, 0);
  const extra: FrameExtra = {
    update(dt) {
      t = (t + dt * 1000) % total;
      let acc = 0, i = 0;
      while (i < f.count - 1 && acc + f.delaysMs[i]! <= t) acc += f.delaysMs[i++]!;
      const changed = i !== state.frame;
      if (changed) show(i);
      // Cross-fade into the next frame over this frame's own delay, unless it is already fast or the device is struggling.
      const delay = f.delaysMs[i]!;
      let mix = 0;
      if (delay >= BLEND_MIN_DELAY_MS && viewer.qualityLevel <= BLEND_MAX_QUALITY_LEVEL) {
        const next = (i + 1) % f.count;
        mix = Math.min(1, Math.max(0, (t - acc) / delay));
        blend.uNext.value.set(cellX(next) - cellX(i), cellY(next) - cellY(i));
      }
      const mixChanged = mix !== mixShown;
      blend.uMix.value = mixShown = mix;
      // Nothing to draw between two frames of a GIF that is not being cross-faded.
      return changed || mixChanged;
    },
    dispose() {
      restore();
      for (const o of litOriginals) {
        o.m.map = o.map;
        o.m.emissiveMap = o.emissiveMap;
      }
      for (const m of [...shown, ...spare]) m.dispose();
      tex.dispose();
      bitmap.close();
    },
  };
  viewer.attach(extra);
  return mounted;
}
