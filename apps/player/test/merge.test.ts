import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mergeStatic } from '../src/merge.js';
import { findNodes, nodeName } from '../src/sceneBridge.js';
import { open } from './helpers.js';

const meshes = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => (o as THREE.Mesh).isMesh && out.push(o as THREE.Mesh));
  return out;
};
const box = (root: THREE.Object3D): number[] => new THREE.Box3().setFromObject(root).min.toArray().concat(new THREE.Box3().setFromObject(root).max.toArray()).map((v) => +v.toFixed(4));
const triangles = (root: THREE.Object3D): number => meshes(root).reduce((n, m) => n + (m.geometry.index?.count ?? m.geometry.attributes.position!.count) / 3, 0);

describe('static merge (PERF.md fix #1)', () => {
  it('collapses the court from 12 meshes to 5 draw calls without moving anything', async () => {
    const { scene } = await open();
    const keep = new Set(['ball', 'rim_home', 'rim_away']);
    const extentBefore = box(scene), trianglesBefore = triangles(scene);
    expect(meshes(scene)).toHaveLength(12);
    const stats = mergeStatic(scene, (o) => keep.has(nodeName(o)));
    expect(stats).toEqual({ before: 9, after: 2 });
    // ball + two rims kept, everything opaque in one mesh, both glass backboards in another.
    expect(meshes(scene)).toHaveLength(5);
    for (const name of keep) expect(findNodes(scene, name)).toHaveLength(1);
    expect(box(scene)).toEqual(extentBefore);
    expect(triangles(scene)).toBe(trianglesBefore);
  });

  it('keeps each surface its own colour, roughness and metalness, per vertex', async () => {
    const { scene } = await open();
    mergeStatic(scene, (o) => ['ball', 'rim_home', 'rim_away'].includes(nodeName(o)));
    const opaque = meshes(scene).find((m) => m.name === 'wgif-merged' && !(m.material as THREE.Material).transparent)!;
    const material = opaque.material as THREE.MeshStandardMaterial;
    expect(material.vertexColors).toBe(true);
    expect(material.customProgramCacheKey()).toBe('wgif-per-vertex-pbr');
    expect(opaque.userData.wgif.merged.sort()).toEqual(['bleachers', 'court_keys', 'court_lines', 'floor_apron', 'floor_court', 'hoop_away_support', 'hoop_home_support']);
    const g = opaque.geometry;
    const roughness = new Set(Array.from(g.getAttribute('wgifRoughness').array as Float32Array).map((v) => +v.toFixed(2)));
    const metalness = new Set(Array.from(g.getAttribute('wgifMetalness').array as Float32Array).map((v) => +v.toFixed(2)));
    expect([...roughness].sort()).toEqual([0.4, 0.5, 0.6, 0.7, 0.9]);
    expect([...metalness].sort()).toEqual([0, 0.8]);
    // The glass shares one material, so it merges as it is: no per-vertex attributes needed.
    const glass = meshes(scene).find((m) => (m.material as THREE.Material).transparent)!;
    expect(glass.geometry.getAttribute('wgifRoughness')).toBeUndefined();
    expect((glass.material as THREE.MeshStandardMaterial).opacity).toBe(0.45);
  });

  it('handles mirrored and transformed nodes, and leaves lone meshes alone', () => {
    const root = new THREE.Group();
    root.position.set(10, 0, 0);
    const material = new THREE.MeshStandardMaterial({ color: 0x336699 });
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    b.position.set(0, 2, 0);
    b.scale.set(-1, 1, 1); // mirrored
    const lone = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshPhysicalMaterial());
    root.add(a, b, lone);
    const extent = box(root);
    const stats = mergeStatic(root, () => false);
    expect(stats).toEqual({ before: 3, after: 2 });
    expect(box(root)).toEqual(extent);
    // The mirrored box still faces outwards: its +x face normal points along +x in world space.
    const merged = meshes(root).find((m) => m.name === 'wgif-merged')!;
    const pos = merged.geometry.getAttribute('position'), idx = merged.geometry.index!;
    const v = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, idx.getX(i));
    let outward = 0;
    for (let t = 0; t < idx.count; t += 3) {
      const n = new THREE.Vector3().subVectors(v(t + 1), v(t)).cross(new THREE.Vector3().subVectors(v(t + 2), v(t)));
      const centre = v(t).add(v(t + 1)).add(v(t + 2)).divideScalar(3).sub(new THREE.Vector3(0, centreY(v(t).y), 0));
      if (n.dot(centre) > 0) outward++;
    }
    expect(outward).toBe(idx.count / 3);
    expect(meshes(root)).toContain(lone);
  });
});

/** Centre height of whichever box a vertex belongs to (box a at y 0, box b at y 2), in root space. */
function centreY(y: number): number {
  return y > 1 ? 2 : 0;
}
