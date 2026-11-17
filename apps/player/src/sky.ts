import * as THREE from 'three';

/**
 * A world may bring its own sky: a mesh (usually an inward-facing sphere with a 360° photo) whose
 * glTF node extras say `{"wgif": {"role": "sky"}}`. It is scenery at "infinity", so it is left out
 * of everything that sizes the world: the orbit overview, the sun's shadow box and the shadow
 * casters. A player that ignores the hint still shows it as an ordinary (large) mesh.
 */
export function isSky(object: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) {
    const wgif = (o.userData as { wgif?: { role?: unknown } } | undefined)?.wgif;
    if (wgif?.role === 'sky') return true;
  }
  return false;
}

/** World-space bounds of everything except sky meshes. */
export function sceneBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || isSky(mesh)) return;
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    if (b) box.union(b.clone().applyMatrix4(mesh.matrixWorld));
  });
  return box;
}
