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

// The court tests count what the court contains instead of pinning it, so court polish
// (Gemini's markings in PR #14, the hash marks after it) does not break them.
const KEEP = ['ball', 'rim_home', 'rim_away'];
const kept = (o: THREE.Object3D): boolean => KEEP.includes(nodeName(o));
const isGlass = (m: THREE.Mesh): boolean => (m.material as THREE.Material).transparent;
/** The meshes the merge may touch, in the order it visits them: everything outside the kept nodes. */
function statics(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D): void => {
    if (kept(o)) return;
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
    o.children.forEach(visit);
  };
  visit(root);
  return out;
}
/** Colour, roughness and metalness, rounded to float32 the way the merged attributes store them. */
const look = (...values: number[]): string => values.map(Math.fround).join(' ');

describe('static merge (PERF.md fix #1)', () => {
  it('collapses the static court into one opaque and one glass draw call without moving anything', async () => {
    const { scene } = await open();
    const total = meshes(scene).length, before = statics(scene);
    const opaqueNames = before.filter((m) => !isGlass(m)).map((m) => m.name);
    const glassNames = before.filter(isGlass).map((m) => m.name);
    expect(opaqueNames.length).toBeGreaterThan(1);
    expect(glassNames.length).toBeGreaterThan(1);
    const extentBefore = box(scene), trianglesBefore = triangles(scene);
    const stats = mergeStatic(scene, kept);
    expect(stats).toEqual({ before: before.length, after: 2 });
    // The kept ball and rims, everything opaque in one mesh, both glass backboards in another.
    expect(meshes(scene)).toHaveLength(total - before.length + 2);
    const merged = meshes(scene).filter((m) => m.name === 'wgif-merged');
    expect(merged.map((m) => m.userData.wgif.merged).sort()).toEqual([opaqueNames, glassNames].sort());
    for (const name of KEEP) expect(findNodes(scene, name)).toHaveLength(1);
    expect(box(scene)).toEqual(extentBefore);
    expect(triangles(scene)).toBe(trianglesBefore);
  });

  it('keeps each surface its own colour, roughness and metalness, per vertex', async () => {
    const { scene } = await open();
    const surfaces = statics(scene).filter((m) => !isGlass(m)).map((m) => {
      const { color, roughness, metalness } = m.material as THREE.MeshStandardMaterial;
      return { name: m.name, vertices: m.geometry.attributes.position!.count, look: look(color.r, color.g, color.b, roughness, metalness) };
    });
    expect(new Set(surfaces.map((s) => s.look)).size).toBeGreaterThan(1); // or there would be nothing to keep apart
    const glassOpacity = (statics(scene).find(isGlass)!.material as THREE.MeshStandardMaterial).opacity;
    mergeStatic(scene, kept);
    const opaque = meshes(scene).find((m) => m.name === 'wgif-merged' && !isGlass(m))!;
    const material = opaque.material as THREE.MeshStandardMaterial;
    expect(material.vertexColors).toBe(true);
    expect(material.customProgramCacheKey()).toBe('wgif-per-vertex-pbr');
    // The surfaces are laid end to end in the order they were merged; every vertex of each one
    // must carry that surface's own colour, roughness and metalness.
    expect(opaque.userData.wgif.merged).toEqual(surfaces.map((s) => s.name));
    const g = opaque.geometry;
    const [color, roughness, metalness] = ['color', 'wgifRoughness', 'wgifMetalness'].map((name) => g.getAttribute(name).array as Float32Array) as [Float32Array, Float32Array, Float32Array];
    const wrong: string[] = [];
    let v = 0;
    for (const s of surfaces) {
      for (const end = v + s.vertices; v < end; v++) {
        if (look(color[v * 3]!, color[v * 3 + 1]!, color[v * 3 + 2]!, roughness[v]!, metalness[v]!) !== s.look) wrong.push(`${s.name} vertex ${v}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(v).toBe(g.attributes.position!.count);
    // The glass shares one material, so it merges as it is: no per-vertex attributes needed.
    const glass = meshes(scene).find((m) => m.name === 'wgif-merged' && isGlass(m))!;
    expect(glass.geometry.getAttribute('wgifRoughness')).toBeUndefined();
    expect((glass.material as THREE.MeshStandardMaterial).opacity).toBe(glassOpacity);
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
