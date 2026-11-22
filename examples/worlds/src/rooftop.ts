import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packWgif, type ManifestInput, type ModelEntry } from '@wgif/format';
import { asset, json, preview, type Credit } from './common.js';
import { GlbBuilder, box, cylinder, empty, merge, ring, sphere, torus } from './mesh.js';

const modelsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../models');

/**
 * "Rooftop Night Court": a half court on a parking-garage roof at dusk. The sky and skyline are a
 * real 360° photo (Poly Haven "Rooftop Night" by Greg Zaal, CC0) mapped inside a sky sphere.
 * Exercises an equirectangular panorama, emissive props, and the built-in Shootout with a single
 * hoop and a 45-second clock.
 */
export const ROOF = { halfX: 11, halfZ: 9, rim: [8.425, 3.05, 0] as [number, number, number], rimR: 0.225, ballR: 0.12, skyR: 150 };
export const ROOF_BALL_START: [number, number, number] = [5.2, ROOF.ballR, 1.4];
export const SKY_CREDIT: Credit = {
  file: 'world.glb#sky_rooftop_night',
  title: 'Rooftop Night (360° HDRI, tonemapped)',
  author: 'Greg Zaal (Poly Haven)',
  source: 'https://polyhaven.com/a/rooftop_night',
  license: 'CC0-1.0',
};

function courtLines() {
  const m = empty();
  const y = 0.012, t = 0.05, base = 10, [rx] = ROOF.rim;
  const line = (cx: number, cz: number, sx: number, sz: number) => merge(m, box(cx, y, cz, sx, 0.004, sz));
  line(base, 0, t, 15); // baseline
  line(-4, 0, t, 15); // half-court line
  line(3, 7.5, 14, t);
  line(3, -7.5, 14, t);
  const ft = base - 5.8;
  line((base + ft) / 2, 2.45, 5.8, t);
  line((base + ft) / 2, -2.45, 5.8, t);
  line(ft, 0, t, 4.9);
  merge(m, ring(ft, y + 0.002, 0, 1.8 - t, 1.8, Math.PI / 2, (3 * Math.PI) / 2));
  const r = 6.75, a = Math.asin(6.6 / r);
  merge(m, ring(rx, y + 0.002, 0, r - t, r, Math.PI - a, Math.PI + a, 64));
  const corner = base - (rx - r * Math.cos(a));
  for (const z of [6.6, -6.6]) line(base - corner / 2, z, corner, t);
  merge(m, ring(-4, y + 0.002, 0, 1.8 - t, 1.8));
  return m;
}

async function buildRooftopGlb(): Promise<Uint8Array> {
  const g = new GlbBuilder('RooftopNightCourt', 'wgif example-worlds rooftop');
  const { halfX: X, halfZ: Z, rim, rimR } = ROOF;
  const sky = g.texture('sky_rooftop_night', asset('sky-rooftop-night.jpg'), 'image/jpeg');
  // Black base + emissive panorama: the photo shows its own light, untouched by the scene lights.
  const skyMat = g.material('sky_rooftop_night', [0, 0, 0, 1], { texture: sky, glowTexture: true, emissive: [1, 1, 1], rough: 1, doubleSided: true });
  g.add('sky_rooftop_night', sphere(0, 1.6, 0, ROOF.skyR, 64, 32, true), skyMat, { wgif: { role: 'sky', credit: SKY_CREDIT } });

  const deck = g.material('deck_concrete', [0.4, 0.39, 0.41, 1], { rough: 0.85 });
  const courtTile = g.material('court_tile', [0.13, 0.2, 0.36, 1], { rough: 0.6 });
  const keyTile = g.material('court_key', [0.45, 0.14, 0.32, 1], { rough: 0.6 });
  const paint = g.material('court_paint', [0.95, 0.95, 0.95, 1], { rough: 0.5 });
  const parapetMat = g.material('parapet', [0.55, 0.54, 0.52, 1], { rough: 0.9 });
  const steel = g.material('steel', [0.22, 0.24, 0.27, 1], { rough: 0.4, metal: 0.8 });
  const glass = g.material('backboard', [0.85, 0.92, 1.0, 0.45], { rough: 0.1 });
  const orange = g.material('rim', [1.0, 0.35, 0.05, 1], { rough: 0.4, metal: 0.3 });
  const ballMat = g.material('ball', [0.9, 0.42, 0.1, 1], { rough: 0.7 });
  const bulbs = g.material('string_lights', [1, 0.85, 0.55, 1], { emissive: [1, 0.75, 0.4] });
  const neon = g.material('neon_strip', [0.9, 0.2, 0.8, 1], { emissive: [0.9, 0.15, 0.8] });
  const hvac = g.material('hvac', [0.62, 0.64, 0.66, 1], { rough: 0.5, metal: 0.4 });

  g.add('deck', box(0, -0.1, 0, 2 * X, 0.2, 2 * Z), deck, { wgif: { collider: 'static' } });
  g.add('court_surface', box(3, 0.004, 0, 14.4, 0.006, 15.4), courtTile);
  g.add('court_key_paint', box(10 - 2.9, 0.009, 0, 5.8, 0.004, 4.9), keyTile);
  g.add('court_lines', courtLines(), paint);

  const parapet = empty();
  merge(parapet, box(0, 0.55, -Z - 0.15, 2 * X + 0.6, 1.1, 0.3), box(0, 0.55, Z + 0.15, 2 * X + 0.6, 1.1, 0.3),
    box(X + 0.15, 0.55, 0, 0.3, 1.1, 2 * Z), box(-X - 0.15, 0.55, 0, 0.3, 1.1, 2 * Z));
  g.add('parapet', parapet, parapetMat, { wgif: { collider: 'static' } });
  const strip = empty();
  merge(strip, box(0, 1.12, -Z - 0.15, 2 * X + 0.6, 0.04, 0.32), box(0, 1.12, Z + 0.15, 2 * X + 0.6, 0.04, 0.32),
    box(X + 0.15, 1.12, 0, 0.32, 0.04, 2 * Z), box(-X - 0.15, 1.12, 0, 0.32, 0.04, 2 * Z));
  g.add('parapet_neon', strip, neon);

  // Hoop on the +X end, facing the court.
  const [rx, ry] = rim;
  const boardX = rx + rimR + 0.15, poleX = 10.4;
  const support = empty();
  merge(support, box(poleX, 0.15, 0, 0.9, 0.3, 1.2), cylinder(poleX, 0, 0.3, ry + 0.6, 0.1),
    box((poleX + boardX) / 2 + 0.02, ry + 0.45, 0, Math.abs(poleX - boardX), 0.12, 0.12));
  g.add('hoop_support', support, steel, { wgif: { collider: 'static' } });
  g.add('hoop_backboard', box(boardX, ry + 0.45, 0, 0.05, 1.05, 1.8), glass, { wgif: { collider: 'static' } });
  const rimMesh = torus(rx, ry, 0, rimR, 0.012);
  merge(rimMesh, box(rx + rimR + 0.07, ry, 0, 0.14, 0.02, 0.06));
  g.add('rim', rimMesh, orange, { wgif: { role: 'target', center: rim, radius: rimR } });

  // Lamp posts in the corners with string lights sagging between them.
  const posts = empty();
  const corners: [number, number][] = [[-X + 0.6, -Z + 0.6], [X - 0.6, -Z + 0.6], [X - 0.6, Z - 0.6], [-X + 0.6, Z - 0.6]];
  for (const [x, z] of corners) merge(posts, cylinder(x, z, 0, 4.2, 0.06, 12));
  g.add('light_posts', posts, steel, { wgif: { collider: 'static' } });
  const lights = empty();
  for (let k = 0; k < 4; k++) {
    const [x0, z0] = corners[k]!, [x1, z1] = corners[(k + 1) % 4]!;
    const n = Math.round(Math.hypot(x1 - x0, z1 - z0) / 0.9);
    for (let i = 0; i <= n; i++) {
      const s = i / n, sag = 0.9 * 4 * s * (1 - s);
      merge(lights, sphere(x0 + (x1 - x0) * s, 4.15 - sag, z0 + (z1 - z0) * s, 0.055, 8, 6));
    }
  }
  g.add('string_lights', lights, bulbs);

  // Rooftop clutter at the far end: an HVAC unit, a water tank and a bench.
  g.add('hvac_unit', box(-8.6, 0.8, -6.2, 2.6, 1.6, 2.0), hvac, { wgif: { collider: 'static' } });
  g.add('water_tank', cylinder(-8.8, 6.0, 0, 2.4, 1.0, 24), hvac, { wgif: { collider: 'static' } });
  const bench = empty();
  merge(bench, box(-6, 0.45, 7.9, 2.6, 0.08, 0.55), box(-7.1, 0.21, 7.9, 0.12, 0.42, 0.45), box(-4.9, 0.21, 7.9, 0.12, 0.42, 0.45));
  g.add('bench', bench, steel, { wgif: { collider: 'static' } });

  g.add('ball', sphere(0, 0, 0, ROOF.ballR), ballMat, { wgif: { role: 'grabbable', radius: ROOF.ballR } }).setTranslation(ROOF_BALL_START);
  return g.glb();
}

export function rooftopInteractions() {
  const { halfX: X, halfZ: Z, rim, rimR, ballR } = ROOF;
  return {
    version: '0.1',
    camera: { spawn: [3.6, 1.7, 0], lookAt: [rim[0], 2.6, 0], firstPersonHeight: 1.7, bounds: { min: [-X + 0.3, 0, -Z + 0.3], max: [X - 0.3, 6, Z - 0.3] } },
    objects: [
      { id: 'ball', node: 'ball', kind: 'grabbable', physics: { shape: 'sphere', radius: ballR, mass: 0.6, restitution: 0.75, friction: 0.6 }, spawn: ROOF_BALL_START },
      { id: 'rim', node: 'rim', kind: 'trigger', shape: { type: 'cylinder', center: rim, radius: rimR, height: 0.1 }, on: { enterFromAbove: { event: 'score', target: 'ball' } } },
    ],
    colliders: { static: ['deck', 'parapet', 'hoop_support', 'hoop_backboard', 'light_posts', 'hvac_unit', 'water_tank', 'bench'] },
    minigames: [
      { id: 'rooftop-shootout', type: 'basketball-shooting', title: 'Rooftop 45', ball: 'ball', targets: ['rim'], rules: { durationSec: 45, pointsPerBasket: 2, threePointRadius: 6.75 } },
    ],
  };
}

export function rooftopState() {
  return { version: '0.1', minigames: { 'rooftop-shootout': { highScore: 0, plays: 0 } }, objects: { ball: { position: ROOF_BALL_START } } };
}

export function rooftopManifest(): ManifestInput {
  // Embedded AI (Nova lane): the rooftop ships the same rebounder NPC as the court, as a
  // rules-only model — same state machine, only the bounds and home change (the deck is 22x18 m,
  // the parapet sits at its edge, so the bounds are the deck itself). The rules model is the
  // live behaviour and the source of truth. No ONNX clone is packaged: its agreement was only
  // measured on the court, not on rooftop geometry.
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
  ];
  return {
    $schema: 'https://github.com/galactic-ai-team/wgif/blob/main/packages/format/schema/manifest.v0.1.schema.json',
    wgif: '0.1',
    id: 'galactic.examples.rooftop',
    title: 'Rooftop Night Court',
    description: 'A half court on a city rooftop at dusk, under a real 360° sky photo. String lights, neon trim, one hoop and a 45-second shootout.',
    creator: { name: 'Galactic AI Team', url: 'https://github.com/galactic-ai-team/wgif' },
    created: '2026-11-16T00:00:00Z',
    license: 'CC-BY-4.0',
    mode: 'editable',
    units: 'meters',
    entry: { scene: 'world.glb', preview: 'preview.png', interactions: 'interactions.json', state: 'game-state.json' },
    spawn: { position: [3.6, 1.7, 0], lookAt: [ROOF.rim[0], 2.6, 0] },
    requires: ['scene.glb', 'interaction.camera', 'interaction.grab', 'interaction.trigger', 'minigame.basketball-shooting', 'state.initial', 'runtime.rules'],
    models,
    provenance: { generator: 'wgif example-worlds 0.1.0 (rooftop)', params: { source: 'examples/worlds/src/rooftop.ts' } },
    extensions: { 'x-credits': [SKY_CREDIT] },
  };
}

export async function buildRooftopWgif(): Promise<Uint8Array> {
  return packWgif(rooftopManifest(), {
    'world.glb': await buildRooftopGlb(),
    'preview.png': preview('rooftop', [70, 52, 110], [230, 120, 160]),
    'interactions.json': json(rooftopInteractions()),
    'game-state.json': json(rooftopState()),
    'models/rebounder.rules.json': new Uint8Array(readFileSync(resolve(modelsDir, 'rooftop-rebounder.rules.json'))),
  });
}
