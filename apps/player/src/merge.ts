import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Dee's fix #1 (docs/PERF.md): merge everything that never moves, so a world costs a handful of
 * draw calls instead of one per mesh.
 *
 * Meshes merge when they share how they are drawn: same material, or plain untextured
 * MeshStandardMaterials that differ only in colour, roughness and metalness. Those three then
 * travel per vertex (a vertex colour plus two small attributes read by a patched shader), so the
 * merged world looks exactly as authored. Textured materials only merge with meshes that use the
 * very same material. Nodes named in `keep` (moving things, triggers that light up) are left alone.
 *
 * Runs before the first frame, after colliders were built from the original nodes. Merged meshes
 * lose per-object frustum culling, which does not matter at the scale of one court.
 */
export interface MergeStats {
  /** Static meshes before and after. */
  before: number;
  after: number;
}

const TEXTURE_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap'] as const;

/** What has to match for two plain standard materials to become one, apart from colour, roughness and metalness. */
function plainKey(m: THREE.Material): string | null {
  if (!(m instanceof THREE.MeshStandardMaterial) || m instanceof THREE.MeshPhysicalMaterial) return null;
  if (TEXTURE_KEYS.some((k) => (m as unknown as Record<string, unknown>)[k])) return null;
  if (m.vertexColors || m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return null;
  return ['plain', m.transparent, m.opacity, m.side, m.emissive.getHex(), m.emissiveIntensity, m.flatShading, m.alphaTest, m.depthWrite, m.depthTest, m.blending, m.fog, m.wireframe, m.envMapIntensity].join('|');
}

function attributeKey(g: THREE.BufferGeometry, plain: boolean): string {
  return Object.keys(g.attributes).filter((name) => !plain || name === 'position' || name === 'normal').sort().map((name) => `${name}:${g.attributes[name]!.itemSize}`).join(',');
}

function mergeable(mesh: THREE.Mesh): boolean {
  const g = mesh.geometry;
  return (
    !Array.isArray(mesh.material) &&
    !(mesh as THREE.InstancedMesh).isInstancedMesh &&
    !(mesh as THREE.SkinnedMesh).isSkinnedMesh &&
    !!g.attributes.position &&
    // With a single material three draws the whole geometry and ignores its groups; a draw range is not ignored.
    g.drawRange.start === 0 &&
    g.drawRange.count === Infinity &&
    Object.keys(g.morphAttributes).length === 0
  );
}

/**
 * A world-space float copy of a mesh's geometry. Quantized attributes are widened first, or the
 * transform would clip them. An untextured material only needs positions and normals.
 */
function worldGeometry(mesh: THREE.Mesh, plain: boolean): THREE.BufferGeometry {
  const src = mesh.geometry;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    if (plain && name !== 'position' && name !== 'normal') continue;
    const a = attr as THREE.BufferAttribute;
    const data = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) data[i * a.itemSize + k] = a.getComponent(i, k);
    out.setAttribute(name, new THREE.BufferAttribute(data, a.itemSize));
  }
  const count = src.attributes.position!.count;
  const index = src.index ? Array.from(src.index.array) : Array.from({ length: count }, (_, i) => i);
  // A mirrored node turns its triangles inside out; flip them back so they still face the camera.
  if (mesh.matrixWorld.determinant() < 0) for (let i = 0; i + 2 < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2]!, index[i + 1]!];
  out.setIndex(index);
  out.applyMatrix4(mesh.matrixWorld);
  return out;
}

function fill(geometry: THREE.BufferGeometry, name: string, values: number[]): void {
  const count = geometry.attributes.position!.count;
  const data = new Float32Array(count * values.length);
  for (let i = 0; i < count; i++) data.set(values, i * values.length);
  geometry.setAttribute(name, new THREE.BufferAttribute(data, values.length));
}

/** A standard material that reads roughness and metalness from the vertices instead of uniforms. */
export function perVertexPbr(base: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const material = base.clone();
  material.name = 'wgif-merged';
  material.vertexColors = true;
  material.color.set(0xffffff);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float wgifRoughness;\nattribute float wgifMetalness;\nvarying float vWgifRoughness;\nvarying float vWgifMetalness;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvWgifRoughness = wgifRoughness;\n\tvWgifMetalness = wgifMetalness;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWgifRoughness;\nvarying float vWgifMetalness;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vWgifRoughness;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vWgifMetalness;');
  };
  material.customProgramCacheKey = () => 'wgif-per-vertex-pbr';
  return material;
}

/** Merges the static meshes under `root` in place. */
export function mergeStatic(root: THREE.Object3D, keep: (object: THREE.Object3D) => boolean): MergeStats {
  root.updateWorldMatrix(true, true);
  const toRoot = root.matrixWorld.clone().invert();
  const replaced = new Set<THREE.Material>();
  const groups = new Map<string, THREE.Mesh[]>();
  let before = 0;
  const visit = (object: THREE.Object3D): void => {
    if (keep(object)) return; // a kept node keeps its whole subtree
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      before++;
      if (mergeable(mesh)) {
        const material = mesh.material as THREE.Material;
        const how = plainKey(material) ?? `material:${material.uuid}`;
        const key = `${how}|${mesh.castShadow}|${mesh.receiveShadow}|${attributeKey(mesh.geometry, plainKey(material) !== null)}`;
        groups.set(key, [...(groups.get(key) ?? []), mesh]);
      }
    }
    for (const child of object.children) visit(child);
  };
  visit(root);

  let after = before;
  for (const [key, meshes] of groups) {
    if (meshes.length < 2) continue;
    const plain = key.startsWith('plain|');
    const materials = meshes.map((m) => m.material as THREE.MeshStandardMaterial);
    const sameLook = materials.every((m) => m === materials[0] || (m.color.equals(materials[0]!.color) && m.roughness === materials[0]!.roughness && m.metalness === materials[0]!.metalness));
    const geometries = meshes.map((mesh, i) => {
      const g = worldGeometry(mesh, plain);
      if (plain && !sameLook) {
        const m = materials[i]!;
        fill(g, 'color', [m.color.r, m.color.g, m.color.b]);
        fill(g, 'wgifRoughness', [m.roughness]);
        fill(g, 'wgifMetalness', [m.metalness]);
      }
      return g;
    });
    const merged = mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    if (!merged) continue;
    const material = plain && !sameLook ? perVertexPbr(materials[0]!) : materials[0]!;
    merged.applyMatrix4(toRoot); // it hangs under root, so undo root's own transform
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = 'wgif-merged';
    mesh.userData = { wgif: { merged: meshes.map((m) => m.name) } };
    mesh.castShadow = meshes[0]!.castShadow;
    mesh.receiveShadow = meshes[0]!.receiveShadow;
    root.add(mesh);
    for (const m of meshes) {
      m.removeFromParent();
      m.geometry.dispose();
      replaced.add(m.material as THREE.Material);
    }
    after -= meshes.length - 1;
  }
  // Free the materials nothing draws with any more.
  root.traverse((o) => {
    const material = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).material : null;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) replaced.delete(m);
  });
  for (const m of replaced) m.dispose();
  return { before, after };
}
