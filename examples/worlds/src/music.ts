import { packWgif, type ManifestInput } from '@wgif/format';
import { asset, json, preview, type Credit } from './common.js';
import { GlbBuilder, box, cylinder, empty, merge, ring } from './mesh.js';

/**
 * "Neon Pulse": a music world. The track is packed in the .wgif (an MP3 synthesised by
 * scripts/synth-track.py, CC0), and the player's audio component draws a crown of frequency bars,
 * a pulsing core and beat-driven particle bursts round the middle of a dark stage. The stage itself
 * reacts too: its floor rings glow with the bass, mids and overall level, and the light-tower strips rise and glow with the mids and treble
 * (`react[]` bindings). Tap to play; orbit and zoom as usual.
 */
export const STAGE = { radius: 12, towers: 8, towerR: 10.6, bpm: 124, bars: 24 };
export const TRACK_FILE = 'assets/music-neon-pulse.mp3';
export const LOOP_SECONDS = (STAGE.bars * 4 * 60) / STAGE.bpm;
export const TRACK_CREDIT: Credit = {
  file: TRACK_FILE,
  title: 'Neon Pulse (124 BPM, 24-bar loop)',
  author: 'Galactic AI Team (synthesised in code, no samples)',
  source: 'https://github.com/galactic-ai-team/wgif/blob/dev/examples/worlds/scripts/synth-track.py',
  license: 'CC0-1.0',
};
const SPAWN: [number, number, number] = [0, 1.7, 11];

async function buildMusicGlb(): Promise<Uint8Array> {
  const g = new GlbBuilder('NeonPulse', 'wgif example-worlds music');
  const R = STAGE.radius;
  const floor = g.material('stage_floor', [0.05, 0.05, 0.08, 1], { rough: 0.3, metal: 0.6 });
  const rim = g.material('stage_rim', [0.12, 0.12, 0.16, 1], { rough: 0.5, metal: 0.7 });
  const towerMat = g.material('tower_steel', [0.1, 0.1, 0.13, 1], { rough: 0.4, metal: 0.8 });
  const ringGlow: [number, number, number] = [0.55, 0.2, 1];

  g.add('stage', cylinder(0, 0, -0.3, 0, R, 96), floor, { wgif: { collider: 'static' } });
  // A dark apron round the stage: something to stand on past the edge, and room for the overview.
  g.add('apron', cylinder(0, 0, -0.32, -0.02, 20, 96), g.material('apron', [0.025, 0.025, 0.04, 1], { rough: 0.9 }), { wgif: { collider: 'static' } });
  g.add('stage_edge', ring(0, 0.004, 0, R - 0.25, R, 0, Math.PI * 2, 128), rim);

  // Floor rings that glow with the bass.
  for (const [k, r] of [8.2, 9.3, 11.4].entries()) {
    const m = g.material(`floor_ring_${k}`, [0.3, 0.1, 0.6, 1], { emissive: ringGlow.map((c) => c * (0.35 - k * 0.07)) as [number, number, number] });
    g.add(`floor_ring_${k}`, ring(0, 0.006 + k * 0.001, 0, r - 0.06, r + 0.06, 0, Math.PI * 2, 160), m);
  }
  // A spiral of floor dashes inside the bars.
  const dashes = empty();
  for (let i = 0; i < 48; i++) {
    const a0 = (i / 48) * Math.PI * 2;
    merge(dashes, ring(0, 0.005, 0, 4.6 + (i % 3) * 0.5, 4.75 + (i % 3) * 0.5, a0, a0 + 0.05, 4));
  }
  g.add('floor_dashes', dashes, g.material('floor_dashes', [0.2, 0.8, 1, 1], { emissive: [0.08, 0.35, 0.45] }));

  // Light towers round the edge, each with a glowing strip that follows the treble.
  const towers = empty();
  for (let k = 0; k < STAGE.towers; k++) {
    const a = (k / STAGE.towers) * Math.PI * 2 + Math.PI / STAGE.towers;
    const x = Math.sin(a) * STAGE.towerR, z = Math.cos(a) * STAGE.towerR;
    merge(towers, box(x, 2.6, z, 0.5, 5.2, 0.5), box(x, 0.1, z, 1.1, 0.2, 1.1), box(x, 5.3, z, 0.9, 0.2, 0.9));
    const node = g.node(`tower_glow_${k}`, undefined, [x, 0.25, z]);
    const hue = k % 2 ? [0.15, 0.85, 1] : [1, 0.25, 0.75];
    const m = g.material(`tower_glow_${k}`, [hue[0]!, hue[1]!, hue[2]!, 1], { emissive: [hue[0]! * 0.5, hue[1]! * 0.5, hue[2]! * 0.5] });
    // Strip on the inward face, built from its base so it can stretch upwards.
    const inward = [-Math.sin(a) * 0.27, -Math.cos(a) * 0.27];
    g.add(`tower_glow_${k}_strip`, box(inward[0]!, 2.4, inward[1]!, Math.abs(Math.cos(a)) * 0.18 + 0.04, 4.8, Math.abs(Math.sin(a)) * 0.18 + 0.04), m, undefined, node);
  }
  g.add('towers', towers, towerMat, { wgif: { collider: 'static' } });
  return g.glb();
}

export function musicInteractions() {
  const R = STAGE.radius;
  return {
    version: '0.1',
    camera: { spawn: SPAWN, lookAt: [0, 3, 0], firstPersonHeight: 1.7, bounds: { min: [-R + 0.4, -1, -R + 0.4], max: [R - 0.4, 12, R - 0.4] } },
    objects: [],
    colliders: { static: ['stage', 'apron', 'towers'] },
    interactions: [
      {
        type: 'audio',
        id: 'track',
        file: TRACK_FILE,
        title: 'Neon Pulse',
        artist: 'Galactic AI Team',
        loop: true,
        loopSeconds: LOOP_SECONDS,
        volume: 0.8,
        visualizer: { center: [0, 2.6, 0], radius: 7, bars: 96, hue: 0.72 },
        react: [
          { node: 'floor_ring_0', band: 'bass', glow: 3 },
          { node: 'floor_ring_1', band: 'mid', glow: 3 },
          { node: 'floor_ring_2', band: 'energy', glow: 2.5 },
          ...Array.from({ length: STAGE.towers }, (_, k) => ({ node: `tower_glow_${k}`, band: k % 2 ? 'treble' : 'mid', scale: [0.25, 1.05], axis: 'y', glow: 2 })),
        ],
      },
    ],
  };
}

export function musicManifest(): ManifestInput {
  return {
    $schema: 'https://github.com/galactic-ai-team/wgif/blob/main/packages/format/schema/manifest.v0.1.schema.json',
    wgif: '0.1',
    id: 'galactic.examples.music',
    title: 'Neon Pulse',
    description: 'A music world: an original 124 BPM track packed in the file, with a crown of frequency bars, a pulsing core and particle bursts on every beat. Tap to play, then orbit and zoom.',
    creator: { name: 'Galactic AI Team', url: 'https://github.com/galactic-ai-team/wgif' },
    created: '2026-11-16T00:00:00Z',
    license: 'CC-BY-4.0',
    mode: 'editable',
    units: 'meters',
    entry: { scene: 'world.glb', preview: 'preview.png', interactions: 'interactions.json', state: 'game-state.json' },
    spawn: { position: SPAWN, lookAt: [0, 3, 0] },
    // No `audio.music` capability yet (not in the v0.1 registry, see docs/notes/audio-component.md):
    // a player without it shows the stage and warns about the interactions[] entry.
    requires: ['scene.glb', 'interaction.camera', 'state.initial'],
    provenance: { generator: 'wgif example-worlds 0.1.0 (music)', params: { source: 'examples/worlds/src/music.ts', track: 'examples/worlds/scripts/synth-track.py' } },
    extensions: { 'x-credits': [TRACK_CREDIT] },
  };
}

export async function buildMusicWgif(): Promise<Uint8Array> {
  return packWgif(musicManifest(), {
    'world.glb': await buildMusicGlb(),
    'preview.png': preview('music', [20, 10, 40], [190, 90, 255]),
    'interactions.json': json(musicInteractions()),
    'game-state.json': json({ version: '0.1', minigames: {}, objects: {} }),
    [TRACK_FILE]: asset('music-neon-pulse.mp3'),
  });
}
