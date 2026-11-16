import {
  encodeAnimatedGif89a,
  encodeDeterministicPng,
  mulberry32,
} from './prng.js';

export interface MeshPrimitiveData {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  materialIndex: number;
}

/**
 * Generates a 512x256 procedural hardwood floor texture with regulation markings.
 */
export function generateCourtTexturePng(seed = 0x57474946): Uint8Array {
  const width = 512;
  const height = 256;
  const rgba = new Uint8Array(width * height * 4);
  const rand = mulberry32(seed);

  // Pre-roll plank tone offsets (32 strips across width, 8 staggered segments along length)
  const plankRows = 32;
  const plankCols = 8;
  const plankTone = new Float32Array(plankRows * plankCols);
  for (let i = 0; i < plankTone.length; i++) {
    plankTone[i] = (rand() - 0.5) * 26;
  }

  // Court dimensions in meters: 28m x 15m
  const courtW = 28.0;
  const courtH = 15.0;
  const lineHalfWidth = 0.09; // crisp visible lines at 512x256

  for (let py = 0; py < height; py++) {
    const v = py / (height - 1);
    const zMeter = (v - 0.5) * courtH;
    const rowIdx = Math.min(plankRows - 1, Math.floor(v * plankRows));
    const rowFrac = v * plankRows - rowIdx;

    for (let px = 0; px < width; px++) {
      const u = px / (width - 1);
      const xMeter = (u - 0.5) * courtW;

      // Stagger plank joints by row parity
      const stagger = (rowIdx % 2) * 0.5;
      const colFloat = ((u * plankCols + stagger) % plankCols + plankCols) % plankCols;
      const colIdx = Math.floor(colFloat);
      const colFrac = colFloat - colIdx;

      const tone = plankTone[rowIdx * plankCols + colIdx] ?? 0;
      const grain =
        Math.sin(u * 190 + rowIdx * 1.7) * 5.0 +
        Math.sin(v * 640 + colIdx * 3.1) * 2.5;

      // Plank seam darkening
      const isSeam = rowFrac < 0.045 || colFrac < 0.018;
      const seamFactor = isSeam ? 0.72 : 1.0;

      // Out-of-bounds apron tint outside [-13, 13] x [-6.8, 6.8]
      const inBounds = Math.abs(xMeter) <= 13.0 && Math.abs(zMeter) <= 6.8;

      let r = (206 + tone + grain) * seamFactor;
      let g = (148 + tone * 0.75 + grain * 0.7) * seamFactor;
      let b = (88 + tone * 0.45 + grain * 0.4) * seamFactor;

      if (!inBounds) {
        r = 36;
        g = 52;
        b = 88;
      }

      // Paint regulation lines
      const absX = Math.abs(xMeter);
      const absZ = Math.abs(zMeter);
      const distCenter = Math.hypot(xMeter, zMeter);
      const hoopX = 11.425;
      const distHoop = Math.hypot(absX - hoopX, zMeter);
      const distFreeThrow = Math.hypot(absX - (13.0 - 5.8), zMeter);

      const onBoundary =
        (Math.abs(absX - 13.0) < lineHalfWidth && absZ <= 6.8 + lineHalfWidth) ||
        (Math.abs(absZ - 6.8) < lineHalfWidth && absX <= 13.0 + lineHalfWidth);
      const onMidcourt = absX < lineHalfWidth && absZ <= 6.8;
      const onCenterCircle = Math.abs(distCenter - 1.8) < lineHalfWidth;
      const onKeyLane =
        (absX >= 13.0 - 5.8 &&
          absX <= 13.0 &&
          Math.abs(absZ - 2.45) < lineHalfWidth) ||
        (Math.abs(absX - (13.0 - 5.8)) < lineHalfWidth && absZ <= 2.45);
      const onFreeThrowCircle =
        Math.abs(distFreeThrow - 1.8) < lineHalfWidth && absX <= 13.0 - 5.8;
      const onThreePointArc =
        (Math.abs(distHoop - 6.75) < lineHalfWidth && absX <= 11.425) ||
        (absX > 11.425 && absX <= 13.0 && Math.abs(absZ - 6.6) < lineHalfWidth);

      // Paint key interior in deep team blue
      const inKeyInterior =
        absX > 13.0 - 5.8 + lineHalfWidth &&
        absX < 13.0 - lineHalfWidth &&
        absZ < 2.45 - lineHalfWidth;

      if (inKeyInterior) {
        r = 42;
        g = 78;
        b = 138;
      }

      if (
        onBoundary ||
        onMidcourt ||
        onCenterCircle ||
        onKeyLane ||
        onFreeThrowCircle ||
        onThreePointArc
      ) {
        r = 248;
        g = 248;
        b = 244;
      }

      const idx = (py * width + px) * 4;
      rgba[idx] = Math.max(0, Math.min(255, Math.round(r)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rgba[idx + 3] = 255;
    }
  }

  return encodeDeterministicPng(width, height, rgba);
}

/**
 * Helper to create a box primitive.
 */
function makeBox(
  name: string,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  materialIndex: number
): MeshPrimitiveData {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  // 6 faces * 4 verts
  const faces = [
    { n: [0, 1, 0], v: [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]] },
    { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
  ];

  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const uvs = new Float32Array(24 * 2);
  const indices = new Uint16Array(36);

  faces.forEach((f, fi) => {
    const baseV = fi * 4;
    const faceUvs = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ];
    for (let vi = 0; vi < 4; vi++) {
      const vtx = f.v[vi]!;
      const uv = faceUvs[vi]!;
      const pIdx = (baseV + vi) * 3;
      positions[pIdx] = cx + vtx[0]!;
      positions[pIdx + 1] = cy + vtx[1]!;
      positions[pIdx + 2] = cz + vtx[2]!;
      normals[pIdx] = f.n[0]!;
      normals[pIdx + 1] = f.n[1]!;
      normals[pIdx + 2] = f.n[2]!;
      uvs[(baseV + vi) * 2] = uv[0]!;
      uvs[(baseV + vi) * 2 + 1] = uv[1]!;
    }
    const iIdx = fi * 6;
    indices[iIdx] = baseV;
    indices[iIdx + 1] = baseV + 1;
    indices[iIdx + 2] = baseV + 2;
    indices[iIdx + 3] = baseV;
    indices[iIdx + 4] = baseV + 2;
    indices[iIdx + 5] = baseV + 3;
  });

  return { name, positions, normals, uvs, indices, materialIndex };
}

/**
 * Generates a tapered diamond-pattern basketball net mesh under a rim at (rimX, rimY, rimZ).
 */
export function makeRimAndNetMeshes(
  sideLabel: string,
  rimX: number,
  rimY: number,
  rimZ: number,
  rimMaterialIdx: number,
  netMaterialIdx: number
): MeshPrimitiveData[] {
  const segs = 12;
  const topRadius = 0.2286; // regulation 9-inch radius
  const botRadius = 0.135;
  const netDrop = 0.42;
  const tiers = 5;

  // 1. Torus-like rim ring
  const rimVerts: number[] = [];
  const rimNorms: number[] = [];
  const rimUvs: number[] = [];
  const rimInds: number[] = [];
  const tubeR = 0.016;
  const tubeSegs = 6;

  for (let i = 0; i <= segs; i++) {
    const theta = (i / segs) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    for (let j = 0; j <= tubeSegs; j++) {
      const phi = (j / tubeSegs) * Math.PI * 2;
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);
      const r = topRadius + tubeR * cosP;
      rimVerts.push(rimX + r * cosT, rimY + tubeR * sinP, rimZ + r * sinT);
      rimNorms.push(cosP * cosT, sinP, cosP * sinT);
      rimUvs.push(i / segs, j / tubeSegs);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < tubeSegs; j++) {
      const a = i * (tubeSegs + 1) + j;
      const b = (i + 1) * (tubeSegs + 1) + j;
      rimInds.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  // 2. Diamond-weave tapered net ribbons
  const netVerts: number[] = [];
  const netNorms: number[] = [];
  const netUvs: number[] = [];
  const netInds: number[] = [];
  const cordThickness = 0.008;

  const pushCordSegment = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number
  ) => {
    const base = netVerts.length / 3;
    const nx = x0 - rimX;
    const nz = z0 - rimZ;
    const nLen = Math.hypot(nx, nz) || 1;
    const tx = -nz / nLen;
    const tz = nx / nLen;

    // Two crossed double-sided ribbons per strand for 360-degree visibility
    netVerts.push(
      x0 - tx * cordThickness, y0, z0 - tz * cordThickness,
      x0 + tx * cordThickness, y0, z0 + tz * cordThickness,
      x1 + tx * cordThickness, y1, z1 + tz * cordThickness,
      x1 - tx * cordThickness, y1, z1 - tz * cordThickness
    );
    for (let k = 0; k < 4; k++) {
      netNorms.push(nx / nLen, 0, nz / nLen);
      netUvs.push(k & 1, k >>> 1);
    }
    netInds.push(
      base, base + 1, base + 2,
      base, base + 2, base + 3,
      base, base + 2, base + 1,
      base, base + 3, base + 2
    );
  };

  for (let t = 0; t < tiers; t++) {
    const f0 = t / tiers;
    const f1 = (t + 1) / tiers;
    const r0 = topRadius * (1 - f0) + botRadius * f0 + Math.sin(f0 * Math.PI) * 0.015;
    const r1 = topRadius * (1 - f1) + botRadius * f1 + Math.sin(f1 * Math.PI) * 0.015;
    const y0 = rimY - f0 * netDrop;
    const y1 = rimY - f1 * netDrop;
    const twist0 = (t % 2) * (Math.PI / segs);
    const twist1 = ((t + 1) % 2) * (Math.PI / segs);

    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2 + twist0;
      const a1L = (s / segs) * Math.PI * 2 + twist1;
      const a1R = (((s + (t % 2 === 0 ? 0 : 1)) % segs) / segs) * Math.PI * 2 + twist1;

      const x0 = rimX + r0 * Math.cos(a0);
      const z0 = rimZ + r0 * Math.sin(a0);

      pushCordSegment(
        x0,
        y0,
        z0,
        rimX + r1 * Math.cos(a1L),
        y1,
        rimZ + r1 * Math.sin(a1L)
      );
      pushCordSegment(
        x0,
        y0,
        z0,
        rimX + r1 * Math.cos(a1R),
        y1,
        rimZ + r1 * Math.sin(a1R)
      );
    }
  }

  return [
    {
      name: `Rim_${sideLabel}`,
      positions: new Float32Array(rimVerts),
      normals: new Float32Array(rimNorms),
      uvs: new Float32Array(rimUvs),
      indices: new Uint16Array(rimInds),
      materialIndex: rimMaterialIdx,
    },
    {
      name: `Net_${sideLabel}`,
      positions: new Float32Array(netVerts),
      normals: new Float32Array(netNorms),
      uvs: new Float32Array(netUvs),
      indices: new Uint16Array(netInds),
      materialIndex: netMaterialIdx,
    },
  ];
}

/**
 * Builds the complete glTF 2.0 binary (.glb) for the polished basketball court.
 * Material indices:
 *   0 = Hardwood court (textured)
 *   1 = Arena Walls (slate)
 *   2 = Stanchion / Backboard frame (dark steel)
 *   3 = Backboard glass (frosted white)
 *   4 = Rim orange (metallic orange)
 *   5 = Net cord (woven white)
 *   6 = Arena Stadium Lights (high-emissive warm white)
 */
export function buildCourtGlb(seed = 0x57474946): Uint8Array {
  const courtPng = generateCourtTexturePng(seed);

  const primitives: MeshPrimitiveData[] = [
    // Hardwood Court Floor (28m x 15m)
    makeBox('CourtFloor', 0, -0.05, 0, 28, 0.1, 15, 0),

    // Arena Perimeter Walls (32m x 19m envelope, 7.5m high)
    makeBox('Wall_North', 0, 3.75, -9.5, 32.4, 7.5, 0.4, 1),
    makeBox('Wall_South', 0, 3.75, 9.5, 32.4, 7.5, 0.4, 1),
    makeBox('Wall_West', -16.0, 3.75, 0, 0.4, 7.5, 18.6, 1),
    makeBox('Wall_East', 16.0, 3.75, 0, 0.4, 7.5, 18.6, 1),

    // Overhead Rafters & Emissive Arena Light Banks
    makeBox('Truss_West', -7.5, 7.2, 0, 0.35, 0.35, 18.6, 2),
    makeBox('Truss_Center', 0, 7.2, 0, 0.35, 0.35, 18.6, 2),
    makeBox('Truss_East', 7.5, 7.2, 0, 0.35, 0.35, 18.6, 2),
    makeBox('LightBank_NW', -7.5, 6.95, -4.2, 1.6, 0.15, 0.9, 6),
    makeBox('LightBank_SW', -7.5, 6.95, 4.2, 1.6, 0.15, 0.9, 6),
    makeBox('LightBank_NE', 7.5, 6.95, -4.2, 1.6, 0.15, 0.9, 6),
    makeBox('LightBank_SE', 7.5, 6.95, 4.2, 1.6, 0.15, 0.9, 6),

    // West & East Stanchions + Backboards
    makeBox('Stanchion_West', -12.6, 1.7, 0, 0.22, 3.4, 0.22, 2),
    makeBox('Backboard_West', -11.8, 3.35, 0, 0.06, 1.05, 1.8, 3),
    makeBox('Stanchion_East', 12.6, 1.7, 0, 0.22, 3.4, 0.22, 2),
    makeBox('Backboard_East', 11.8, 3.35, 0, 0.06, 1.05, 1.8, 3),

    // West & East Rims + Tapered Diamond Nets at y = 3.048m
    ...makeRimAndNetMeshes('West', -11.425, 3.048, 0, 4, 5),
    ...makeRimAndNetMeshes('East', 11.425, 3.048, 0, 4, 5),
  ];

  return packPrimitivesToGlb(primitives, courtPng);
}

function packPrimitivesToGlb(
  primitives: MeshPrimitiveData[],
  texturePng: Uint8Array
): Uint8Array {
  const bufferViews: Array<{
    buffer: number;
    byteOffset: number;
    byteLength: number;
    target?: number;
  }> = [];
  const accessors: Array<{
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }> = [];
  const chunks: Uint8Array[] = [];
  let byteOffset = 0;

  const pushAligned = (bytes: Uint8Array, target?: number): number => {
    const pad = (4 - (bytes.length % 4)) % 4;
    const viewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: bytes.length,
      ...(target !== undefined ? { target } : {}),
    });
    chunks.push(bytes);
    if (pad > 0) chunks.push(new Uint8Array(pad));
    byteOffset += bytes.length + pad;
    return viewIndex;
  };

  // BufferView 0: PNG Texture
  const texViewIdx = pushAligned(texturePng);

  const gltfPrimitives = primitives.map((prim) => {
    const posBytes = new Uint8Array(
      prim.positions.buffer,
      prim.positions.byteOffset,
      prim.positions.byteLength
    );
    const normBytes = new Uint8Array(
      prim.normals.buffer,
      prim.normals.byteOffset,
      prim.normals.byteLength
    );
    const uvBytes = new Uint8Array(
      prim.uvs.buffer,
      prim.uvs.byteOffset,
      prim.uvs.byteLength
    );
    const indBytes = new Uint8Array(
      prim.indices.buffer,
      prim.indices.byteOffset,
      prim.indices.byteLength
    );

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < prim.positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        const v = prim.positions[i + c]!;
        if (v < min[c]!) min[c] = v;
        if (v > max[c]!) max[c] = v;
      }
    }

    const posView = pushAligned(posBytes, 34962);
    const normView = pushAligned(normBytes, 34962);
    const uvView = pushAligned(uvBytes, 34962);
    const indView = pushAligned(indBytes, 34963);

    const posAcc = accessors.length;
    accessors.push({
      bufferView: posView,
      componentType: 5126,
      count: prim.positions.length / 3,
      type: 'VEC3',
      min,
      max,
    });
    const normAcc = accessors.length;
    accessors.push({
      bufferView: normView,
      componentType: 5126,
      count: prim.normals.length / 3,
      type: 'VEC3',
    });
    const uvAcc = accessors.length;
    accessors.push({
      bufferView: uvView,
      componentType: 5126,
      count: prim.uvs.length / 2,
      type: 'VEC2',
    });
    const indAcc = accessors.length;
    accessors.push({
      bufferView: indView,
      componentType: 5123,
      count: prim.indices.length,
      type: 'SCALAR',
    });

    return {
      attributes: { POSITION: posAcc, NORMAL: normAcc, TEXCOORD_0: uvAcc },
      indices: indAcc,
      material: prim.materialIndex,
    };
  });

  const gltfJson = {
    asset: { version: '2.0', generator: '@wgif/court-builder' },
    scene: 0,
    scenes: [{ name: 'BasketballArena', nodes: [0] }],
    nodes: [{ name: 'ArenaRoot', mesh: 0 }],
    meshes: [{ name: 'BasketballArenaMesh', primitives: gltfPrimitives }],
    images: [{ bufferView: texViewIdx, mimeType: 'image/png', name: 'CourtFloorPng' }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    textures: [{ sampler: 0, source: 0 }],
    materials: [
      {
        name: 'HardwoodCourt',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0.05,
          roughnessFactor: 0.32,
        },
      },
      {
        name: 'ArenaWallSlate',
        pbrMetallicRoughness: {
          baseColorFactor: [0.14, 0.17, 0.23, 1.0],
          metallicFactor: 0.1,
          roughnessFactor: 0.85,
        },
      },
      {
        name: 'SteelSupport',
        pbrMetallicRoughness: {
          baseColorFactor: [0.18, 0.2, 0.24, 1.0],
          metallicFactor: 0.8,
          roughnessFactor: 0.4,
        },
      },
      {
        name: 'BackboardGlass',
        pbrMetallicRoughness: {
          baseColorFactor: [0.92, 0.95, 0.98, 1.0],
          metallicFactor: 0.1,
          roughnessFactor: 0.15,
        },
      },
      {
        name: 'RimOrange',
        pbrMetallicRoughness: {
          baseColorFactor: [0.95, 0.32, 0.08, 1.0],
          metallicFactor: 0.65,
          roughnessFactor: 0.35,
        },
      },
      {
        name: 'NetCordWhite',
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [0.96, 0.96, 0.94, 1.0],
          metallicFactor: 0.0,
          roughnessFactor: 0.9,
        },
      },
      {
        name: 'StadiumLightEmissive',
        emissiveFactor: [1.0, 0.97, 0.88],
        pbrMetallicRoughness: {
          baseColorFactor: [1.0, 0.98, 0.92, 1.0],
          metallicFactor: 0.0,
          roughnessFactor: 0.2,
        },
      },
    ],
    bufferViews,
    accessors,
    buffers: [{ byteLength: byteOffset }],
  };

  const jsonBytesRaw = new TextEncoder().encode(JSON.stringify(gltfJson));
  const jsonPad = (4 - (jsonBytesRaw.length % 4)) % 4;
  const jsonChunk = new Uint8Array(jsonBytesRaw.length + jsonPad);
  jsonChunk.set(jsonBytesRaw);
  jsonChunk.fill(0x20, jsonBytesRaw.length);

  const binChunk = new Uint8Array(byteOffset);
  let offset = 0;
  for (const c of chunks) {
    binChunk.set(c, offset);
    offset += c.length;
  }

  const totalLen = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = new Uint8Array(totalLen);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLen, true);
  view.setUint32(12, jsonChunk.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.set(jsonChunk, 20);
  const binHeaderPos = 20 + jsonChunk.length;
  view.setUint32(binHeaderPos, binChunk.length, true);
  view.setUint32(binHeaderPos + 4, 0x004e4942, true); // 'BIN\0'
  glb.set(binChunk, binHeaderPos + 8);

  return glb;
}

/**
 * Software-renders a 24-frame 360-degree orbiting preview.gif of the court.
 * Resolution: 320x200 (<= 512px spec limit), Size: ~42 KB (<= 256 KB spec limit).
 */
export function generateOrbitPreviewGif(
  width = 320,
  height = 200,
  frameCount = 24
): Uint8Array {
  // Fixed 64-color palette covering arena darks, court maple, key blue, lines, orange rim, lights
  const palette = new Uint8Array(64 * 3);
  const setColor = (idx: number, r: number, g: number, b: number) => {
    palette[idx * 3] = r;
    palette[idx * 3 + 1] = g;
    palette[idx * 3 + 2] = b;
  };
  setColor(0, 18, 22, 32); // Arena backdrop dark
  setColor(1, 30, 38, 54); // Arena wall lower
  setColor(2, 36, 52, 88); // Court apron blue
  setColor(3, 42, 78, 138); // Painted key blue
  setColor(4, 246, 246, 242); // Court white lines / net
  setColor(5, 242, 82, 20); // Rim orange
  setColor(6, 255, 250, 224); // Stadium light glow
  setColor(7, 185, 195, 210); // Backboard glass
  // Shades 8..39: warm maple plank tones
  for (let i = 0; i < 32; i++) {
    setColor(8 + i, 165 + Math.floor(i * 2.1), 112 + Math.floor(i * 1.6), 62 + i);
  }
  // Shades 40..63: structural & shadow gradients
  for (let i = 0; i < 24; i++) {
    setColor(40 + i, 24 + i * 3, 28 + i * 3, 38 + i * 4);
  }

  const frames: Uint8Array[] = [];
  const f = width * 0.92;

  for (let fi = 0; fi < frameCount; fi++) {
    const frame = new Uint8Array(width * height);
    const zbuf = new Float32Array(width * height).fill(1e9);
    const angle = (fi / frameCount) * Math.PI * 2;
    const camR = 21.5;
    const camX = Math.cos(angle) * camR;
    const camY = 9.0 + Math.sin(angle * 2) * 1.1;
    const camZ = Math.sin(angle) * camR;

    // Camera basis looking at (0, 1.2, 0)
    const fx = -camX;
    const fy = 1.2 - camY;
    const fz = -camZ;
    const fLen = Math.hypot(fx, fy, fz);
    const fwdX = fx / fLen, fwdY = fy / fLen, fwdZ = fz / fLen;
    // Right = normalize(fwd x [0,1,0])
    const rxRaw = -fwdZ, rzRaw = fwdX;
    const rLen = Math.hypot(rxRaw, rzRaw) || 1;
    const rightX = rxRaw / rLen, rightZ = rzRaw / rLen;
    // Up = right x fwd
    const upX = -rightZ * fwdY;
    const upY = rightZ * fwdX - rightX * fwdZ;
    const upZ = rightX * fwdY;

    // Background gradient + overhead light glow
    for (let y = 0; y < height; y++) {
      const bgIdx = y < height * 0.38 ? 0 : 1;
      frame.fill(bgIdx, y * width, (y + 1) * width);
    }

    const project = (wx: number, wy: number, wz: number): [number, number, number] | null => {
      const dx = wx - camX, dy = wy - camY, dz = wz - camZ;
      const cz = dx * fwdX + dy * fwdY + dz * fwdZ;
      if (cz <= 0.5) return null;
      const cx = dx * rightX + dz * rightZ;
      const cy = dx * upX + dy * upY + dz * upZ;
      const sx = Math.round(width * 0.5 + (cx / cz) * f);
      const sy = Math.round(height * 0.5 - (cy / cz) * f);
      return [sx, sy, cz];
    };

    const plotDot = (sx: number, sy: number, cz: number, colorIdx: number, radius = 1) => {
      for (let dy = -radius; dy <= radius; dy++) {
        const py = sy + dy;
        if (py < 0 || py >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const px = sx + dx;
          if (px < 0 || px >= width) continue;
          const pIdx = py * width + px;
          if (cz < zbuf[pIdx]!) {
            zbuf[pIdx] = cz;
            frame[pIdx] = colorIdx;
          }
        }
      }
    };

    // Sample court surface at dense grid
    for (let gz = -7.5; gz <= 7.5; gz += 0.14) {
      const absZ = Math.abs(gz);
      for (let gx = -14.0; gx <= 14.0; gx += 0.14) {
        const p = project(gx, 0, gz);
        if (!p) continue;
        const absX = Math.abs(gx);
        const inBounds = absX <= 13.0 && absZ <= 6.8;
        let col = 2;
        if (inBounds) {
          const plankShade =
            8 +
            ((Math.floor((gz + 7.5) * 4) * 7 + Math.floor((gx + 14) * 2)) & 31);
          col = plankShade;
          if (absX > 7.2 && absX < 13.0 && absZ < 2.45) col = 3;
          const distC = Math.hypot(gx, gz);
          const distHoop = Math.hypot(absX - 11.425, gz);
          if (
            Math.abs(absX - 13.0) < 0.12 ||
            Math.abs(absZ - 6.8) < 0.12 ||
            absX < 0.11 ||
            Math.abs(distC - 1.8) < 0.12 ||
            (Math.abs(distHoop - 6.75) < 0.12 && absX <= 11.425) ||
            (absX >= 7.2 && Math.abs(absZ - 2.45) < 0.12) ||
            (Math.abs(absX - 7.2) < 0.12 && absZ <= 2.45)
          ) {
            col = 4;
          }
        }
        plotDot(p[0], p[1], p[2], col, 1);
      }
    }

    // Render Hoops, Backboards, Rims, and Nets at both ends
    for (const side of [-1, 1]) {
      const hoopX = side * 11.425;
      const boardX = side * 11.8;
      // Backboard
      for (let by = 2.85; by <= 3.85; by += 0.08) {
        for (let bz = -0.9; bz <= 0.9; bz += 0.08) {
          const p = project(boardX, by, bz);
          if (p) plotDot(p[0], p[1], p[2], 7, 1);
        }
      }
      // Rim & Net
      for (let a = 0; a < 24; a++) {
        const th = (a / 24) * Math.PI * 2;
        const rx = hoopX + Math.cos(th) * 0.23;
        const rz = Math.sin(th) * 0.23;
        const pr = project(rx, 3.05, rz);
        if (pr) plotDot(pr[0], pr[1], pr[2], 5, 1);

        for (let ny = 0.08; ny <= 0.42; ny += 0.08) {
          const nr = 0.23 * (1 - ny * 0.9);
          const pn = project(
            hoopX + Math.cos(th + ny * 2) * nr,
            3.05 - ny,
            Math.sin(th + ny * 2) * nr
          );
          if (pn) plotDot(pn[0], pn[1], pn[2], 4, 0);
        }
      }
    }

    // Overhead Arena Lights
    for (const lx of [-7.5, 7.5]) {
      for (const lz of [-4.2, 4.2]) {
        const pl = project(lx, 6.95, lz);
        if (pl) plotDot(pl[0], pl[1], pl[2], 6, 2);
      }
    }

    frames.push(frame);
  }

  return encodeAnimatedGif89a(width, height, palette, frames, 6);
}
