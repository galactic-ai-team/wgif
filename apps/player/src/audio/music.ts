import type { AudioDef } from '../interactions.js';
import type { WorldViewer } from '../viewer.js';
import { SpectrumAnalysis } from './analysis.js';
import { MusicTrack, type TrackState } from './track.js';
import { Visualizer, type VisualStats } from './visualizer.js';

/**
 * Glue for a world's music track (loaded on demand, only for worlds that have one): the track,
 * its analysis, the visual, and the on-screen controls (a big "Tap to play", a play/pause button,
 * the title and a volume slider). Disposed with the world.
 */
export interface MusicUi {
  tap: HTMLButtonElement;
  bar: HTMLElement;
  toggle: HTMLButtonElement;
  title: HTMLElement;
  volume: HTMLInputElement;
}

export interface MusicStatus {
  state: TrackState;
  context: AudioContextState | 'none';
  /** Overall level, 0..1. */
  energy: number;
  bass: number;
  beats: number;
  error: string | null;
  visual: VisualStats;
}

export class WorldMusic {
  readonly track: MusicTrack;
  readonly visual: Visualizer;
  private analysis: SpectrumAnalysis | null = null;
  private readonly abort = new AbortController();
  private disposed = false;

  constructor(private readonly viewer: WorldViewer, readonly def: AudioDef, bytes: Uint8Array, private readonly ui: MusicUi) {
    this.track = new MusicTrack(bytes, { loop: def.loop, loopSeconds: def.loopSeconds, volume: def.volume });
    this.visual = new Visualizer(def, viewer.worldRoot);
    viewer.scene.add(this.visual.group);
    viewer.attach({ update: (dt) => this.frame(dt), dispose: () => this.dispose() });
    const on = { signal: this.abort.signal };
    ui.title.textContent = [def.title, def.artist].filter(Boolean).join(' — ') || 'Music';
    ui.tap.querySelector('small')?.replaceChildren(ui.title.textContent);
    ui.volume.value = String(Math.round(def.volume * 100));
    ui.tap.hidden = false;
    ui.bar.hidden = false;
    ui.tap.addEventListener('click', () => void this.toggle(), on);
    ui.toggle.addEventListener('click', () => void this.toggle(), on);
    ui.volume.addEventListener('input', () => this.track.setVolume(Number(ui.volume.value) / 100), on);
    window.addEventListener('keydown', (e) => {
      const el = e.target as HTMLElement | null;
      if (e.code !== 'KeyP' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;
      void this.toggle();
    }, on);
    // A hidden tab stops the music; it waits on the play button when the visitor comes back.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.track.pause();
    }, on);
    this.track.onChange = (state) => this.render(state);
    this.render(this.track.state);
  }

  /** Play or pause. Must run inside the user's tap or click (browsers only start audio there). */
  toggle(): Promise<void> {
    return this.track.toggle();
  }

  status(): MusicStatus {
    return {
      state: this.track.state,
      context: this.track.ctx?.state ?? 'none',
      energy: this.analysis?.energy ?? 0,
      bass: this.analysis?.bass ?? 0,
      beats: this.analysis?.beats ?? 0,
      error: this.track.error,
      visual: { ...this.visual.stats },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.track.dispose();
    this.visual.dispose();
    this.ui.tap.hidden = true;
    this.ui.bar.hidden = true;
  }

  private frame(dt: number): boolean {
    const playing = this.track.state === 'playing';
    if (playing) {
      this.analysis ??= new SpectrumAnalysis({ bars: this.def.visualizer?.bars ?? 64, sampleRate: this.track.sampleRate, fftSize: this.track.fftSize });
      this.analysis.update(this.track.frequencies(), dt);
    } else if (this.analysis && (this.analysis.energy > 0.002 || this.analysis.bars.some((b) => b > 0.002))) {
      this.analysis.decay(dt);
    } else if (!this.visual.settling) {
      return false; // silent and still: no frames needed
    }
    this.visual.update(this.analysis, dt, playing);
    return true;
  }

  private render(state: TrackState): void {
    const playing = state === 'playing' || state === 'loading';
    this.ui.toggle.textContent = state === 'loading' ? '…' : playing ? '⏸' : '▶';
    this.ui.toggle.setAttribute('aria-label', playing ? 'Pause the music' : 'Play the music');
    this.ui.toggle.setAttribute('aria-pressed', String(playing));
    this.ui.tap.hidden = state !== 'idle' && state !== 'error';
    if (state === 'error') this.ui.title.textContent = this.track.error ?? 'The track could not play';
    this.viewer.setAutoRotate(state === 'playing' ? 0.6 : 0);
    this.viewer.invalidate();
  }
}

export function mountMusic(viewer: WorldViewer, def: AudioDef, bytes: Uint8Array, ui: MusicUi): WorldMusic {
  return new WorldMusic(viewer, def, bytes, ui);
}
