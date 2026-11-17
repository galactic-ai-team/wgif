import { packWgif, type ManifestInput } from '@wgif/format';
import { json, preview } from './common.js';
import { GlbBuilder, box, cone, cylinder, empty, extrudeX, loft, merge, place, prng, ring, type Mesh, type Station } from './mesh.js';

/**
 * "Neon Lot": a procedural coupe on a showroom turntable in the middle of a night-time car lot.
 * Orbit the car, or press Drive and take it round the lot: a cone slalom, a tabletop jump, concrete
 * barriers and a painted ring track. Exercises the player's vehicle component (an interactions.json
 * `interactions[]` entry of type `vehicle`, see docs/notes/vehicle-component.md): body and wheel
 * nodes, a chase camera, arcade physics against the static colliders, and the lot's bounds.
 *
 * Everything is generated here (no textures, no third-party assets), so there is nothing to credit.
 */
export const LOT = { half: 30, wheelBase: 2.6, track: 0.84, wheelR: 0.34, wheelW: 0.26 };
export const CAR_SPAWN: [number, number, number] = [0, 0, 0];
export const WALK_SPAWN: [number, number, number] = [5.5, 1.7, -7.5];

/** Side silhouette of the body, nose (-Z) to tail (+Z). */
const BODY: Station[] = [
  { z: -2.18, yb: 0.34, yt: 0.56, hw: 0.7 },
  { z: -2.1, yb: 0.27, yt: 0.66, hw: 0.84 },
  { z: -1.75, yb: 0.24, yt: 0.73, hw: 0.9 },
  { z: -1.0, yb: 0.23, yt: 0.82, hw: 0.93 },
  { z: -0.3, yb: 0.23, yt: 0.9, hw: 0.94 },
  { z: 0.6, yb: 0.23, yt: 0.92, hw: 0.95 },
  { z: 1.4, yb: 0.24, yt: 0.95, hw: 0.95 },
  { z: 1.95, yb: 0.27, yt: 0.95, hw: 0.9 },
  { z: 2.15, yb: 0.33, yt: 0.86, hw: 0.82 },
  { z: 2.2, yb: 0.4, yt: 0.78, hw: 0.7 },
];

/** The glass canopy: a raked windscreen, a short roof and a fastback rear window. */
const CANOPY: Station[] = [
  { z: -0.75, yb: 0.8, yt: 0.86, hw: 0.8 },
  { z: -0.4, yb: 0.8, yt: 1.12, hw: 0.77 },
  { z: -0.05, yb: 0.8, yt: 1.3, hw: 0.72 },
  { z: 0.45, yb: 0.8, yt: 1.33, hw: 0.7 },
  { z: 0.95, yb: 0.82, yt: 1.2, hw: 0.7 },
  { z: 1.45, yb: 0.86, yt: 1.02, hw: 0.72 },
  { z: 1.75, yb: 0.9, yt: 0.96, hw: 0.72 },
];

/** A wheel centred on its node, axle along X: tyre, rim and five spokes, so a turning wheel shows. */
function wheel(outward: 1 | -1): { tyre: Mesh; rim: Mesh; hub: Mesh } {
  const { wheelR: r, wheelW: w } = LOT;
  const along = (m: Mesh): Mesh => place(m, { rotZ: Math.PI / 2 });
  const tyre = along(cylinder(0, 0, -w / 2, w / 2, r, 24));
  const rim = along(cylinder(0, 0, outward * (w / 2 - 0.02), outward * (w / 2 + 0.006), r * 0.68, 20));
  const hub = empty();
  merge(hub, along(cylinder(0, 0, outward * (w / 2), outward * (w / 2 + 0.03), 0.06, 10)));
  for (let k = 0; k < 5; k++) {
    const spoke = box(outward * (w / 2 + 0.012), 0, 0, 0.02, r * 1.2, 0.06);
    merge(hub, spoke);
    // Turn the spoke about the axle (X).
    const a = (k / 5) * Math.PI * 2, p = hub.positions, n = hub.normals, from = p.length - spoke.positions.length;
    for (let i = from; i < p.length; i += 3) {
      const y = p[i + 1]!, z = p[i + 2]!, ny = n[i + 1]!, nz = n[i + 2]!;
      p[i + 1] = y * Math.cos(a) - z * Math.sin(a); p[i + 2] = y * Math.sin(a) + z * Math.cos(a);
      n[i + 1] = ny * Math.cos(a) - nz * Math.sin(a); n[i + 2] = ny * Math.sin(a) + nz * Math.cos(a);
    }
  }
  return { tyre, rim, hub };
}

async function buildCarGlb(): Promise<Uint8Array> {
  const g = new GlbBuilder('NeonLot', 'wgif example-worlds car');
  const H = LOT.half;

  const asphalt = g.material('asphalt', [0.085, 0.09, 0.105, 1], { rough: 0.92 });
  const paintWhite = g.material('lane_paint', [0.85, 0.86, 0.9, 1], { rough: 0.6 });
  const paintYellow = g.material('lane_yellow', [0.95, 0.75, 0.15, 1], { rough: 0.6 });
  const concrete = g.material('barrier_concrete', [0.6, 0.6, 0.62, 1], { rough: 0.9 });
  const stripeRed = g.material('barrier_stripe', [0.85, 0.12, 0.12, 1], { rough: 0.7 });
  const coneOrange = g.material('cone_orange', [1, 0.38, 0.05, 1], { rough: 0.6, emissive: [0.25, 0.07, 0] });
  const coneWhite = g.material('cone_band', [0.95, 0.95, 0.95, 1], { rough: 0.5 });
  const rampMat = g.material('ramp_steel', [0.3, 0.33, 0.38, 1], { rough: 0.5, metal: 0.6 });
  const rampEdge = g.material('ramp_chevrons', [1, 0.8, 0.1, 1], { rough: 0.5, emissive: [0.35, 0.25, 0] });
  const steel = g.material('steel', [0.25, 0.27, 0.3, 1], { rough: 0.4, metal: 0.8 });
  const lamp = g.material('lamp_glow', [1, 0.9, 0.7, 1], { emissive: [1, 0.85, 0.6] });
  const neonCyan = g.material('neon_cyan', [0.2, 0.9, 1, 1], { emissive: [0.1, 0.85, 1] });
  const neonPink = g.material('neon_pink', [1, 0.2, 0.7, 1], { emissive: [1, 0.15, 0.65] });
  const turntable = g.material('turntable', [0.16, 0.17, 0.2, 1], { rough: 0.35, metal: 0.7 });
  const skyline = g.material('skyline', [0.04, 0.045, 0.07, 1], { rough: 1 });
  const windows = g.material('skyline_windows', [1, 0.78, 0.45, 1], { emissive: [0.9, 0.62, 0.3] });

  // Ground and markings.
  g.add('lot_ground', box(0, -0.1, 0, 2 * H + 8, 0.2, 2 * H + 8), asphalt);
  const lines = empty();
  for (let i = -5; i <= 5; i++) {
    // Parking bays along the north and south edges.
    merge(lines, box(i * 3.2, 0.006, -H + 3.5, 0.12, 0.004, 5), box(i * 3.2, 0.006, H - 3.5, 0.12, 0.004, 5));
  }
  merge(lines, ring(0, 0.006, 0, 15.9, 16.1, 0, Math.PI * 2, 96), ring(0, 0.006, 0, 21.9, 22.1, 0, Math.PI * 2, 112));
  g.add('lane_lines', lines, paintWhite);
  const dashes = empty();
  for (let k = 0; k < 40; k++) {
    const a0 = (k / 40) * Math.PI * 2;
    merge(dashes, ring(0, 0.007, 0, 18.9, 19.1, a0, a0 + Math.PI / 60, 6));
  }
  g.add('lane_dashes', dashes, paintYellow);

  // The showroom turntable the car starts on: flush with the ground, ringed with neon.
  g.add('turntable', cylinder(0, 0, 0, 0.015, 3.6, 64), turntable);
  g.add('turntable_neon', ring(0, 0.02, 0, 3.55, 3.7, 0, Math.PI * 2, 96), neonCyan);

  // Perimeter barriers (jersey style), with red reflector stripes.
  const barriers = empty(), stripes = empty();
  for (const s of [-1, 1]) {
    merge(barriers, box(0, 0.45, s * (H + 0.25), 2 * H + 1, 0.9, 0.5), box(s * (H + 0.25), 0.45, 0, 0.5, 0.9, 2 * H + 1));
    merge(stripes, box(0, 0.6, s * H, 2 * H, 0.12, 0.02), box(s * H, 0.6, 0, 0.02, 0.12, 2 * H));
  }
  g.add('perimeter_barriers', barriers, concrete);
  g.add('barrier_stripes', stripes, stripeRed);

  // A chicane of jersey barriers on the east side.
  const jersey = empty();
  const jerseyProfile: [number, number][] = [[-0.4, 0], [0.4, 0], [0.18, 0.35], [0.12, 0.9], [-0.12, 0.9], [-0.18, 0.35]];
  for (const [x, z, turn] of [[24, -8, 0], [24, -2, 0], [19.5, 5, Math.PI / 2], [25.5, 11, Math.PI / 2]] as [number, number, number][]) {
    merge(jersey, place(extrudeX(jerseyProfile, -1.8, 1.8), { rotY: turn, at: [x, 0, z] }));
  }
  g.add('jersey_barriers', jersey, concrete);

  // Cone slalom down the west side.
  const cones = empty(), bands = empty();
  for (let i = 0; i < 7; i++) {
    const x = -19 + (i % 2 ? 1.4 : -1.4), z = -15 + i * 5;
    merge(cones, cone(x, z, 0, 0.7, 0.24, 0.035, 16), box(x, 0.02, z, 0.6, 0.04, 0.6));
    merge(bands, cone(x, z, 0.36, 0.46, 0.135, 0.11, 16));
  }
  g.add('cones', cones, coneOrange);
  g.add('cone_bands', bands, coneWhite);

  // Tabletop jump on the south side: up 4.5 m, flat 3 m, down 4.5 m, 0.9 m high.
  const jump: [number, number][] = [[-6, 0], [6, 0], [1.5, 0.9], [-1.5, 0.9]];
  g.add('jump_ramp', place(extrudeX(jump, -2.5, 2.5), { rotY: Math.PI / 2, at: [0, 0, 22] }), rampMat);
  const edge = empty();
  for (const s of [-1, 1]) merge(edge, box(0, 0.92, 22 + s * 2.45, 3, 0.04, 0.1));
  g.add('jump_edges', edge, rampEdge);

  // Light posts around the lot.
  const posts = empty(), lamps = empty();
  for (const [x, z] of [[-26, -26], [0, -27], [26, -26], [-27, 0], [27, 0], [-26, 26], [0, 27], [26, 26]] as [number, number][]) {
    merge(posts, cylinder(x, z, 0, 7, 0.12, 10), box(x * 0.97, 7, z * 0.97, 0.3, 0.12, 0.3));
    merge(lamps, box(x * 0.97, 6.9, z * 0.97, 0.9, 0.08, 0.5));
  }
  g.add('light_posts', posts, steel);
  g.add('lamps', lamps, lamp);

  // Neon arch over the start of the ring track.
  const arch = empty();
  merge(arch, box(-16.2, 2.4, 0, 0.25, 4.8, 0.25), box(-21.8, 2.4, 0, 0.25, 4.8, 0.25), box(-19, 4.9, 0, 6, 0.3, 0.3));
  g.add('arch_frame', arch, steel);
  const archGlow = empty();
  merge(archGlow, box(-19, 4.72, 0.17, 5.4, 0.08, 0.04), box(-19, 4.72, -0.17, 5.4, 0.08, 0.04));
  g.add('arch_neon', archGlow, neonPink);

  // A dark skyline all round, with lit windows.
  const towers = empty(), lit = empty();
  const rand = prng(0xca7);
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2, d = 70 + rand() * 20, w = 6 + rand() * 8, h = 12 + rand() * 30;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    merge(towers, place(box(0, h / 2, 0, w, h, w), { rotY: -a, at: [x, 0, z] }));
    for (let f = 0; f < h / 3 - 1; f++) {
      if (rand() < 0.45) continue;
      merge(lit, place(box(-w / 2 - 0.05, 2 + f * 3, (rand() - 0.5) * w * 0.6, 0.1, 0.9, 1.4 + rand() * 2), { rotY: -a, at: [x, 0, z] }));
    }
  }
  g.add('skyline', towers, skyline);
  g.add('skyline_windows', lit, windows);

  // The car: one node at the ground point under the body, facing -Z, with its wheels as child nodes.
  const car = g.node('car', undefined, CAR_SPAWN);
  const carPaint = g.material('car_paint', [0.72, 0.04, 0.08, 1], { rough: 0.28, metal: 0.45 });
  const glass = g.material('car_glass', [0.04, 0.06, 0.1, 1], { rough: 0.05, metal: 0.9 });
  const trim = g.material('car_trim', [0.03, 0.03, 0.035, 1], { rough: 0.6 });
  const chrome = g.material('car_chrome', [0.85, 0.86, 0.9, 1], { rough: 0.15, metal: 1 });
  const head = g.material('car_headlights', [1, 1, 1, 1], { emissive: [1, 0.97, 0.88] });
  const tail = g.material('car_taillights', [1, 0.05, 0.05, 1], { emissive: [1, 0.02, 0.04] });
  const tyreMat = g.material('car_tyres', [0.05, 0.05, 0.055, 1], { rough: 0.85 });
  const stripe = g.material('car_stripes', [0.95, 0.95, 0.97, 1], { rough: 0.3, metal: 0.2 });

  g.add('car_body', loft(BODY, 3.2), carPaint, undefined, car);
  g.add('car_canopy', loft(CANOPY, 2.6), glass, undefined, car);
  // Twin racing stripes over hood, roof and deck: thin lofts just above the paint.
  const stripes2 = empty();
  for (const x of [-0.17, 0.17]) {
    const lift = (s: Station, top: number): Station => ({ z: s.z, yb: top - 0.004, yt: top + 0.012, hw: 0.09 });
    const hood = BODY.slice(2, 5).map((s) => lift(s, s.yt));
    const line = loft([...hood, lift({ z: -0.68, yb: 0, yt: 0.86, hw: 0 }, 0.88), lift({ z: -0.4, yb: 0, yt: 1.12, hw: 0 }, 1.135), lift({ z: -0.05, yb: 0, yt: 1.3, hw: 0 }, 1.315),
      lift({ z: 0.45, yb: 0, yt: 1.33, hw: 0 }, 1.345), lift({ z: 0.95, yb: 0, yt: 1.2, hw: 0 }, 1.215), lift({ z: 1.45, yb: 0, yt: 1.02, hw: 0 }, 1.035), lift({ z: 2.0, yb: 0, yt: 0.95, hw: 0 }, 0.955)], 6, 8);
    merge(stripes2, place(line, { at: [x, 0, 0] }));
  }
  g.add('car_stripes', stripes2, stripe, undefined, car);
  const trimMesh = empty();
  merge(trimMesh,
    box(0, 0.42, -2.16, 1.1, 0.16, 0.08), // grille
    box(0, 0.3, 2.17, 1.3, 0.14, 0.08), // rear diffuser
    box(0, 0.22, 0, 1.7, 0.06, 3.9), // sills / underside
    box(0, 1.0, 2.02, 1.5, 0.04, 0.28), // spoiler blade
    box(-0.6, 0.97, 1.95, 0.06, 0.08, 0.06), box(0.6, 0.97, 1.95, 0.06, 0.08, 0.06), // spoiler posts
    box(-0.95, 0.88, -0.62, 0.14, 0.08, 0.16), box(0.95, 0.88, -0.62, 0.14, 0.08, 0.16), // mirrors
  );
  g.add('car_trim', trimMesh, trim, undefined, car);
  const lamps2 = empty();
  for (const s of [-1, 1]) merge(lamps2, place(box(0, 0, 0, 0.42, 0.09, 0.08), { rotY: s * 0.18, at: [s * 0.58, 0.62, -2.06] }));
  g.add('car_headlights', lamps2, head, undefined, car);
  const tails = empty();
  merge(tails, box(0, 0.8, 2.16, 1.4, 0.07, 0.06), box(-0.62, 0.8, 2.14, 0.28, 0.14, 0.08), box(0.62, 0.8, 2.14, 0.28, 0.14, 0.08));
  g.add('car_taillights', tails, tail, undefined, car);
  const exhausts = empty();
  // Tailpipes: cylinders turned to point backwards (+Z).
  for (const x of [-0.35, 0.35]) merge(exhausts, place(place(cylinder(0, 0, -0.08, 0.08, 0.05, 12), { rotZ: Math.PI / 2 }), { rotY: Math.PI / 2, at: [x, 0.3, 2.2] }));
  g.add('car_exhausts', exhausts, chrome, undefined, car);

  for (const [name, x, z] of [['wheel_fl', -1, -1], ['wheel_fr', 1, -1], ['wheel_rl', -1, 1], ['wheel_rr', 1, 1]] as [string, 1 | -1, number][]) {
    const node = g.node(name, car, [x * LOT.track, LOT.wheelR, z * (LOT.wheelBase / 2)]);
    const w = wheel(x);
    g.add(`${name}_tyre`, w.tyre, tyreMat, undefined, node);
    g.add(`${name}_rim`, w.rim, chrome, undefined, node);
    g.add(`${name}_hub`, w.hub, trim, undefined, node);
  }
  return g.glb();
}

export function carInteractions() {
  const H = LOT.half;
  return {
    version: '0.1',
    camera: { spawn: WALK_SPAWN, lookAt: [0, 0.7, 0], firstPersonHeight: 1.7, bounds: { min: [-H + 0.2, -1, -H + 0.2], max: [H - 0.2, 12, H - 0.2] } },
    objects: [],
    colliders: { static: ['lot_ground', 'turntable', 'perimeter_barriers', 'jersey_barriers', 'cones', 'jump_ramp', 'light_posts', 'arch_frame'] },
    interactions: [
      {
        type: 'vehicle',
        id: 'car',
        node: 'car',
        spawn: CAR_SPAWN,
        yaw: 0,
        drive: { maxSpeed: 17, reverseSpeed: 6, accel: 8, brake: 18, maxSteer: 0.6, wheelBase: LOT.wheelBase },
        body: { radius: 0.9, length: 4.4 },
        wheels: { front: ['wheel_fl', 'wheel_fr'], rear: ['wheel_rl', 'wheel_rr'], radius: LOT.wheelR },
        camera: { distance: 6.5, height: 2.6 },
      },
    ],
  };
}

export function carState() {
  return { version: '0.1', minigames: {}, objects: {} };
}

export function carManifest(): ManifestInput {
  return {
    $schema: 'https://github.com/galactic-ai-team/wgif/blob/main/packages/format/schema/manifest.v0.1.schema.json',
    wgif: '0.1',
    id: 'galactic.examples.car',
    title: 'Neon Lot',
    description: 'A red coupe on a showroom turntable in a night-time car lot. Orbit it, then press Drive (F or Enter) and take it round: cone slalom, a tabletop jump, barriers and a ring track.',
    creator: { name: 'Galactic AI Team', url: 'https://github.com/galactic-ai-team/wgif' },
    created: '2026-11-16T00:00:00Z',
    license: 'CC-BY-4.0',
    mode: 'editable',
    units: 'meters',
    entry: { scene: 'world.glb', preview: 'preview.png', interactions: 'interactions.json', state: 'game-state.json' },
    spawn: { position: WALK_SPAWN, lookAt: [0, 0.7, 0] },
    // No `interaction.vehicle` here yet: it is not in the v0.1 registry (see docs/notes/vehicle-component.md).
    // A player without vehicles still opens the lot and shows the car standing on its turntable.
    requires: ['scene.glb', 'interaction.camera', 'state.initial'],
    provenance: { generator: 'wgif example-worlds 0.1.0 (car)', params: { source: 'examples/worlds/src/car.ts' } },
  };
}

export async function buildCarWgif(): Promise<Uint8Array> {
  return packWgif(carManifest(), {
    'world.glb': await buildCarGlb(),
    'preview.png': preview('car', [16, 18, 30], [200, 30, 40]),
    'interactions.json': json(carInteractions()),
    'game-state.json': json(carState()),
  });
}
