import { packWgif, type ManifestInput } from '@wgif/format';
import { asset, json, jpegSize, preview, type Credit } from './common.js';
import { GlbBuilder, box, cylinder, merge, empty, picture, sphere, torus } from './mesh.js';

/**
 * "Open-Air Gallery": a roofless gallery room under the player's night sky, hung with six
 * public-domain paintings (Wikimedia Commons). Exercises embedded JPEG textures, locked mode,
 * wall colliders for the walker, and one grabbable object.
 */
export const GALLERY = { name: 'gallery', halfX: 9, halfZ: 6, wallH: 4.5, wall: 0.3 } as const;

interface Art { file: string; title: string; author: string; source: string; wall: '+z' | '-z' | '+x' | '-x'; at: number }

export const ARTWORKS: Art[] = [
  { file: 'art-great-wave.jpg', title: 'The Great Wave off Kanagawa (c. 1831)', author: 'Katsushika Hokusai', source: 'https://commons.wikimedia.org/wiki/File:Tsunami_by_hokusai_19th_century.jpg', wall: '+z', at: -4 },
  { file: 'art-starry-night.jpg', title: 'The Starry Night (1889)', author: 'Vincent van Gogh', source: 'https://commons.wikimedia.org/wiki/File:Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg', wall: '+z', at: 4 },
  { file: 'art-pearl-earring.jpg', title: 'Girl with a Pearl Earring (c. 1665)', author: 'Johannes Vermeer', source: 'https://commons.wikimedia.org/wiki/File:1665_Girl_with_a_Pearl_Earring.jpg', wall: '+x', at: 0 },
  { file: 'art-impression-sunrise.jpg', title: 'Impression, Sunrise (1872)', author: 'Claude Monet', source: 'https://commons.wikimedia.org/wiki/File:Claude_Monet,_Impression,_soleil_levant.jpg', wall: '-z', at: 4 },
  { file: 'art-birth-of-venus.jpg', title: 'The Birth of Venus (c. 1485)', author: 'Sandro Botticelli', source: 'https://commons.wikimedia.org/wiki/File:Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project_-_edited.jpg', wall: '-z', at: -4 },
  { file: 'art-the-kiss.jpg', title: 'The Kiss (1907–1908)', author: 'Gustav Klimt', source: 'https://commons.wikimedia.org/wiki/File:The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg', wall: '-x', at: 0 },
];

export const ORB_START: [number, number, number] = [0, 1.18, 0];

async function buildGalleryGlb(): Promise<Uint8Array> {
  const g = new GlbBuilder('OpenAirGallery', 'wgif example-worlds gallery');
  const { halfX: X, halfZ: Z, wallH: H, wall: T } = GALLERY;
  const floorMat = g.material('floor_stone', [0.34, 0.31, 0.29, 1], { rough: 0.35 });
  const wallMat = g.material('wall_plaster', [0.86, 0.84, 0.8, 1], { rough: 0.9 });
  const trimMat = g.material('wall_trim', [0.18, 0.18, 0.2, 1], { rough: 0.6 });
  const gold = g.material('frame_gold', [0.83, 0.62, 0.25, 1], { rough: 0.35, metal: 0.85 });
  const benchMat = g.material('bench_oak', [0.45, 0.3, 0.17, 1], { rough: 0.7 });
  const plinthMat = g.material('plinth', [0.93, 0.93, 0.95, 1], { rough: 0.5 });
  const bronze = g.material('sculpture_bronze', [0.55, 0.38, 0.2, 1], { rough: 0.3, metal: 0.9 });
  const orbMat = g.material('orb_glass', [0.45, 0.8, 1, 1], { rough: 0.1, emissive: [0.08, 0.25, 0.4] });

  g.add('floor', box(0, -0.05, 0, 2 * X + 2 * T, 0.1, 2 * Z + 2 * T), floorMat, { wgif: { collider: 'static' } });
  g.add('wall_north', box(0, H / 2, -Z - T / 2, 2 * X + 2 * T, H, T), wallMat, { wgif: { collider: 'static' } });
  g.add('wall_south', box(0, H / 2, Z + T / 2, 2 * X + 2 * T, H, T), wallMat, { wgif: { collider: 'static' } });
  g.add('wall_east', box(X + T / 2, H / 2, 0, T, H, 2 * Z), wallMat, { wgif: { collider: 'static' } });
  g.add('wall_west', box(-X - T / 2, H / 2, 0, T, H, 2 * Z), wallMat, { wgif: { collider: 'static' } });
  const trim = empty();
  merge(trim, box(0, 0.08, -Z + 0.01, 2 * X, 0.16, 0.04), box(0, 0.08, Z - 0.01, 2 * X, 0.16, 0.04),
    box(X - 0.01, 0.08, 0, 0.04, 0.16, 2 * Z), box(-X + 0.01, 0.08, 0, 0.04, 0.16, 2 * Z));
  g.add('skirting', trim, trimMat);

  // Paintings: 2.6 m on the long side, centred at eye height-ish, each in a gold frame.
  for (const art of ARTWORKS) {
    const bytes = asset(art.file);
    const { width, height } = jpegSize(bytes);
    const long = width >= height ? 2.6 : 2.4, w = width >= height ? long : (long * width) / height, h = width >= height ? (long * height) / width : long;
    const cy = 2.1, off = 0.06, f = 0.09;
    const id = art.file.replace(/\.jpg$/, '');
    const c: [number, number, number] =
      art.wall === '+z' ? [art.at, cy, -Z + off] : art.wall === '-z' ? [art.at, cy, Z - off] : art.wall === '+x' ? [-X + off, cy, art.at] : [X - off, cy, art.at];
    const tex = g.texture(id, bytes, 'image/jpeg');
    // The picture glows with its own colours (emissive map) so it reads the same in any light.
    const mat = g.material(id, [0.3, 0.3, 0.3, 1], { texture: tex, glowTexture: true, emissive: [0.85, 0.85, 0.85], rough: 0.9 });
    g.add(id, picture(c, w, h, art.wall), mat, { wgif: { credit: { title: art.title, author: art.author, license: 'Public domain', source: art.source } } });
    const frame = empty();
    const alongX = art.wall === '+z' || art.wall === '-z';
    const depth = 0.08, dz = alongX ? c[2] + (art.wall === '+z' ? -0.02 : 0.02) : c[2], dx = alongX ? c[0] : c[0] + (art.wall === '+x' ? -0.02 : 0.02);
    const bar = (ox: number, oy: number, len: number, vertical: boolean) =>
      alongX
        ? box(dx + ox, c[1] + oy, dz, vertical ? f : len, vertical ? len : f, depth)
        : box(dx, c[1] + oy, dz + ox, depth, vertical ? len : f, vertical ? f : len);
    merge(frame, bar(0, h / 2 + f / 2, w + 2 * f, false), bar(0, -h / 2 - f / 2, w + 2 * f, false), bar(-w / 2 - f / 2, 0, h, true), bar(w / 2 + f / 2, 0, h, true));
    g.add(`${id}_frame`, frame, gold);
    // A small plaque under each painting.
    const py = c[1] - h / 2 - f - 0.22;
    const p: [number, number, number] = alongX ? [c[0], py, c[2] + (art.wall === '+z' ? 0.02 : -0.02)] : [c[0] + (art.wall === '+x' ? 0.02 : -0.02), py, c[2]];
    g.add(`${id}_plaque`, alongX ? box(p[0], p[1], p[2], 0.4, 0.14, 0.03) : box(p[0], p[1], p[2], 0.03, 0.14, 0.4), trimMat);
  }

  const benches = empty();
  for (const x of [-4, 4]) merge(benches, box(x, 0.45, 0, 2.4, 0.08, 0.6), box(x - 1, 0.21, 0, 0.12, 0.42, 0.5), box(x + 1, 0.21, 0, 0.12, 0.42, 0.5));
  g.add('benches', benches, benchMat, { wgif: { collider: 'static' } });
  // Centre plinth holding the orb, and two sculptures on plinths in the corners.
  g.add('plinth_center', cylinder(0, 0, 0, 1.0, 0.45, 32), plinthMat, { wgif: { collider: 'static' } });
  const plinths = empty();
  merge(plinths, box(-7.4, 0.5, -4.4, 0.8, 1.0, 0.8), box(7.4, 0.5, 4.4, 0.8, 1.0, 0.8));
  g.add('plinths', plinths, plinthMat, { wgif: { collider: 'static' } });
  const sculptures = empty();
  merge(sculptures, torus(-7.4, 1.55, -4.4, 0.35, 0.09), sphere(-7.4, 1.55, -4.4, 0.16), torus(7.4, 1.35, 4.4, 0.25, 0.12), sphere(7.4, 1.8, 4.4, 0.2));
  g.add('sculptures', sculptures, bronze);
  g.add('orb', sphere(0, 0, 0, 0.18), orbMat, { wgif: { role: 'grabbable', radius: 0.18 } }).setTranslation(ORB_START);
  return g.glb();
}

export function galleryInteractions() {
  const { halfX: X, halfZ: Z } = GALLERY;
  return {
    version: '0.1',
    camera: { spawn: [0, 1.7, 4.2], lookAt: [0, 1.9, -6], firstPersonHeight: 1.7, bounds: { min: [-X + 0.3, 0, -Z + 0.3], max: [X - 0.3, 5, Z - 0.3] } },
    objects: [
      { id: 'orb', node: 'orb', kind: 'grabbable', physics: { shape: 'sphere', radius: 0.18, mass: 0.5, restitution: 0.5, friction: 0.6 }, spawn: ORB_START },
    ],
    colliders: { static: ['floor', 'wall_north', 'wall_south', 'wall_east', 'wall_west', 'benches', 'plinth_center', 'plinths'] },
  };
}

export function galleryCredits(): Credit[] {
  return ARTWORKS.map((a) => ({ file: `world.glb#${a.file.replace(/\.jpg$/, '')}`, title: a.title, author: a.author, source: a.source, license: 'Public domain' }));
}

export function galleryManifest(): ManifestInput {
  return {
    $schema: 'https://github.com/galactic-ai-team/wgif/blob/main/packages/format/schema/manifest.v0.1.schema.json',
    wgif: '0.1',
    id: 'galactic.examples.gallery',
    title: 'Open-Air Gallery',
    description: 'A roofless gallery under the night sky, hung with six public-domain masterpieces (Hokusai, van Gogh, Vermeer, Monet, Botticelli, Klimt). Walk the room and pick up the glass orb. Locked: look, play, no edits.',
    creator: { name: 'Galactic AI Team', url: 'https://github.com/galactic-ai-team/wgif' },
    created: '2026-11-16T00:00:00Z',
    // The world itself is CC-BY-4.0; the paintings inside it are public domain (see extensions.x-credits).
    license: 'CC-BY-4.0',
    mode: 'locked',
    units: 'meters',
    entry: { scene: 'world.glb', preview: 'preview.png', interactions: 'interactions.json' },
    spawn: { position: [0, 1.7, 4.2], lookAt: [0, 1.9, -6] },
    requires: ['scene.glb', 'interaction.camera', 'interaction.grab'],
    provenance: { generator: 'wgif example-worlds 0.1.0 (gallery)', params: { source: 'examples/worlds/src/gallery.ts' } },
    extensions: { 'x-credits': galleryCredits() },
  };
}

export async function buildGalleryWgif(): Promise<Uint8Array> {
  return packWgif(galleryManifest(), {
    'world.glb': await buildGalleryGlb(),
    'preview.png': preview('gallery', [40, 38, 52], [212, 160, 64]),
    'interactions.json': json(galleryInteractions()),
  });
}
