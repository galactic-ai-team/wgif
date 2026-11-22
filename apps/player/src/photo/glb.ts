/**
 * A minimal glTF 2.0 binary writer for the creator: indexed triangle meshes with normals and UVs,
 * plain PBR materials and embedded JPEG/PNG images. No extensions, so any glTF viewer (and the
 * WGIF validator's extension check) accepts it. Runs in the page or in Node.
 */
import type { MeshData } from './mesh.js';

export interface GlbImage {
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface GlbMaterial {
  name: string;
  color: [number, number, number, number];
  /** Image index used as the base colour map. */
  texture?: number;
  /** Shows the picture at its own colours in any light: texture as emissive map, black base. */
  glow?: number;
  emissive?: [number, number, number];
  rough?: number;
  doubleSided?: boolean;
}

export interface GlbNode {
  name: string;
  mesh: MeshData;
  material: number;
  extras?: Record<string, unknown>;
}

const enc = new TextEncoder();
const pad4 = (n: number): number => (n + 3) & ~3;

export function writeGlb(nodes: GlbNode[], materials: GlbMaterial[], images: GlbImage[], generator: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const view = (bytes: Uint8Array, target?: number): number => {
    const start = offset;
    chunks.push(bytes);
    offset += bytes.length;
    const padLen = pad4(offset) - offset;
    if (padLen) {
      chunks.push(new Uint8Array(padLen));
      offset += padLen;
    }
    bufferViews.push({ buffer: 0, byteOffset: start, byteLength: bytes.length, ...(target ? { target } : {}) });
    return bufferViews.length - 1;
  };
  const asBytes = (a: Float32Array | Uint16Array | Uint32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const accessor = (a: Float32Array | Uint16Array | Uint32Array, type: 'SCALAR' | 'VEC2' | 'VEC3', target: number, minmax?: { min: number[]; max: number[] }): number => {
    const comps = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : 3;
    const componentType = a instanceof Float32Array ? 5126 : a instanceof Uint16Array ? 5123 : 5125;
    accessors.push({ bufferView: view(asBytes(a), target), componentType, count: a.length / comps, type, ...(minmax ?? {}) });
    return accessors.length - 1;
  };
  const meshes = nodes.map((n) => {
    const m = n.mesh;
    const POSITION = accessor(m.positions, 'VEC3', 34962, { min: m.min, max: m.max });
    const NORMAL = accessor(m.normals, 'VEC3', 34962);
    const TEXCOORD_0 = accessor(m.uvs, 'VEC2', 34962);
    const indices = accessor(m.indices, 'SCALAR', 34963);
    return { name: n.name, primitives: [{ attributes: { POSITION, NORMAL, TEXCOORD_0 }, indices, material: n.material, mode: 4 }] };
  });
  const imageDefs = images.map((im) => ({ bufferView: view(im.bytes), mimeType: im.mimeType }));
  const json = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ name: 'world', nodes: nodes.map((_, i) => i) }],
    nodes: nodes.map((n, i) => ({ name: n.name, mesh: i, ...(n.extras ? { extras: n.extras } : {}) })),
    meshes,
    materials: materials.map((m) => {
      const glow = m.glow !== undefined;
      return {
        name: m.name,
        pbrMetallicRoughness: {
          baseColorFactor: glow ? [0, 0, 0, 1] : m.color,
          ...(m.texture !== undefined && !glow ? { baseColorTexture: { index: m.texture } } : {}),
          metallicFactor: 0,
          roughnessFactor: m.rough ?? 1,
        },
        ...(glow ? { emissiveTexture: { index: m.glow }, emissiveFactor: m.color.slice(0, 3) } : m.emissive ? { emissiveFactor: m.emissive } : {}),
        ...(m.doubleSided ? { doubleSided: true } : {}),
      };
    }),
    ...(images.length
      ? {
          // Clamp, so the picture's edges never wrap; linear filtering with mipmaps.
          samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
          images: imageDefs,
          textures: images.map((_, i) => ({ sampler: 0, source: i })),
        }
      : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  const jsonBytes = enc.encode(JSON.stringify(json));
  const jsonLen = pad4(jsonBytes.length), binLen = offset;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  let p = 20 + jsonLen;
  dv.setUint32(p, binLen, true);
  dv.setUint32(p + 4, 0x004e4942, true);
  p += 8;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
