import { describe, expect, it } from 'vitest';
import { createRebounder } from '../src/ai.js';
import type { EditOp } from '../src/edit.js';
import { exportWorld, mergeRawState } from '../src/exporter.js';
import { readJson } from '../src/interactions.js';
import { findNodes } from '../src/sceneBridge.js';
import { describeTrust, loadDocument, openWorld, withEdits } from '../src/world.js';
import { open, run } from './helpers.js';
import { courtVariant } from './worlds.js';

const AT = new Date('2026-11-16T15:00:00Z');
const json = (bytes: Uint8Array | undefined): Record<string, unknown> => readJson(bytes) as Record<string, unknown>;

describe('export: editable world', () => {
  it('writes the edits and the state into a new file that re-opens with them', async () => {
    const { doc, runtime } = await open();
    runtime.shootout!.highScore = 7;
    runtime.shootout!.plays = 2;
    const ops: EditOp[] = [
      { op: 'move', id: 'ball', position: [-4, 0.12, 3] },
      { op: 'spawn', position: [0, 1.7, 7], lookAt: [12, 3, 0] },
      { op: 'rules', minigame: 'shootout', rules: { durationSec: 30 } },
    ];
    const result = await exportWorld(doc, { ops, state: runtime.snapshot(), by: 'tester', at: AT });
    expect(result).toMatchObject({ kind: 'edit', fileName: 'galactic-court-edit.wgif' });

    const out = await openWorld(result.bytes);
    expect(out.report.ok).toBe(true);
    expect(out.manifest.mode).toBe('editable');
    expect(out.manifest.spawn).toEqual({ position: [0, 1.7, 7], lookAt: [12, 3, 0] });
    expect(out.manifest.modified).toBe('2026-11-16T15:00:00Z');
    expect(out.manifest.provenance?.history?.at(-1)).toEqual({
      action: 'edit',
      at: '2026-11-16T15:00:00Z',
      by: 'tester',
      note: 'moved "ball" to -4.0, 0.1, 3.0; visitors start at 0.0, 1.7, 7.0; shootout rules: durationSec 30',
    });
    const interactions = json(out.files['interactions.json']);
    const objects = interactions.objects as { id: string; spawn?: number[] }[];
    expect(objects.find((o) => o.id === 'ball')?.spawn).toEqual([-4, 0.12, 3]);
    expect((interactions.camera as { spawn: number[] }).spawn).toEqual([0, 1.7, 7]);
    expect((interactions.minigames as { rules: Record<string, number> }[])[0]?.rules).toMatchObject({ durationSec: 30, pointsPerBasket: 2 });
    const state = json(out.files['game-state.json']) as { version: string; minigames: Record<string, unknown> };
    expect(state.version).toBe('0.1');
    expect(state.minigames.shootout).toEqual({ highScore: 7, plays: 2 });
    // Everything that was not edited is byte for byte what it was.
    for (const path of ['world.glb', 'preview.png', ...Object.keys(doc.world.files).filter((p) => p.startsWith('models/'))]) {
      expect(out.files[path], path).toEqual(doc.world.files[path]);
    }

    // And it plays that way.
    const again = await open(result.bytes);
    expect(again.runtime.shootout?.rules.durationSec).toBe(30);
    expect(again.runtime.shootout?.highScore).toBe(7);
    expect(again.runtime.objects.get('ball')?.spawn).toEqual([-4, 0.12, 3]);
    expect(again.runtime.playerSpawn.position).toEqual([0, 1.7, 7]);
  });

  it('saves where the ball came to rest, keeping state fields this player does not use', async () => {
    const { doc, runtime } = await open(await courtVariant({ files: { 'game-state.json': new TextEncoder().encode(JSON.stringify({ version: '0.1', score: 4, objects: { ball: { position: [9, 0.12, 1.2], enabled: true } } })) } }));
    runtime.setObjectSpawn('ball', [-2, 1.5, -2]);
    run(runtime, 4);
    const result = await exportWorld(doc, { state: runtime.snapshot(), at: AT });
    const state = json((await openWorld(result.bytes)).files['game-state.json']) as { score: number; objects: { ball: { position: number[]; enabled: boolean } } };
    expect(state.score).toBe(4);
    expect(state.objects.ball.enabled).toBe(true);
    expect(state.objects.ball.position[0]).toBeCloseTo(-2, 1);
    expect(state.objects.ball.position[1]).toBeCloseTo(0.12, 2);
    expect(mergeRawState(null, { version: '0.1', minigames: {}, objects: {} })).toEqual({ version: '0.1', minigames: {}, objects: {} });
  });

  it('drops a creator signature over changed content and records the signed parent', async () => {
    const { doc } = await open(await courtVariant({ sign: true }));
    expect(doc.world.report.signature).toBe('valid');
    const result = await exportWorld(doc, { ops: [{ op: 'move', id: 'ball', position: [0, 0.12, 0] }], at: AT });
    const out = await openWorld(result.bytes);
    expect(out.manifest.signature).toBeUndefined();
    expect(out.report.signature).toBe('absent');
    expect(out.manifest.provenance?.parent).toEqual({ id: doc.world.manifest.id, signingHash: doc.signingHash });
    expect(describeTrust(out).label).toBe('unsigned');
  });

  it('records the original signed parent for a spawn-only edit', async () => {
    const { doc } = await open(await courtVariant({ sign: true }));
    expect(doc.world.report.signature).toBe('valid');
    const originalHash = doc.signingHash;
    const spawn = { position: [2, 1.7, 7] as [number, number, number], lookAt: [0, 1.2, 0] as [number, number, number] };
    const result = await exportWorld(doc, { ops: [{ op: 'spawn', ...spawn }], at: AT });
    const reopened = await openWorld(Uint8Array.from(result.bytes));
    expect(reopened.report.ok).toBe(true);
    expect(reopened.report.signature).toBe('absent');
    expect(reopened.manifest.signature).toBeUndefined();
    expect(reopened.manifest.spawn).toEqual(spawn);
    expect(reopened.manifest.provenance?.parent)
      .toEqual({ id: doc.world.manifest.id, signingHash: originalHash });
  });

  it('can export an exported copy again, and the history grows', async () => {
    const first = await exportWorld((await open()).doc, { ops: [{ op: 'move', id: 'ball', position: [1, 0.12, 1] }], by: 'a', at: AT });
    const second = await exportWorld((await open(first.bytes)).doc, { ops: [{ op: 'move', id: 'ball', position: [2, 0.12, 2] }], by: 'b', at: AT });
    const history = (await openWorld(second.bytes)).manifest.provenance?.history ?? [];
    expect(history.slice(-2).map((h) => h.by)).toEqual(['a', 'b']);
  });

  it('refuses when there is nothing to export', async () => {
    await expect(exportWorld((await open()).doc, {})).rejects.toMatchObject({ code: 'nothing' });
  });
});

describe('export: layered world', () => {
  const base = () => courtVariant({ mode: 'layered', sign: true, layers: [{ id: 'l1', author: 'Dee', body: { version: '0.1', remove: ['bleachers'] } }] });

  it('adds one layer, leaves every base file and the signature as they were, and re-opens with the edit', async () => {
    const { doc } = await open(await base());
    const ops: EditOp[] = [
      { op: 'add', id: 'block-1', primitive: 'box', position: [2, 0.3, 4], size: [0.6, 0.6, 0.6], color: '#8b5cf6' },
      { op: 'move', id: 'ball', position: [-3, 0.12, 2] },
    ];
    const result = await exportWorld(doc, { ops, by: 'tester', at: AT });
    expect(result).toMatchObject({ kind: 'layer', layerId: 'layer-2', fileName: 'galactic-court-layer-2.wgif' });

    const out = await openWorld(result.bytes);
    expect(out.report.signature).toBe('valid');
    expect(out.manifest.signature).toEqual(doc.world.manifest.signature);
    expect(out.manifest.layers).toEqual([
      { id: 'l1', path: 'layers/l1.json', author: 'Dee', created: '2026-11-16T12:00:00Z' },
      { id: 'layer-2', path: 'layers/layer-2.json', author: 'tester', created: '2026-11-16T15:00:00Z' },
    ]);
    expect(Object.keys(out.files).sort()).toEqual([...Object.keys(doc.world.files), 'layers/layer-2.json'].sort());
    for (const [path, bytes] of Object.entries(doc.world.files)) expect(out.files[path], path).toEqual(bytes);
    expect(json(out.files['layers/layer-2.json'])).toEqual({
      version: '0.1',
      add: [{ id: 'block-1', primitive: 'box', position: [2, 0.3, 4], size: [0.6, 0.6, 0.6], color: '#8b5cf6' }],
      move: [{ id: 'ball', position: [-3, 0.12, 2] }],
      remove: [],
    });
    expect(out.manifest.provenance?.history?.at(-1)?.note).toBe('layer-2: added box "block-1" at 2.0, 0.3, 4.0; moved "ball" to -3.0, 0.1, 2.0');

    // The re-opened world shows both layers: no bleachers, a solid block, the ball moved.
    const again = await open(result.bytes);
    expect(again.doc.layers.map((l) => l.id)).toEqual(['l1', 'layer-2']);
    expect(findNodes(again.scene, 'bleachers')).toHaveLength(0);
    expect(again.built.solid).toContain('block-1');
    expect(again.runtime.objects.get('ball')?.spawn).toEqual([-3, 0.12, 2]);
    expect(again.doc.signingHash).toBe(doc.signingHash); // same base: local saves carry over
  });

  it('shows the edits live before export, the way the exported copy will', async () => {
    const { doc } = await open(await base());
    const live = withEdits(doc, [{ op: 'add', id: 'block-1', primitive: 'box', position: [2, 0.3, 4] }]);
    expect(live.sceneOps.map((o) => o.kind)).toEqual(['remove', 'add']);
    expect(live.ids.has('block-1')).toBe(true);
    expect(live.layers).toBe(doc.layers);
  });

  it('cannot carry spawn or rule changes, and needs at least one change', async () => {
    const { doc } = await open(await base());
    await expect(exportWorld(doc, { ops: [{ op: 'spawn', position: [0, 1.7, 7] }] })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(exportWorld(doc, { ops: [{ op: 'rules', minigame: 'shootout', rules: { durationSec: 30 } }] })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(exportWorld(doc, { ops: [] })).rejects.toMatchObject({ code: 'nothing' });
  });
});

describe('export: embedded models', () => {
  // The byte checks above cover world.glb and preview.png, but a dropped
  // models[] entry would pass validation (an undeclared models/ file is
  // legal) and silently lose the NPC, so the descriptors get their own
  // assertions, in both export modes.
  it('keeps the rebounder models byte-for-byte with their manifest entries, in an editable export', async () => {
    const { doc } = await open();
    const before = doc.world;
    const result = await exportWorld(doc, { ops: [{ op: 'move', id: 'ball', position: [1, 0.12, 1] }], at: AT });
    const out = await openWorld(result.bytes);
    expect(out.report.ok).toBe(true);
    for (const path of ['models/rebounder-mlp.onnx', 'models/rebounder.rules.json']) {
      expect(out.files[path], path).toEqual(before.files[path]);
      expect(out.manifest.files.find((f) => f.path === path)).toEqual(before.manifest.files.find((f) => f.path === path));
    }
    expect(out.manifest.models).toEqual(before.manifest.models);
    // And the NPC is still discoverable from the exported copy, through the real player path.
    expect(await createRebounder(out)).not.toBeNull();
  });

  it('keeps the rebounder models byte-for-byte with their manifest entries, in a layered export', async () => {
    const { doc } = await open(await courtVariant({ mode: 'layered' }));
    const before = doc.world;
    const result = await exportWorld(doc, { ops: [{ op: 'move', id: 'ball', position: [-3, 0.12, 2] }], by: 'tester', at: AT });
    const out = await openWorld(result.bytes);
    expect(out.report.ok).toBe(true);
    for (const path of ['models/rebounder-mlp.onnx', 'models/rebounder.rules.json']) {
      expect(out.files[path], path).toEqual(before.files[path]);
      expect(out.manifest.files.find((f) => f.path === path)).toEqual(before.manifest.files.find((f) => f.path === path));
    }
    expect(out.manifest.models).toEqual(before.manifest.models);
    expect(await createRebounder(out)).not.toBeNull();
  });

  it('keeps the rebounder models byte-for-byte when an editable export refreshes the preview, through the Share/Save-to-Files round-trip', async () => {
    const { doc } = await open();
    const before = doc.world;
    // The fresh preview is the one new mutation this branch makes to an
    // export: preview.png is replaced in the files map and files[] is
    // rebuilt from it. The models/ entries must come through that rebuild
    // untouched — the tests above export without a preview, so they would
    // not catch a preview refresh that dropped them.
    const preview = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const result = await exportWorld(doc, { ops: [{ op: 'move', id: 'ball', position: [1, 0.12, 1] }], at: AT, preview: new Uint8Array(preview) });
    expect(result.preview).toBe('refreshed');
    // Share / Save to Files hands the whole file over as one blob, and the
    // picker on the other device hands the same bytes back. Every open path
    // in the player (picker, launchQueue, share target, ?src=) funnels those
    // bytes into openBytes, so re-opening them here is the shared path.
    const file = new File([result.bytes as Uint8Array<ArrayBuffer>], result.fileName, { type: '' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = await openWorld(bytes);
    expect(out.report.ok).toBe(true);
    expect(out.files['preview.png']).toEqual(new Uint8Array(preview));
    for (const path of ['models/rebounder-mlp.onnx', 'models/rebounder.rules.json']) {
      expect(out.files[path], path).toEqual(before.files[path]);
      expect(out.manifest.files.find((f) => f.path === path)).toEqual(before.manifest.files.find((f) => f.path === path));
    }
    expect(out.manifest.models).toEqual(before.manifest.models);
    // And the rebounder still runs from the re-opened file alone: the models
    // are data in the file, loaded by the JS MLP from bytes, so no network
    // is involved and it works offline.
    const npc = await createRebounder(out);
    expect(npc).not.toBeNull();
    expect(npc!.info.runtime).toBe('rules');
  });
});

describe('export: locked world', () => {
  it('is refused, signed or not', async () => {
    for (const sign of [false, true]) {
      const { doc } = await open(await courtVariant({ mode: 'locked', sign }));
      await expect(exportWorld(doc, { ops: [{ op: 'move', id: 'ball', position: [0, 0.12, 0] }] })).rejects.toMatchObject({ code: 'locked' });
    }
  });
});

describe('save key', () => {
  it('is the world id plus the signing hash, so an edited copy gets its own saves', async () => {
    const { doc } = await open();
    expect(doc.saveKey).toBe(`${doc.world.manifest.id}@${doc.signingHash}`);
    const edited = await exportWorld(doc, { ops: [{ op: 'move', id: 'ball', position: [1, 0.12, 1] }], at: AT });
    const copy = await loadDocument(await openWorld(edited.bytes));
    expect(copy.saveKey).not.toBe(doc.saveKey);
  });
});
