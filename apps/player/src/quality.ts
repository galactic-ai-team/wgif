/**
 * Keeps the frame rate up on slow devices by trading resolution and shadows for speed.
 *
 * Browsers cap rendering at the display's refresh rate, so a fast frame says nothing about spare
 * capacity; only slow frames are informative. The governor therefore steps down as soon as a
 * device cannot keep up, and probes one step back up only after a long steady stretch. If a probe
 * fails, that level becomes the ceiling and it stops trying.
 */
export interface QualitySettings {
  /** Device pixels per CSS pixel to render at. */
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
}

export interface QualityOptions {
  devicePixelRatio: number;
  /** Phones and tablets start one step down and have a lower resolution cap. */
  mobile: boolean;
}

interface Level {
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
}

const LEVELS: readonly Level[] = [
  { maxPixelRatio: 2, shadows: true, shadowMapSize: 2048 },
  { maxPixelRatio: 1.5, shadows: true, shadowMapSize: 1024 },
  { maxPixelRatio: 1.25, shadows: true, shadowMapSize: 1024 },
  { maxPixelRatio: 1, shadows: false, shadowMapSize: 1024 },
  { maxPixelRatio: 0.75, shadows: false, shadowMapSize: 1024 },
];

/** Frames slower than this (ms) mean the device is not holding roughly 50 fps. */
const SLOW_FRAME_MS = 20;
const WINDOW_FRAMES = 45;
const SLOW_WINDOWS_TO_DROP = 2;
const STEADY_WINDOWS_TO_PROBE = 20;
const SETTLE_FRAMES = 30;

export class QualityGovernor {
  level: number;
  /** Best level worth trying. Raised (made worse) when a probe upwards fails. */
  ceiling = 0;
  private readonly dpr: number;
  private frames = 0;
  private total = 0;
  private slowWindows = 0;
  private steadyWindows = 0;
  private settle = SETTLE_FRAMES;
  private probing = false;

  constructor(opts: QualityOptions) {
    this.dpr = Math.max(0.5, opts.devicePixelRatio || 1);
    this.level = opts.mobile ? 1 : 0;
  }

  get settings(): QualitySettings {
    const level = LEVELS[this.level]!;
    return { pixelRatio: Math.min(this.dpr, level.maxPixelRatio), shadows: level.shadows, shadowMapSize: level.shadowMapSize };
  }

  /** Feed the time each frame took, in milliseconds. Returns true when the settings changed. */
  sample(frameMs: number): boolean {
    // Long gaps are tab switches or loading hitches, not rendering cost.
    if (!(frameMs > 0) || frameMs > 250) return false;
    if (this.settle > 0) {
      this.settle--;
      return false;
    }
    this.total += frameMs;
    if (++this.frames < WINDOW_FRAMES) return false;
    const average = this.total / this.frames;
    this.frames = 0;
    this.total = 0;

    if (average > SLOW_FRAME_MS) {
      this.steadyWindows = 0;
      if (++this.slowWindows < SLOW_WINDOWS_TO_DROP && !this.probing) return false;
      this.slowWindows = 0;
      if (this.probing) {
        // The step up was too much: go back and remember not to try again.
        this.probing = false;
        this.ceiling = this.level + 1;
      }
      return this.move(this.level + 1);
    }
    this.slowWindows = 0;
    if (this.probing && ++this.steadyWindows >= 4) {
      this.probing = false;
      this.steadyWindows = 0;
    }
    if (!this.probing && ++this.steadyWindows >= STEADY_WINDOWS_TO_PROBE && this.level > this.ceiling) {
      this.steadyWindows = 0;
      this.probing = true;
      return this.move(this.level - 1);
    }
    return false;
  }

  private move(to: number): boolean {
    const next = Math.max(this.ceiling, Math.min(LEVELS.length - 1, to));
    if (next === this.level) return false;
    this.level = next;
    this.settle = SETTLE_FRAMES;
    return true;
  }
}
