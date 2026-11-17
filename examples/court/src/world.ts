import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packWgif, utf8, type ManifestInput, type ModelEntry } from '@wgif/format';
import { BALL_START, COURT, buildCourtGlb, rimCenter } from './court.js';
import { renderPreviewPng } from './preview.js';

/**
 * Deterministically appends procedural court-polish detail nodes
 * (backboard shooter's target squares, painted key lane hash marks, and 3-point arcs)
 * into the GLB binary produced by `buildCourtGlb()` while preserving all existing
 * nodes, collider names, materials, and accessors.
 */
function injectCourtVisualPolishGlb(baseGlb: Uint8Array): Uint8Array {
  const dv = new DataView(baseGlb.buffer, baseGlb.byteOffset, baseGlb.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) {
    return baseGlb;
  }

  const jsonLen = dv.getUint32(12, true);
  const jsonStart = 20;
  const jsonText = new TextDecoder().decode(baseGlb.subarray(jsonStart, jsonStart + jsonLen));
  const gltf = JSON.parse(jsonText) as {
    scenes?: Array<{ nodes?: number[] }>;
    nodes?: Array<Record<string, unknown>>;
    meshes?: Array<Record<string, unknown>>;
    materials?: Array<Record<string, unknown>>;
    bufferViews?: Array<{
      buffer: number;
      byteOffset: number;
      byteLength: number;
      target?: number;
    }>;
    accessors?: Array<{
      bufferView: number;
      componentType: number;
      count: number;
      type: string;
      min?: number[];
      max?: number[];
    }>;
    buffers?: Array<{ byteLength: number }>;
  };

  const binHeaderPos = jsonStart + jsonLen;
  const binLen = dv.getUint32(binHeaderPos, true);
  const binStart = binHeaderPos + 8;
  const oldBin = baseGlb.subarray(binStart, binStart + binLen);

  const verts: number[] = [];
  const norms: number[] = [];
  const inds: number[] = [];

  const pushBox = (
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number
  ) => {
    const hx = sx * 0.5;
    const hy = sy * 0.5;
    const hz = sz * 0.5;
    const faces: Array<{ n: [number, number, number]; v: Array<[number, number, number]> }> = [
      { n: [0, 1, 0], v: [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
      { n: [0, -1, 0], v: [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]] },
      { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
      { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
      { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
      { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    ];
    for (const f of faces) {
      const base = verts.length / 3;
      for (const vtx of f.v) {
        verts.push(cx + vtx[0], cy + vtx[1], cz + vtx[2]);
        norms.push(f.n[0], f.n[1], f.n[2]);
      }
      inds.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  };

  const pushFloorRibbonSegment = (
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    width = 0.05,
    y = 0.003
  ) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * (width * 0.5);
    const nz = (dx / len) * (width * 0.5);
    const base = verts.length / 3;
    verts.push(
      x0 - nx, y, z0 - nz,
      x0 + nx, y, z0 + nz,
      x1 + nx, y, z1 + nz,
      x1 - nx, y, z1 - nz
    );
    for (let k = 0; k < 4; k++) {
      norms.push(0, 1, 0);
    }
    inds.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (const end of [-1, 1] as const) {
    const center = rimCenter(end);
    const rx = center[0];
    const ry = center[1];
    const rz = center[2];
    const alongX = Math.abs(rx) >= Math.abs(rz);
    const sign = Math.sign(alongX ? rx : rz) || end;
    const rimR = COURT.rimRadius ?? 0.225;

    // 1. Backboard Shooter's Target Square (0.61m wide x 0.45m high crisp white outline)
    const sqW = 0.61;
    const sqH = 0.45;
    const sqT = 0.032;
    const sqCenterY = ry + 0.26;
    const boardOffset = rimR + 0.14;

    if (alongX) {
      const bx = rx + sign * boardOffset;
      pushBox(bx, sqCenterY + sqH * 0.5, rz, 0.015, sqT, sqW + sqT);
      pushBox(bx, sqCenterY - sqH * 0.5, rz, 0.015, sqT, sqW + sqT);
      pushBox(bx, sqCenterY, rz - sqW * 0.5, 0.015, sqH, sqT);
      pushBox(bx, sqCenterY, rz + sqW * 0.5, 0.015, sqH, sqT);
    } else {
      const bz = rz + sign * boardOffset;
      pushBox(rx, sqCenterY + sqH * 0.5, bz, sqW + sqT, sqT, 0.015);
      pushBox(rx, sqCenterY - sqH * 0.5, bz, sqW + sqT, sqT, 0.015);
      pushBox(rx - sqW * 0.5, sqCenterY, bz, sqT, sqH, 0.015);
      pushBox(rx + sqW * 0.5, sqCenterY, bz, sqT, sqH, 0.015);
    }

    // 2. Three-Point Arc (16 segments around rim projection on court floor)
    const arcRadius = 6.75;
    const arcSegs = 16;
    const inwardAngle = alongX ? (sign > 0 ? Math.PI : 0) : sign > 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
    const sweep = Math.PI * 0.78;
    for (let s = 0; s < arcSegs; s++) {
      const a0 = inwardAngle - sweep * 0.5 + (s / arcSegs) * sweep;
      const a1 = inwardAngle - sweep * 0.5 + ((s + 1) / arcSegs) * sweep;
      pushFloorRibbonSegment(
        rx + Math.cos(a0) * arcRadius,
        rz + Math.sin(a0) * arcRadius,
        rx + Math.cos(a1) * arcRadius,
        rz + Math.sin(a1) * arcRadius,
        0.05,
        0.0035
      );
    }

    // 3. Key / Free-Throw Lane Perimeter & Hash Marks
    const keyHalfW = 2.45;
    const keyLen = 5.8;
    const hashOffsets = [1.75, 2.65, 3.55, 4.45];
    const hashLen = 0.45;
    if (alongX) {
      const baseLineX = rx + sign * 1.2;
      const ftLineX = baseLineX - sign * keyLen;
      pushFloorRibbonSegment(baseLineX, rz - keyHalfW, ftLineX, rz - keyHalfW, 0.06, 0.004);
      pushFloorRibbonSegment(baseLineX, rz + keyHalfW, ftLineX, rz + keyHalfW, 0.06, 0.004);
      pushFloorRibbonSegment(ftLineX, rz - keyHalfW, ftLineX, rz + keyHalfW, 0.06, 0.004);
      for (let hi = 0; hi < hashOffsets.length; hi++) {
        const hx = baseLineX - sign * hashOffsets[hi]!;
        const tickW = hi === 0 ? 0.18 : 0.08;
        pushFloorRibbonSegment(
          hx,
          rz - keyHalfW,
          hx,
          rz - (keyHalfW + hashLen),
          tickW,
          0.004
        );
        pushFloorRibbonSegment(
          hx,
          rz + keyHalfW,
          hx,
          rz + (keyHalfW + hashLen),
          tickW,
          0.004
        );
      }
    } else {
      const baseLineZ = rz + sign * 1.2;
      const ftLineZ = baseLineZ - sign * keyLen;
      pushFloorRibbonSegment(rx - keyHalfW, baseLineZ, rx - keyHalfW, ftLineZ, 0.06, 0.004);
      pushFloorRibbonSegment(rx + keyHalfW, baseLineZ, rx + keyHalfW, ftLineZ, 0.06, 0.004);
      pushFloorRibbonSegment(rx - keyHalfW, ftLineZ, rx + keyHalfW, ftLineZ, 0.06, 0.004);
      for (let hi = 0; hi < hashOffsets.length; hi++) {
        const hz = baseLineZ - sign * hashOffsets[hi]!;
        const tickW = hi === 0 ? 0.18 : 0.08;
        pushFloorRibbonSegment(
          rx - keyHalfW,
          hz,
          rx - (keyHalfW + hashLen),
          hz,
          tickW,
          0.004
        );
        pushFloorRibbonSegment(
          rx + keyHalfW,
          hz,
          rx + (keyHalfW + hashLen),
          hz,
          tickW,
          0.004
        );
      }
    }
  }

  const posArr = new Float32Array(verts);
  const normArr = new Float32Array(norms);
  const indArr = new Uint16Array(inds);

  const posBytes = new Uint8Array(posArr.buffer, posArr.byteOffset, posArr.byteLength);
  const normBytes = new Uint8Array(normArr.buffer, normArr.byteOffset, normArr.byteLength);
  const indBytes = new Uint8Array(indArr.buffer, indArr.byteOffset, indArr.byteLength);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < posArr.length; i += 3) {
    const x = posArr[i]!;
    const y = posArr[i + 1]!;
    const z = posArr[i + 2]!;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }

  const pad4 = (n: number) => (4 - (n % 4)) % 4;
  const bufferViews = gltf.bufferViews ?? (gltf.bufferViews = []);
  const accessors = gltf.accessors ?? (gltf.accessors = []);
  const materials = gltf.materials ?? (gltf.materials = []);
  const meshes = gltf.meshes ?? (gltf.meshes = []);
  const nodes = gltf.nodes ?? (gltf.nodes = []);

  let curOffset = oldBin.byteLength;
  const extraParts: Uint8Array[] = [];
  const initPad = pad4(curOffset);
  if (initPad > 0) {
    extraParts.push(new Uint8Array(initPad));
    curOffset += initPad;
  }

  const appendView = (bytes: Uint8Array, target: number): number => {
    const idx = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: curOffset,
      byteLength: bytes.byteLength,
      target,
    });
    extraParts.push(bytes);
    curOffset += bytes.byteLength;
    const p = pad4(bytes.byteLength);
    if (p > 0) {
      extraParts.push(new Uint8Array(p));
      curOffset += p;
    }
    return idx;
  };

  const posView = appendView(posBytes, 34962);
  const normView = appendView(normBytes, 34962);
  const indView = appendView(indBytes, 34963);

  const posAcc = accessors.length;
  accessors.push({
    bufferView: posView,
    componentType: 5126,
    count: posArr.length / 3,
    type: 'VEC3',
    min,
    max,
  });

  const normAcc = accessors.length;
  accessors.push({
    bufferView: normView,
    componentType: 5126,
    count: normArr.length / 3,
    type: 'VEC3',
  });

  const indAcc = accessors.length;
  accessors.push({
    bufferView: indView,
    componentType: 5123,
    count: indArr.length,
    type: 'SCALAR',
  });

  const matIdx = materials.length;
  materials.push({
    name: 'court_paint_markings_white',
    pbrMetallicRoughness: {
      baseColorFactor: [0.97, 0.97, 0.95, 1.0],
      metallicFactor: 0.05,
      roughnessFactor: 0.45,
    },
  });

  const meshIdx = meshes.length;
  meshes.push({
    name: 'court_visual_polish',
    primitives: [
      {
        attributes: { POSITION: posAcc, NORMAL: normAcc },
        indices: indAcc,
        material: matIdx,
      },
    ],
  });

  const nodeIdx = nodes.length;
  nodes.push({
    name: 'court_visual_polish',
    mesh: meshIdx,
  });

  if (gltf.scenes && gltf.scenes[0]) {
    gltf.scenes[0].nodes = gltf.scenes[0].nodes ?? [];
    gltf.scenes[0].nodes.push(nodeIdx);
  }
  if (gltf.buffers && gltf.buffers[0]) {
    gltf.buffers[0].byteLength = curOffset;
  }

  const newJsonRaw = new TextEncoder().encode(JSON.stringify(gltf));
  const newJsonPad = pad4(newJsonRaw.byteLength);
  const newJsonChunk = new Uint8Array(newJsonRaw.byteLength + newJsonPad);
  newJsonChunk.set(newJsonRaw);
  newJsonChunk.fill(0x20, newJsonRaw.byteLength);

  const newBinChunk = new Uint8Array(curOffset);
  newBinChunk.set(oldBin, 0);
  let writePos = oldBin.byteLength;
  for (const part of extraParts) {
    newBinChunk.set(part, writePos);
    writePos += part.byteLength;
  }

  const totalLen = 12 + 8 + newJsonChunk.byteLength + 8 + newBinChunk.byteLength;
  const outGlb = new Uint8Array(totalLen);
  const outDv = new DataView(outGlb.buffer);
  outDv.setUint32(0, 0x46546c67, true);
  outDv.setUint32(4, 2, true);
  outDv.setUint32(8, totalLen, true);
  outDv.setUint32(12, newJsonChunk.byteLength, true);
  outDv.setUint32(16, 0x4e4f534a, true);
  outGlb.set(newJsonChunk, 20);
  const newBinHeaderPos = 20 + newJsonChunk.byteLength;
  outDv.setUint32(newBinHeaderPos, newBinChunk.byteLength, true);
  outDv.setUint32(newBinHeaderPos + 4, 0x004e4942, true);
  outGlb.set(newBinChunk, newBinHeaderPos + 8);

  return outGlb;
}

/**
 * interactions.json — DRAFT shape for v0.1 (owned by the Format + Player lanes, see SPEC §5).
 * The Phase One proof player only reads `camera`; the shooting minigame lane implements the rest.
 */
export function interactions() {
  return {
    version: '0.1',
    camera: { spawn: [4.0, 1.7, 0], lookAt: [12.425, 1.8, 0], firstPersonHeight: 1.7, bounds: { min: [-17, 0, -10], max: [17, 6, 10] } },
    objects: [
      {
        id: 'ball',
        node: 'ball',
        kind: 'grabbable',
        physics: { shape: 'sphere', radius: COURT.ballRadius, mass: 0.6, restitution: 0.75, friction: 0.6 },
        spawn: BALL_START,
      },
      { id: 'rim_home', node: 'rim_home', kind: 'trigger', shape: { type: 'cylinder', center: rimCenter(1), radius: COURT.rimRadius, height: 0.1 }, on: { enterFromAbove: { event: 'score', target: 'ball' } } },
      { id: 'rim_away', node: 'rim_away', kind: 'trigger', shape: { type: 'cylinder', center: rimCenter(-1), radius: COURT.rimRadius, height: 0.1 }, on: { enterFromAbove: { event: 'score', target: 'ball' } } },
    ],
    colliders: { static: ['floor_apron', 'floor_court', 'bleachers', 'hoop_home_support', 'hoop_home_backboard', 'hoop_away_support', 'hoop_away_backboard'] },
    minigames: [
      {
        id: 'shootout',
        type: 'basketball-shooting',
        title: 'Shootout',
        ball: 'ball',
        targets: ['rim_home', 'rim_away'],
        rules: { durationSec: 60, pointsPerBasket: 2, threePointRadius: 6.75 },
      },
    ],
  };
}

export function gameState() {
  return {
    version: '0.1',
    minigames: { shootout: { highScore: 0, plays: 0 } },
    objects: { ball: { position: BALL_START } },
  };
}

export function courtManifest(): ManifestInput {
  // Embedded AI (Nova lane): the court ships two models for one NPC, the
  // rebounder. Manifest order is load order: the rules model is the live
  // behaviour and the source of truth, and the ONNX clone is the packaged
  // alternative — tried only if a world lists it first. Both are validated by
  // the format lane's descriptor schema (SPEC §5.5). Leading with rules also
  // keeps the sample court inside the player-JS budget: the ONNX WASM asset
  // (~29 MB) is fetched lazily, only when an ONNX model actually loads.
  const models: ModelEntry[] = [
    {
      id: 'rebounder-rules',
      path: 'models/rebounder.rules.json',
      runtime: 'rules',
      purpose: 'rebounder',
      version: '0.1.0',
      inputs: [
        { name: 'ball_position', description: 'Ball position [x, y, z] in meters.' },
        { name: 'ball_velocity', description: 'Ball velocity [x, y, z] in m/s.' },
        { name: 'ball_held_by', description: '"player", "rebounder", or null.' },
        { name: 'player_position', description: 'Player position [x, y, z] in meters.' },
        { name: 'self_position', description: 'Rebounder position [x, y, z] in meters.' },
      ],
      outputs: [
        { name: 'velocity', description: 'Move velocity [x, y, z] in m/s (y is always 0).' },
        { name: 'pass_ball', description: 'True on the tick the ball is passed back to the player.' },
        { name: 'holding_ball', description: 'True while the rebounder carries the ball.' },
      ],
      tickHz: 10,
      deterministic: true,
      seed: 7,
      license: 'CC-BY-4.0',
      sizeBytesMax: 65536,
    },
    {
      id: 'rebounder-mlp',
      path: 'models/rebounder-mlp.onnx',
      runtime: 'onnx',
      purpose: 'rebounder',
      version: '0.1.0',
      inputs: [
        {
          name: 'obs',
          shape: [1, 14],
          dtype: 'float32',
          description:
            'Features in order: ball_dx, ball_dz, ball_vx, ball_vz, player_dx, player_dz, home_dx, home_dz, held_by_self, held_by_player, ball_out_of_bounds, dist_to_ball, dist_to_player, dist_to_home. See @wgif/ai ONNX_OBS_FEATURES.',
          range: [-20, 20],
        },
      ],
      outputs: [
        {
          name: 'action',
          shape: [1, 3],
          dtype: 'float32',
          description: '[vx, vz, pass_logit]; the ball is passed when pass_logit > 0.5.',
          range: [-6, 6],
        },
      ],
      tickHz: 10,
      deterministic: true,
      seed: 7,
      license: 'CC-BY-4.0',
      fallback: 'rebounder-rules',
      sizeBytesMax: 51200,
    },
  ];

  return {
    $schema: 'https://github.com/galactic-ai-team/wgif/blob/main/packages/format/schema/manifest.v0.1.schema.json',
    wgif: '0.1',
    id: 'galactic.examples.court',
    title: 'Galactic Court',
    description: 'Handcrafted basketball court — Phase One proof world for the WGIF format.',
    creator: { name: 'Galactic AI Team', url: 'https://github.com/galactic-ai-team/wgif' },
    created: '2026-11-15T00:00:00Z',
    license: 'CC-BY-4.0',
    mode: 'editable',
    units: 'meters',
    entry: { scene: 'world.glb', preview: 'preview.png', interactions: 'interactions.json', state: 'game-state.json' },
    spawn: { position: [4.0, 1.7, 0], lookAt: [12.425, 1.8, 0] },
    requires: ['scene.glb', 'runtime.rules'],
    models,
    provenance: { generator: 'wgif example-court 0.1.0' },
  };
}

const json = (v: unknown) => utf8(JSON.stringify(v, null, 2) + '\n');

const modelsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../models');

export async function buildCourtWgif(): Promise<Uint8Array> {
  const baseGlb = await buildCourtGlb();
  const polishedGlb = injectCourtVisualPolishGlb(baseGlb);
  const files = {
    'world.glb': polishedGlb,
    'preview.png': renderPreviewPng(),
    'interactions.json': json(interactions()),
    'game-state.json': json(gameState()),
    'models/rebounder.rules.json': new Uint8Array(readFileSync(resolve(modelsDir, 'rebounder.rules.json'))),
    'models/rebounder-mlp.onnx': new Uint8Array(readFileSync(resolve(modelsDir, 'rebounder-mlp.onnx'))),
  };
  return packWgif(courtManifest(), files);
}