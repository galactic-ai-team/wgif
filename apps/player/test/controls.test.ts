import { describe, expect, it } from 'vitest';
import { startsOnScene } from '../src/controls.js';

describe('controls', () => {
  it('only lets a press on the 3D view itself move, look or capture the mouse', () => {
    expect(startsOnScene({ tagName: 'CANVAS' } as unknown as EventTarget)).toBe(true);
    // Buttons and panels over the view keep their own clicks.
    for (const tagName of ['BUTTON', 'INPUT', 'DIV', 'LABEL']) expect(startsOnScene({ tagName } as unknown as EventTarget)).toBe(false);
    expect(startsOnScene(null)).toBe(false);
  });
});
