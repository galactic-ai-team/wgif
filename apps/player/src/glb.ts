import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';


/**
 * Parses GLB bytes into a three.js scene graph. Nothing is fetched: a world must carry everything
 * it needs inside the GLB (SPEC §5.1), so an external URI simply fails to load.
 * `KHR_mesh_quantization` works out of the box and `EXT_meshopt_compression` through the bundled decoder.
 */
export function parseGlb(bytes: Uint8Array): Promise<THREE.Group> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();

    loader.parse(buf, '', (gltf) => resolve(gltf.scene), (err) => reject(err));
  });
}
