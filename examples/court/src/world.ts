import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packWgif, utf8, type ManifestInput, type ModelEntry } from '@wgif/format';
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
    spawn: { position: [0, 1.7, 9.5], lookAt: [0, 1.2, 0] },
    requires: ['scene.glb', 'runtime.rules'],
    models,
    provenance: { generator: 'wgif example-court 0.1.0' },
  };
}

const json = (v: unknown) => utf8(JSON.stringify(v, null, 2) + '\n');

const modelsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../models');

export async function buildCourtWgif(): Promise<Uint8Array> {
  const files = {
    'world.glb': await buildCourtGlb(),
    'preview.png': renderPreviewPng(),
    'interactions.json': json(interactions()),
    'game-state.json': json(gameState()),
    'models/rebounder.rules.json': new Uint8Array(readFileSync(resolve(modelsDir, 'rebounder.rules.json'))),
    'models/rebounder-mlp.onnx': new Uint8Array(readFileSync(resolve(modelsDir, 'rebounder-mlp.onnx'))),
  };
  return packWgif(courtManifest(), files);
}
