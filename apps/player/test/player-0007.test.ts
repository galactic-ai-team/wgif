import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unpackWgif, utf8 } from '@wgif/format';
import { describe, expect, it } from 'vitest';
import { parseLayer } from '../src/edit.js';
import { parseInteractions, readJson, unsupportedStateFields, type Json } from '../src/interactions.js';
import type { WorldRuntime } from '../src/sim/runtime.js';
import { CylinderTrigger } from '../src/sim/trigger.js';
import { describeMode, describeTrust } from '../src/world.js';
import { courtBytes, ofType, open, run } from './helpers.js';
import { courtVariant } from './worlds.js';

/**
 * Regression tests for patch 0007: GPT-6's five player amendments (approved on PR #16), taken
 * over by Lumi while Claude is out. One describe per amendment.
 */

const PAD = { id: 'pad', node: 'floor_court', kind: 'trigger', shape: { type: 'cylinder', center: [0, 2.2, 3], radius: 0.6, height: 0.2 } };

/** The court with extra interactions.json objects (and optionally an edited ball). */
async function courtWith(extra: Json[], opts: { ball?: Json; requires?: string[]; state?: Json } = {}): Promise<Uint8Array> {
  const court = await unpackWgif(courtBytes());
  const raw = readJson(court.files['interactions.json']) as { objects: Json[] };
  const objects = raw.objects.map((o) => (o.id === 'ball' && opts.ball ? { ...o, ...opts.ball } : o));
  const files = { 'interactions.json': utf8(JSON.stringify({ ...raw, objects: [...objects, ...extra] })), ...(opts.state ? { 'game-state.json': utf8(JSON.stringify(opts.state)) } : {}) };
  return courtVariant({ files, ...(opts.requires ? { requires: opts.requires } : {}) });
}

/** Drops the ball from above the pad so it falls through it. */
function dropOnPad(runtime: WorldRuntime): void {
  const ball = runtime.objects.get('ball')!;
  ball.body.pos[0] = 0; ball.body.pos[1] = 3.5; ball.body.pos[2] = 3;
  ball.body.vel[0] = ball.body.vel[1] = ball.body.vel[2] = 0;
  ball.body.resting = false;
}

describe('0007 #1: trigger semantics (on.enter, on.grab, score / reset / activate)', () => {
  it('parses every v0.1 handler and event, and reports what it cannot run instead of dropping it', () => {
    const { interactions, warnings } = parseInteractions({
      objects: [
        { id: 'ball', node: 'b', kind: 'grabbable', physics: { shape: 'sphere' }, on: { grab: { event: 'activate' } } },
        { ...PAD, on: { enter: { event: 'reset', target: 'ball' }, enterFromAbove: { event: 'activate' } } },
        { id: 'rim', node: 'r', kind: 'trigger', shape: { type: 'cylinder', center: [0, 3, 0] }, on: { enterFromAbove: { event: 'explode' } } },
        { id: 'grabbed-rim', node: 'r', kind: 'trigger', shape: { type: 'cylinder', center: [0, 3, 0] }, on: { grab: { event: 'activate' } } },
        { id: 'box', node: 'x', kind: 'trigger', shape: { type: 'box', size: [1, 1, 1] }, on: { enter: { event: 'score' } } },
        { id: 'ball2', node: 'b2', kind: 'grabbable', on: { grab: { event: 'score' } } },
      ],
    });
    const pad = interactions.objects.find((o) => o.id === 'pad');
    expect(pad).toMatchObject({ kind: 'trigger', enter: { event: 'reset', target: 'ball' }, enterFromAbove: { event: 'activate', target: null } });
    expect(interactions.objects.find((o) => o.id === 'ball')).toMatchObject({ onGrab: { event: 'activate', target: null } });
    expect(interactions.unsupported).toEqual([
      'object "rim": on.enterFromAbove event "explode" is not one of score, reset, activate',
      'object "grabbed-rim": on.grab on a trigger object has no meaning in this player',
      'trigger "box": only cylinder shapes with a center are supported',
      'object "ball2": on.grab "score" is not supported (only a shot through a trigger scores)',
    ]);
    expect(warnings.filter((w) => w.includes('unsupported'))).toHaveLength(4);
  });

  it('on.enter raises activate when the ball comes into the volume from any side, once per entry', async () => {
    const { runtime } = await open(await courtWith([{ ...PAD, on: { enter: { event: 'activate', target: 'ball' } } }]));
    dropOnPad(runtime);
    const events = run(runtime, 2);
    expect(ofType(events, 'trigger')).toEqual([{ type: 'trigger', trigger: 'pad', event: 'activate', object: 'ball' }]);
  });

  it('on.enter with reset puts the ball back on its spawn point', async () => {
    const { runtime } = await open(await courtWith([{ ...PAD, on: { enter: { event: 'reset' } } }]));
    dropOnPad(runtime);
    const events = run(runtime, 1);
    expect(ofType(events, 'trigger')).toMatchObject([{ trigger: 'pad', event: 'reset', object: 'ball' }]);
    expect(ofType(events, 'reset')).toMatchObject([{ object: 'ball' }]);
    const pos = runtime.objects.get('ball')!.body.pos;
    expect(Math.hypot(pos[0] - 9, pos[2] - 1.2)).toBeLessThan(0.3);
  });

  it('on.enterFromAbove with activate fires on a top-to-bottom pass, not on the way up', async () => {
    const { runtime } = await open(await courtWith([{ ...PAD, on: { enterFromAbove: { event: 'activate' } } }]));
    dropOnPad(runtime);
    expect(ofType(run(runtime, 2), 'trigger')).toMatchObject([{ trigger: 'pad', event: 'activate' }]);
  });

  it('the rims still score through enterFromAbove (unchanged court behaviour)', async () => {
    const { doc } = await open();
    expect(doc.interactions.unsupported).toEqual([]);
    expect(doc.interactions.objects.filter((o) => o.kind === 'trigger').map((o) => o.kind === 'trigger' && o.enterFromAbove?.event)).toEqual(['score', 'score']);
  });

  it('on.grab with activate fires when the ball is picked up', async () => {
    const { runtime } = await open(await courtWith([], { ball: { on: { grab: { event: 'activate' } } } }));
    const ball = runtime.objects.get('ball')!;
    runtime.player.spawn([ball.body.pos[0] - 1, 1.7, ball.body.pos[2]]);
    expect(runtime.grab()).toBe(true);
    expect(ofType(runtime.drain(), 'trigger')).toEqual([{ type: 'trigger', trigger: 'ball', event: 'activate', object: 'ball' }]);
  });

  it('a segment that crosses the whole volume in one step still enters', () => {
    const t = new CylinderTrigger('t', { center: [0, 1, 0], radius: 0.2, height: 0.1 });
    expect(t.enters([-5, 1, 0], [5, 1, 0])).toBe(true);
    expect(t.enters([5, 1, 0], [6, 1, 0])).toBe(false);
    expect(t.enters([-5, 2, 0], [5, 2, 0])).toBe(false);
    t.reset([0, 1, 0]);
    expect(t.enters([0, 1, 0], [0.05, 1, 0])).toBe(false); // placed inside: no entry
  });

  it('refuses interactive play when the world requires interaction.trigger but uses a handler it cannot run', async () => {
    // Schema-valid (the validator accepts on.grab on any object) but meaningless on a trigger.
    const extra = [{ ...PAD, on: { grab: { event: 'activate' } } }];
    const refused = await open(await courtWith(extra, { requires: ['scene.glb', 'runtime.rules', 'interaction.trigger'] })).catch((e: unknown) => e);
    expect(refused).toMatchObject({ message: 'This world requires trigger behaviour this player does not support' });
    expect((refused as { details: string[] }).details[0]).toBe('interaction.trigger: object "pad": on.grab on a trigger object has no meaning in this player');
    expect((refused as { preview?: { mediaType: string } }).preview?.mediaType).toBe('image/png');
    // Without the requirement it opens, and says what it ignored.
    const { doc } = await open(await courtWith(extra));
    expect(doc.warnings.some((w) => w.includes('on.grab on a trigger') && w.includes('unsupported'))).toBe(true);
  });
});

describe('0007 #2: initial game state fields are applied or reported, never silently ignored', () => {
  it('lists score, minigames[id].score and objects[id].rotation/scale/enabled', () => {
    expect(unsupportedStateFields({ version: '0.1', score: 3, minigames: { shootout: { highScore: 1, score: 2 } }, objects: { ball: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], enabled: false } } }))
      .toEqual(['score', 'minigames.shootout.score', 'objects.ball.rotation', 'objects.ball.scale', 'objects.ball.enabled']);
    expect(unsupportedStateFields({ version: '0.1', minigames: { shootout: { highScore: 0, plays: 0 } }, objects: { ball: { position: [9, 0.12, 1.2] } } })).toEqual([]);
  });

  it('warns on open, and still applies what it supports (high score, ball position)', async () => {
    const state = { version: '0.1', score: 4, minigames: { shootout: { highScore: 12, plays: 2, score: 4 } }, objects: { ball: { position: [1, 0.12, 2], enabled: true } } };
    const { doc, runtime } = await open(await courtWith([], { state }));
    expect(doc.warnings).toContainEqual(expect.stringMatching(/^game-state: score, minigames\.shootout\.score, objects\.ball\.enabled not applied by this player/));
    expect(runtime.shootout?.highScore).toBe(12);
    expect([...runtime.objects.get('ball')!.body.pos]).toEqual([1, 0.12, 2]);
  });

  it('the sample court has nothing unsupported in its state', async () => {
    const { doc } = await open();
    expect(doc.warnings.filter((w) => w.startsWith('game-state'))).toEqual([]);
  });
});

describe('0007 #3: mode and trust wording', () => {
  it('calls locked a creator policy, not DRM', async () => {
    const { doc } = await open(await courtVariant({ mode: 'locked' }));
    expect(describeMode(doc)).toMatch(/creator policy, not DRM/);
  });

  it('says layers are not covered by this signature', async () => {
    const { doc } = await open(await courtVariant({ mode: 'layered', sign: true, layers: [{ id: 'l1', body: { version: '0.1', remove: ['ball'] } }] }));
    expect(describeTrust(doc.world).detail).toContain('Layers are not covered by this signature.');
  });
});

describe('0007 #4: unsupported add[].size / move[].scale skip the op with a warning, no defaults', () => {
  it('keeps supported values and skips the rest with a reason', () => {
    const { layer, skipped, warnings } = parseLayer({
      version: '0.1',
      add: [
        { id: 'ok', primitive: 'box', position: [0, 0.5, 0], size: [2, 1, 1] },
        { id: 'flat', primitive: 'box', position: [0, 0.5, 0], size: [0, 1, 1] },
        { id: 'huge', primitive: 'sphere', position: [0, 0.5, 0], size: [5000, 1, 1] },
        { id: 'plain', primitive: 'cylinder', position: [0, 0.5, 0] },
      ],
      move: [
        { id: 'a', position: [1, 0, 0], scale: [1, 2, 1] },
        { id: 'b', position: [1, 0, 0], scale: [-1, 1, 1] },
      ],
    });
    expect(layer.add.map((a) => [a.id, a.size])).toEqual([['ok', [2, 1, 1]], ['plain', undefined]]);
    expect(layer.move.map((m) => [m.id, m.scale])).toEqual([['a', [1, 2, 1]]]);
    expect(skipped).toBe(3);
    expect(warnings).toEqual([
      'add "flat": size [0,1,1] is not supported (each axis must be > 0 and ≤ 1000 m)',
      'add "huge": size [5000,1,1] is not supported (each axis must be > 0 and ≤ 1000 m)',
      'move "b": scale [-1,1,1] is not supported (each axis must be > 0 and ≤ 1000)',
    ]);
  });

  it('a layered world reports the skipped op and why', async () => {
    const bytes = await courtVariant({ mode: 'layered', layers: [{ id: 'l1', body: { version: '0.1', add: [{ id: 'flat', primitive: 'box', position: [0, 0.5, 3], size: [0, 1, 1] }] } }] });
    const { doc } = await open(bytes);
    expect(doc.warnings).toContain('layer "l1": add "flat": size [0,1,1] is not supported (each axis must be > 0 and ≤ 1000 m)');
    expect(doc.sceneOps.some((op) => op.kind === 'add' && op.id === 'flat')).toBe(false);
  });
});

describe('0007 #5: a refused world shows its own preview even when another world is open', () => {
  it('showRefused() no longer returns early when a world is loaded', () => {
    const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    const body = main.slice(main.indexOf('function showRefused('), main.indexOf('async function openFile('));
    expect(body).not.toMatch(/viewer\?\.runtime\)\s*return/);
    expect(body).toMatch(/if \(!err\.preview\) return;/);
    expect(main).toContain("$('refused-back')");
  });
});

describe('play-test follow-ups (bug note, optional low-risk items)', () => {
  it('tip-off turns the player from the centre-court spawn to face the nearest hoop', async () => {
    const { runtime } = await open();
    runtime.player.spawn([0, 1.7, 9.5], [0, 1.2, 0]);
    expect(runtime.startShootout()).toBe(true);
    const f = runtime.player.forward, e = runtime.player.eye;
    const toHome = [12.425 - e[0], -e[2]], toAway = [-12.425 - e[0], -e[2]];
    const cos = (v: number[]): number => (f[0] * v[0]! + f[2] * v[1]!) / (Math.hypot(f[0], f[2]) * Math.hypot(v[0]!, v[1]!));
    expect(Math.max(cos(toHome), cos(toAway))).toBeGreaterThan(0.999);
  });
});
