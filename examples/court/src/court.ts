import { Document, NodeIO, type Material, type Node } from '@gltf-transform/core';
import { append, box, cylinder, emptyMesh, ring, sphere, torus, type MeshData } from './geometry.js';

/** Court dimensions in meters (close to FIBA: 28 x 15). +X runs baseline to baseline. */
export const COURT = {
  length: 28,
  width: 15,
  apron: 2.5,
  rimHeight: 3.05,
  rimRadius: 0.225,
  /** Rim centre distance from the baseline. */
  rimFromBaseline: 1.575,
  ballRadius: 0.12,
  line: 0.05,
};

export const rimCenter = (side: 1 | -1): [number, number, number] => [
  side * (COURT.length / 2 - COURT.rimFromBaseline),
  COURT.rimHeight,
  0,
];
export const BALL_START: [number, number, number] = [9.0, COURT.ballRadius, 1.2];

function lines(): MeshData {
  const L = COURT.length, W = COURT.width, t = COURT.line, y = 0.012, h = 0.004;
  const m = emptyMesh();
  // Boundary + half-court line.
  append(m, box(0, y, W / 2, L, h, t));
  append(m, box(0, y, -W / 2, L, h, t));
  append(m, box(L / 2, y, 0, t, h, W));
  append(m, box(-L / 2, y, 0, t, h, W));
  append(m, box(0, y, 0, t, h, W));
  append(m, ring(0, y + h / 2, 0, 1.8 - t, 1.8));
  for (const side of [1, -1] as const) {
    const bx = side * (L / 2);
    const ftx = side * (L / 2 - 5.8);
    // Key (4.9 m wide, free-throw line 5.8 m from baseline).
    append(m, box((bx + ftx) / 2, y, 2.45, 5.8, h, t));
    append(m, box((bx + ftx) / 2, y, -2.45, 5.8, h, t));
    append(m, box(ftx, y, 0, t, h, 4.9));
    append(m, ring(ftx, y + h / 2, 0, 1.8 - t, 1.8, side > 0 ? Math.PI / 2 : -Math.PI / 2, side > 0 ? (3 * Math.PI) / 2 : Math.PI / 2));
    // Three-point arc (6.75 m) with straight corner segments at 6.6 m from centre line.
    const [rx] = rimCenter(side);
    const r = 6.75;
    const a = Math.asin(6.6 / r);
    const startA = side > 0 ? Math.PI - a : -a;
    const endA = side > 0 ? Math.PI + a : a;
    append(m, ring(rx, y + h / 2, 0, r - t, r, startA, endA, 64));
    const cornerLen = Math.abs(bx - (rx - side * r * Math.cos(a)));
    for (const z of [6.6, -6.6]) append(m, box(bx - side * (cornerLen / 2), y, z, cornerLen, h, t));
  }
  return m;
}

function hoopStructure(side: 1 | -1): { support: MeshData; board: MeshData; rim: MeshData } {
  const [rx, ry] = rimCenter(side);
  const boardX = rx + side * (COURT.rimRadius + 0.15);
  const poleX = side * (COURT.length / 2 + 1.2);
  const support = emptyMesh();
  append(support, box(poleX, 0.15, 0, 0.9, 0.3, 1.2)); // base
  append(support, cylinder(poleX, 0, 0.3, ry + 0.6, 0.1));
  append(support, box((poleX + boardX) / 2 + side * 0.02, ry + 0.45, 0, Math.abs(poleX - boardX), 0.12, 0.12)); // arm
  const board = box(boardX, ry + 0.45, 0, 0.05, 1.05, 1.8);
  const rim = torus(rx, ry, 0, COURT.rimRadius, 0.012);
  append(rim, box(rx + side * (COURT.rimRadius + 0.07), ry, 0, 0.14, 0.02, 0.06)); // bracket
  return { support, board, rim };
}

function bleachers(): MeshData {
  const m = emptyMesh();
  const zStart = COURT.width / 2 + COURT.apron;
  for (let row = 0; row < 5; row++) {
    const z = zStart + 0.4 + row * 0.8;
    const h = 0.45 * (row + 1);
    append(m, box(0, h / 2, z, 22, h, 0.8));
    append(m, box(0, h / 2, -z, 22, h, 0.8));
  }
  return m;
}

/** Builds the court scene and returns it as GLB bytes. Deterministic. */
export async function buildCourtGlb(): Promise<Uint8Array> {
  const doc = new Document();
  doc.getRoot().getAsset().generator = 'wgif example-court';
  const buffer = doc.createBuffer();
  const scene = doc.createScene('BasketballCourt');

  const mat = (name: string, rgba: [number, number, number, number], rough = 0.8, metal = 0): Material => {
    const m = doc.createMaterial(name).setBaseColorFactor(rgba).setRoughnessFactor(rough).setMetallicFactor(metal);
    if (rgba[3] < 1) m.setAlphaMode('BLEND');
    return m;
  };
  const addMesh = (name: string, data: MeshData, material: Material, extras?: Record<string, unknown>): Node => {
    const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(data.positions)).setBuffer(buffer);
    const nrm = doc.createAccessor().setType('VEC3').setArray(new Float32Array(data.normals)).setBuffer(buffer);
    const idx = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(data.indices)).setBuffer(buffer);
    if (data.positions.length / 3 > 65535) throw new Error(`${name}: too many vertices for uint16`);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setIndices(idx).setMaterial(material);
    const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
    if (extras) node.setExtras(extras);
    scene.addChild(node);
    return node;
  };

  const wood = mat('hardwood', [0.78, 0.55, 0.32, 1], 0.6);
  const apron = mat('apron', [0.12, 0.2, 0.45, 1], 0.7);
  const paint = mat('paint', [0.95, 0.95, 0.95, 1], 0.5);
  const keyPaint = mat('key', [0.7, 0.18, 0.12, 1], 0.6);
  const steel = mat('steel', [0.25, 0.27, 0.3, 1], 0.4, 0.8);
  const glass = mat('backboard', [0.85, 0.92, 1.0, 0.45], 0.1);
  const orange = mat('rim', [1.0, 0.35, 0.05, 1], 0.4, 0.3);
  const ball = mat('ball', [0.9, 0.42, 0.1, 1], 0.7);
  const seats = mat('bleachers', [0.3, 0.32, 0.38, 1], 0.9);

  const L = COURT.length, W = COURT.width, A = COURT.apron;
  addMesh('floor_apron', box(0, -0.06, 0, L + 2 * A + 4, 0.1, W + 2 * A), apron, { wgif: { collider: 'static' } });
  addMesh('floor_court', box(0, -0.005, 0, L, 0.02, W), wood, { wgif: { collider: 'static' } });
  const keys = emptyMesh();
  for (const side of [1, -1]) append(keys, box(side * (L / 2 - 2.9), 0.008, 0, 5.8, 0.004, 4.9));
  addMesh('court_keys', keys, keyPaint);
  addMesh('court_lines', lines(), paint);
  addMesh('bleachers', bleachers(), seats, { wgif: { collider: 'static' } });

  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'home' : 'away';
    const h = hoopStructure(side);
    addMesh(`hoop_${tag}_support`, h.support, steel, { wgif: { collider: 'static' } });
    addMesh(`hoop_${tag}_backboard`, h.board, glass, { wgif: { collider: 'static' } });
    addMesh(`rim_${tag}`, h.rim, orange, { wgif: { role: 'target', center: rimCenter(side), radius: COURT.rimRadius } });
  }

  const ballNode = addMesh('ball', sphere(0, 0, 0, COURT.ballRadius), ball, {
    wgif: { role: 'grabbable', radius: COURT.ballRadius },
  });
  ballNode.setTranslation(BALL_START);

  return new NodeIO().writeBinary(doc);
}
