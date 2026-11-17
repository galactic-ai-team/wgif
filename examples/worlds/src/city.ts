import { createHash } from 'node:crypto';
import { packManifestAndFiles, packWgif, readGlbJson, signManifest, unpackWgif, utf8, type ManifestInput, type WgifFiles } from '@wgif/format';
import { encodePng } from '../../court/src/preview.js';
import { json, preview } from './common.js';
import { GlbBuilder, box, cylinder, empty, merge, prng, sphere, torus } from './mesh.js';

/**
 * "Neon Grid City": the stress / edge-case world. Hundreds of separately named building nodes with
 * a procedural window texture, a dozen grabbable orbs, four neon ring targets, a signed base and
 * three overlay layers on top (mode "layered"). Built to sit just under the Phase One 1 MiB world
 * budget so phones get a heavy-but-legal file to open, edit and export.
 *
 * The `xl` profile builds the same city bigger (well over the 1 MiB budget, still far inside the
 * spec's safety ceilings) for device testing only; it is never committed or scanned by CI.
 */
export interface CityProfile {
  name: 'city' | 'city-xl';
  grid: number;
  texture: number;
}
export const CITY: CityProfile = { name: 'city', grid: 16, texture: 320 };
export const CITY_XL: CityProfile = { name: 'city-xl', grid: 34, texture: 1536 };

const BLOCK = 6; // metres per city block (building plot + street)
export const ORB_COUNT = 12;
const ORB_R = 0.2;

/**
 * A PUBLIC, deliberately well-known test key so the sample's signature is reproducible. It proves
 * only that the bytes were not changed since the generator signed them, never who made them.
 */
export const CITY_TEST_KEY_SEED = 'wgif sample city - PUBLIC TEST KEY - proves nothing about origin';
export const citySecretKey = (): Uint8Array => new Uint8Array(createHash('sha256').update(CITY_TEST_KEY_SEED).digest());

/** Window texture: a grid of lit and dark windows with some grain, deterministic per seed. */
function windowTexture(size: number): Uint8Array {
  const rand = prng(0xc17e);
  const rgb = new Uint8Array(size * size * 3);
  const cell = 16;
  const lit: number[] = [];
  for (let i = 0; i < (size / cell) ** 2; i++) lit.push(rand());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = (y * size + x) * 3, cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      const inWin = x % cell > 3 && x % cell < cell - 3 && y % cell > 4 && y % cell < cell - 2;
      const l = lit[cy * (size / cell) + cx]!;
      const grain = Math.floor(rand() * 26);
      let c: [number, number, number];
      if (!inWin) c = [18 + grain, 20 + grain, 30 + grain];
      else if (l > 0.55) c = l > 0.9 ? [120 + grain, 230, 255] : [255, 196 + grain, 110 + grain];
      else c = [30 + grain, 40 + grain, 70 + grain];
      rgb[k] = c[0]; rgb[k + 1] = c[1]; rgb[k + 2] = c[2];
    }
  }
  return encodePng(size, size, rgb);
}

export const orbStart = (i: number): [number, number, number] => {
  const a = (i / ORB_COUNT) * Math.PI * 2;
  return [Math.cos(a) * 3.2, ORB_R, Math.sin(a) * 3.2];
};
export const ringCenter = (i: number): [number, number, number] => {
  const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
  return [Math.cos(a) * 7.5, 2.4, Math.sin(a) * 7.5];
};

async function buildCityGlb(p: CityProfile): Promise<{ glb: Uint8Array; buildings: number }> {
  const g = new GlbBuilder('NeonGridCity', 'wgif example-worlds city');
  const half = (p.grid * BLOCK) / 2;
  const tex = g.texture('windows', windowTexture(p.texture), 'image/png');
  const towerMats = [
    g.material('tower_cyan', [0.6, 0.9, 1, 1], { texture: tex, glowTexture: true, emissive: [0.6, 0.8, 1], rough: 0.4, metal: 0.3 }),
    g.material('tower_amber', [1, 0.85, 0.6, 1], { texture: tex, glowTexture: true, emissive: [1, 0.75, 0.45], rough: 0.4, metal: 0.3 }),
    g.material('tower_violet', [0.8, 0.6, 1, 1], { texture: tex, glowTexture: true, emissive: [0.75, 0.5, 1], rough: 0.4, metal: 0.3 }),
  ];
  const street = g.material('street', [0.06, 0.06, 0.09, 1], { rough: 0.5, metal: 0.2 });
  const lane = g.material('lane_neon', [0.1, 0.9, 1, 1], { emissive: [0.05, 0.8, 1] });
  const plaza = g.material('plaza', [0.16, 0.14, 0.22, 1], { rough: 0.4 });
  const ringMat = g.material('ring_neon', [1, 0.2, 0.7, 1], { emissive: [1, 0.15, 0.6] });
  const poleMat = g.material('ring_pole', [0.2, 0.2, 0.25, 1], { metal: 0.8, rough: 0.3 });
  const orbMats = [
    g.material('orb_pink', [1, 0.3, 0.75, 1], { emissive: [0.6, 0.1, 0.4], rough: 0.2 }),
    g.material('orb_lime', [0.6, 1, 0.3, 1], { emissive: [0.3, 0.6, 0.1], rough: 0.2 }),
    g.material('orb_cyan', [0.3, 0.9, 1, 1], { emissive: [0.1, 0.5, 0.6], rough: 0.2 }),
  ];

  g.add('ground', box(0, -0.1, 0, 2 * half + 10, 0.2, 2 * half + 10), street, { wgif: { collider: 'static' } });
  g.add('plaza', cylinder(0, 0, 0, 0.03, 11, 48), plaza, { wgif: { collider: 'static' } });
  const lanes = empty();
  for (let i = 0; i <= p.grid; i++) {
    const c = -half + i * BLOCK;
    merge(lanes, box(c, 0.012, 0, 0.12, 0.01, 2 * half), box(0, 0.012, c, 2 * half, 0.01, 0.12));
  }
  g.add('lane_lines', lanes, lane);

  const rand = prng(0x5eed + p.grid);
  let buildings = 0;
  const solid: string[] = [];
  for (let ix = 0; ix < p.grid; ix++) {
    for (let iz = 0; iz < p.grid; iz++) {
      const cx = -half + (ix + 0.5) * BLOCK, cz = -half + (iz + 0.5) * BLOCK;
      if (Math.hypot(cx, cz) < 13) continue; // keep the central plaza open
      const dist = Math.hypot(cx, cz) / half;
      const h = 4 + rand() * 10 + (1 - Math.min(1, dist)) * 26 * rand();
      const w = 2.6 + rand() * 1.8, d = 2.6 + rand() * 1.8;
      const m = box(cx, h / 2, cz, w, h, d, 0.25);
      if (rand() > 0.7) merge(m, box(cx, h + 0.6, cz, w * 0.5, 1.2, d * 0.5, 0.25)); // rooftop block
      const name = `tower_${String(ix).padStart(2, '0')}_${String(iz).padStart(2, '0')}`;
      g.add(name, m, towerMats[(ix * 7 + iz * 3) % 3]!, { wgif: { collider: 'static' } });
      solid.push(name);
      buildings++;
    }
  }

  for (let i = 0; i < 4; i++) {
    const [x, y, z] = ringCenter(i);
    g.add(`ring_${i}`, torus(x, y, z, 0.45, 0.04, 32, 8), ringMat, { wgif: { role: 'target', center: [x, y, z], radius: 0.45 } });
    g.add(`ring_${i}_pole`, cylinder(x + 0.5, z, 0, y, 0.05, 10), poleMat, { wgif: { collider: 'static' } });
    solid.push(`ring_${i}_pole`);
  }
  for (let i = 0; i < ORB_COUNT; i++) {
    g.add(`orb_${i}`, sphere(0, 0, 0, ORB_R, 16, 10), orbMats[i % 3]!, { wgif: { role: 'grabbable', radius: ORB_R } }).setTranslation(orbStart(i));
  }
  return { glb: await g.glb(), buildings };
}

export function cityInteractions(p: CityProfile, staticColliders: string[]) {
  const half = (p.grid * BLOCK) / 2;
  return {
    version: '0.1',
    camera: { spawn: [0, 1.7, 9], lookAt: [0, 4, 0], firstPersonHeight: 1.7, bounds: { min: [-half, 0, -half], max: [half, 60, half] } },
    objects: [
      ...Array.from({ length: ORB_COUNT }, (_, i) => ({
        id: `orb_${i}`, node: `orb_${i}`, kind: 'grabbable',
        physics: { shape: 'sphere', radius: ORB_R, mass: 0.4, restitution: 0.6, friction: 0.5 }, spawn: orbStart(i),
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `ring_${i}`, node: `ring_${i}`, kind: 'trigger',
        shape: { type: 'cylinder', center: ringCenter(i), radius: 0.45, height: 0.1 },
        on: { enterFromAbove: { event: 'score' } },
      })),
    ],
    colliders: { static: ['ground', 'plaza', ...staticColliders] },
  };
}

/** Three overlay layers: neon signs (adds), a drone swarm (adds), and a remix (move + remove). */
export function cityLayers(p: CityProfile): { id: string; author: string; body: unknown }[] {
  const half = (p.grid * BLOCK) / 2;
  const rand = prng(0x1a7e5 + p.grid);
  const palette = ['#FF2BD6', '#22F3FF', '#B6FF3B', '#FFB13B', '#8A5CFF'];
  const signs = Array.from({ length: Math.min(160, p.grid * 6) }, (_, i) => {
    const x = (rand() * 2 - 1) * half, z = (rand() * 2 - 1) * half;
    return { id: `sign_${i}`, primitive: 'box', position: [x, 3 + rand() * 12, z], size: [0.2 + rand() * 2, 0.4 + rand() * 1.2, 0.15], color: palette[i % palette.length]! };
  });
  const drones = Array.from({ length: Math.min(120, p.grid * 4) }, (_, i) => ({
    id: `drone_${i}`, primitive: 'sphere', position: [(rand() * 2 - 1) * half, 8 + rand() * 20, (rand() * 2 - 1) * half], size: [0.5, 0.5, 0.5], color: palette[(i + 2) % palette.length]!,
  }));
  return [
    { id: 'neon-signs', author: 'Lumi (sample generator)', body: { version: '0.1', add: signs } },
    { id: 'drone-swarm', author: 'Lumi (sample generator)', body: { version: '0.1', add: drones } },
    { id: 'remix', author: 'Lumi (sample generator)', body: { version: '0.1', move: [{ id: 'orb_0', position: [0, 1.2, 0] }], remove: ['tower_00_00'] } },
  ];
}

export function cityManifest(p: CityProfile): ManifestInput {
  const xl = p.name === 'city-xl';
  return {
    $schema: 'https://github.com/galactic-ai-team/wgif/blob/main/packages/format/schema/manifest.v0.1.schema.json',
    wgif: '0.1',
    id: xl ? 'galactic.examples.city-xl' : 'galactic.examples.city',
    title: xl ? 'Neon Grid City XL (stress)' : 'Neon Grid City (stress)',
    description: `Stress test: ${p.grid}x${p.grid} blocks of glowing towers, ${ORB_COUNT} orbs to toss through four neon rings, a signed base world and three overlay layers.${xl ? ' XL device-test build: over the 1 MiB Phase One budget on purpose.' : ''}`,
    creator: { name: 'Galactic AI Team', url: 'https://github.com/galactic-ai-team/wgif' },
    created: '2026-11-16T00:00:00Z',
    license: 'CC-BY-4.0',
    mode: 'layered',
    units: 'meters',
    entry: { scene: 'world.glb', preview: 'preview.png', interactions: 'interactions.json' },
    spawn: { position: [0, 1.7, 9], lookAt: [0, 4, 0] },
    requires: ['scene.glb', 'interaction.camera', 'interaction.grab', 'interaction.trigger', 'layer.primitives'],
    provenance: { generator: 'wgif example-worlds 0.1.0 (city)', params: { source: 'examples/worlds/src/city.ts', grid: p.grid, texture: p.texture } },
    extensions: { 'x-test-signature': { note: 'Signed with a PUBLIC test key derived from CITY_TEST_KEY_SEED in examples/worlds/src/city.ts. A valid signature here proves only integrity, not origin.' } },
  };
}

export async function buildCityWgif(p: CityProfile = CITY): Promise<Uint8Array> {
  const { glb } = await buildCityGlb(p);
  // Collider names straight from the scene: every tower plus the ring poles.
  const nodes = (readGlbJson(glb) as { nodes: { name?: string; extras?: { wgif?: { collider?: string } } }[] }).nodes;
  const scene = nodes.filter((n) => n.extras?.wgif?.collider === 'static' && n.name !== 'ground' && n.name !== 'plaza').map((n) => n.name!);
  const files: WgifFiles = {
    'world.glb': glb,
    'preview.png': preview(p.name === 'city-xl' ? 'city' : p.name, [12, 10, 28], [255, 43, 214]),
    'interactions.json': json(cityInteractions(p, scene)),
  };
  // 1. Pack and sign the base world (layers are excluded from the signed view by design).
  const base = (await unpackWgif(await packWgif(cityManifest(p), files))).manifest;
  const signed = await signManifest(base, citySecretKey());
  // 2. Append the overlay layers: the base signature must stay valid.
  const layers = cityLayers(p);
  for (const l of layers) files[`layers/${l.id}.json`] = utf8(JSON.stringify(l.body));
  const withLayers = await packWgif(
    { ...signed, layers: layers.map((l) => ({ id: l.id, path: `layers/${l.id}.json`, author: l.author, created: '2026-11-16T00:00:00Z' })), files: undefined },
    files,
  );
  // Re-pack from the parsed manifest so files[] order and roles match what readers see.
  const world = await unpackWgif(withLayers);
  return packManifestAndFiles(world.manifest, world.files);
}
