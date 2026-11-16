import { packWgif, utf8, type ManifestInput } from '@wgif/format';
import { BALL_START, COURT, buildCourtGlb, rimCenter } from './court.js';
import { renderPreviewPng } from './preview.js';

/**
 * interactions.json — DRAFT shape for v0.1 (owned by the Format + Player lanes, see SPEC §5).
 * The Phase One proof player only reads `camera`; the shooting minigame lane implements the rest.
 */
export function interactions() {
  return {
    version: '0.1',
    camera: { spawn: [0, 1.7, 9.5], lookAt: [0, 1.2, 0], firstPersonHeight: 1.7, bounds: { min: [-17, 0, -10], max: [17, 6, 10] } },
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
    spawn: { position: [0, 1.7, 9.5], lookAt: [0, 1.2, 0] },
    requires: ['scene.glb'],
    provenance: { generator: 'wgif example-court 0.1.0' },
  };
}

const json = (v: unknown) => utf8(JSON.stringify(v, null, 2) + '\n');

export async function buildCourtWgif(): Promise<Uint8Array> {
  const files = {
    'world.glb': await buildCourtGlb(),
    'preview.png': renderPreviewPng(),
    'interactions.json': json(interactions()),
    'game-state.json': json(gameState()),
  };
  return packWgif(courtManifest(), files);
}
