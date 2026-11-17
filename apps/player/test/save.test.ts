import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftFits, memoryStore, openStateStore, parseSaved, WorldSaver, type SavedState } from '../src/save.js';

const state = (highScore: number) => ({ version: '0.1', minigames: { shootout: { highScore, plays: 1 } }, objects: { ball: { position: [1, 0.12, 2] as [number, number, number] } } });
const meta = { worldId: 'org.wgif.examples.court', signingHash: 'ab'.repeat(32), title: 'Court' };

afterEach(() => vi.useRealTimers());

describe('local saves', () => {
  it('coalesces a burst of changes into one write, and flush forces it out', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const put = vi.spyOn(store, 'put');
    const saver = new WorldSaver(store, 'court@ab', meta, 400);
    saver.schedule(state(1));
    saver.schedule(state(2));
    saver.schedule(state(3));
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(put).toHaveBeenCalledTimes(1);
    expect((await store.get('court@ab'))?.state.minigames.shootout?.highScore).toBe(3);
    saver.schedule(state(4));
    await saver.flush();
    expect(put).toHaveBeenCalledTimes(2);
    expect((await store.get('court@ab'))?.state.minigames.shootout?.highScore).toBe(4);
  });

  it('keeps unsaved edits next to the state, and forgets them on reset', async () => {
    const store = memoryStore();
    const saver = new WorldSaver(store, 'k', meta);
    saver.setDraft(state(5), ['l1'], [{ op: 'move', id: 'ball', position: [3, 0.12, 3] }]);
    await saver.flush();
    const reloaded = new WorldSaver(store, 'k', meta);
    const saved = await reloaded.load();
    expect(saved?.draft).toEqual({ layers: ['l1'], ops: [{ op: 'move', id: 'ball', position: [3, 0.12, 3] }] });
    // A later state save keeps the draft it loaded.
    reloaded.schedule(state(6));
    await reloaded.flush();
    expect((await store.get('k'))?.draft?.ops).toHaveLength(1);
    // An empty draft clears it; reset clears everything.
    reloaded.setDraft(state(6), ['l1'], []);
    await reloaded.flush();
    expect((await store.get('k'))?.draft).toBeUndefined();
    await reloaded.clear();
    expect(await store.get('k')).toBeNull();
  });

  it('only re-applies a draft to the exact world version it was made on', () => {
    const draft = { layers: ['l1'], ops: [{ op: 'remove' as const, id: 'bleachers' }] };
    expect(draftFits(draft, ['l1'])).toBe(true);
    expect(draftFits(draft, ['l1', 'layer-2'])).toBe(false); // the exported copy, with the draft inside as a layer
    expect(draftFits(draft, [])).toBe(false);
    expect(draftFits(undefined, [])).toBe(false);
  });

  it('treats anything unexpected in storage as no save', () => {
    expect(parseSaved(null)).toBeNull();
    expect(parseSaved({ v: 2, worldId: 'a', signingHash: 'b', state: {} })).toBeNull();
    const ok = parseSaved({ v: 1, worldId: 'a', signingHash: 'b', state: { minigames: { m: { highScore: -3, plays: 'x' } } }, draft: { layers: [], ops: [{ op: 'teleport' }, { op: 'remove', id: 'x' }] } }) as SavedState;
    expect(ok.state.minigames.m).toEqual({ highScore: 0, plays: 0 });
    expect(ok.draft).toEqual({ layers: [], ops: [{ op: 'remove', id: 'x' }] });
  });

  it('falls back to memory when IndexedDB is missing or refuses to open', async () => {
    expect((await openStateStore(undefined)).kind).toBe('memory');
    const refusing = { open: () => { throw new Error('SecurityError'); } } as unknown as IDBFactory;
    expect((await openStateStore(refusing)).kind).toBe('memory');
  });
});
