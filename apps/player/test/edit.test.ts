import { describe, expect, it } from 'vitest';
import { EditSession, compactOps, describeOp, sanitizeOp, toLayer, type EditOp } from '../src/edit.js';

describe('edit session', () => {
  it('collects edits, undoes them one at a time, and restores a draft', () => {
    const session = new EditSession();
    expect(session.dirty).toBe(false);
    session.push({ op: 'move', id: 'ball', position: [1, 0.12, 1] });
    session.push({ op: 'move', id: 'ball', position: [2, 0.12, 2] });
    session.push({ op: 'spawn', position: [0, 1.7, 9] });
    expect(session.ops).toEqual([{ op: 'move', id: 'ball', position: [2, 0.12, 2] }, { op: 'spawn', position: [0, 1.7, 9] }]);
    session.undo();
    expect(session.ops).toEqual([{ op: 'move', id: 'ball', position: [2, 0.12, 2] }]);
    session.undo();
    expect(session.ops).toEqual([{ op: 'move', id: 'ball', position: [1, 0.12, 1] }]);
    session.restore([{ op: 'remove', id: 'bleachers' }, { op: 'remove', id: 'court_lines' }]);
    expect(session.ops).toHaveLength(2);
    session.undo();
    expect(session.ops).toEqual([{ op: 'remove', id: 'bleachers' }]);
    session.clear();
    expect(session.dirty || session.canUndo).toBe(false);
  });

  it('hands out primitive ids that are free', () => {
    const session = new EditSession();
    expect(session.nextId(new Set(['block-1', 'ball']))).toBe('block-2');
    session.push({ op: 'add', id: 'block-2', primitive: 'box', position: [0, 0.5, 0] });
    expect(session.nextId(new Set(['block-1']))).toBe('block-3');
  });

  it('tidies edits: later wins, moving a fresh primitive changes where it is added, removing it cancels it', () => {
    const ops: EditOp[] = [
      { op: 'add', id: 'block-1', primitive: 'box', position: [0, 0.5, 0], size: [1, 1, 1] },
      { op: 'move', id: 'block-1', position: [3, 0.5, 3] },
      { op: 'add', id: 'block-2', primitive: 'box', position: [1, 0.5, 1] },
      { op: 'remove', id: 'block-2' },
      { op: 'rules', minigame: 'shootout', rules: { durationSec: 30 } },
      { op: 'rules', minigame: 'shootout', rules: { pointsPerBasket: 3 } },
      { op: 'move', id: 'ball', position: [1, 0.12, 1] },
      { op: 'move', id: 'ball', position: [2, 0.12, 2] },
    ];
    expect(compactOps(ops)).toEqual([
      { op: 'add', id: 'block-1', primitive: 'box', position: [3, 0.5, 3], size: [1, 1, 1] },
      { op: 'rules', minigame: 'shootout', rules: { durationSec: 30, pointsPerBasket: 3 } },
      { op: 'move', id: 'ball', position: [2, 0.12, 2] },
    ]);
  });

  it('writes the layer-shaped edits as a v0.1 layer file', () => {
    expect(toLayer([
      { op: 'remove', id: 'bleachers' },
      { op: 'add', id: 'block-1', primitive: 'cylinder', position: [0, 0.5, 0], color: '#8b5cf6' },
      { op: 'move', id: 'ball', position: [2, 0.12, 2], rotation: [0, 0, 0, 1] },
      { op: 'spawn', position: [0, 1.7, 9] },
    ])).toEqual({
      version: '0.1',
      add: [{ id: 'block-1', primitive: 'cylinder', position: [0, 0.5, 0], color: '#8b5cf6' }],
      move: [{ id: 'ball', position: [2, 0.12, 2], rotation: [0, 0, 0, 1] }],
      remove: ['bleachers'],
    });
  });

  it('checks edits read back from storage', () => {
    expect(sanitizeOp({ op: 'move', id: 'ball', position: [1, 2, 3], extra: 1 })).toEqual({ op: 'move', id: 'ball', position: [1, 2, 3] });
    expect(sanitizeOp({ op: 'spawn', position: [0, 1.7, 9], lookAt: [0, 1, 0] })).toEqual({ op: 'spawn', position: [0, 1.7, 9], lookAt: [0, 1, 0] });
    expect(sanitizeOp({ op: 'rules', minigame: 'shootout', rules: { durationSec: 1e9, pointsPerBasket: 0 } })).toEqual({ op: 'rules', minigame: 'shootout', rules: { durationSec: 86400, pointsPerBasket: 1 } });
    for (const bad of [null, 'x', { op: 'move', id: 'ball' }, { op: 'remove', id: 'no spaces' }, { op: 'add', id: 'a', primitive: 'cone', position: [0, 0, 0] }, { op: 'teleport' }, { op: 'rules', minigame: 'm', rules: {} }]) {
      expect(sanitizeOp(bad)).toBeNull();
    }
  });

  it('describes each edit in a line', () => {
    expect(describeOp({ op: 'move', id: 'ball', position: [2, 0.12, 2] })).toBe('moved "ball" to 2.0, 0.1, 2.0');
    expect(describeOp({ op: 'rules', minigame: 'shootout', rules: { durationSec: 30 } })).toBe('shootout rules: durationSec 30');
  });
});
