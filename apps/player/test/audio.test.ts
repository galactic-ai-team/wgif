import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loopPoints, SpectrumAnalysis } from '../src/audio/analysis.js';
import { Visualizer } from '../src/audio/visualizer.js';
import { exportWorld } from '../src/exporter.js';
import { parseInteractions } from '../src/interactions.js';
import { loadDocument, openWorld } from '../src/world.js';
import { open } from './helpers.js';

const musicBytes = (): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL('../../../examples/worlds/music.wgif', import.meta.url))));

const SR = 44100, FFT = 2048, BINS = FFT / 2;
const hz = (bin: number): number => (bin * SR) / FFT;
/** A synthetic spectrum: each bin's byte level from a function of its frequency. */
const spectrum = (f: (hz: number) => number): Uint8Array => {
  const out = new Uint8Array(BINS);
  for (let k = 0; k < BINS; k++) out[k] = Math.max(0, Math.min(255, Math.round(f(hz(k)))));
  return out;
};
const feed = (a: SpectrumAnalysis, freq: ArrayLike<number>, seconds: number, dt = 1 / 60): SpectrumAnalysis => {
  for (let t = 0; t < seconds; t += dt) a.update(freq, dt);
  return a;
};

describe('SpectrumAnalysis', () => {
  const make = (): SpectrumAnalysis => new SpectrumAnalysis({ bars: 64, sampleRate: SR, fftSize: FFT });

  it('stays at zero for silence', () => {
    const a = feed(make(), new Uint8Array(BINS), 1);
    expect(a.energy).toBe(0);
    expect(Math.max(...a.bars)).toBe(0);
    expect(a.beats).toBe(0);
  });

  it('puts a bass tone in the low bars and the bass band, a treble tone in the high ones', () => {
    const low = feed(make(), spectrum((f) => (f > 40 && f < 120 ? 240 : 0)), 0.5);
    expect(low.bass).toBeGreaterThan(0.5);
    expect(low.treble).toBe(0);
    expect(Math.max(...low.bars.slice(0, 16))).toBeGreaterThan(0.6);
    expect(Math.max(...low.bars.slice(40))).toBe(0);

    const high = feed(make(), spectrum((f) => (f > 4000 && f < 8000 ? 240 : 0)), 0.5);
    expect(high.treble).toBeGreaterThan(0.5);
    expect(high.bass).toBe(0);
    expect(Math.max(...high.bars.slice(48))).toBeGreaterThan(0.6);
    expect(Math.max(...high.bars.slice(0, 24))).toBe(0);
    expect(high.level('treble')).toBe(high.treble);
  });

  it('rises fast and falls slowly, then decays to silence', () => {
    const a = make();
    const loud = spectrum(() => 200);
    a.update(loud, 1 / 60);
    const afterOne = a.energy;
    expect(afterOne).toBeGreaterThan(0.1);
    feed(a, loud, 0.5);
    const top = a.energy;
    a.decay(1 / 60);
    expect(a.energy).toBeLessThan(top);
    expect(top - a.energy).toBeLessThan(top * 0.2); // a slow fall
    for (let i = 0; i < 240; i++) a.decay(1 / 60);
    expect(a.energy).toBeLessThan(0.01);
    expect(Math.max(...a.bars)).toBeLessThan(0.01);
  });

  it('counts beats in a 124 BPM kick pattern, at most one per kick', () => {
    const a = make();
    const kick = spectrum((f) => (f < 160 ? 230 : 40)), gap = spectrum((f) => (f < 160 ? 30 : 40));
    const dt = 1 / 60, beat = 60 / 124;
    for (let t = 0; t < 8 * beat; t += dt) a.update(t % beat < 0.1 ? kick : gap, dt);
    expect(a.beats).toBeGreaterThanOrEqual(7);
    expect(a.beats).toBeLessThanOrEqual(8);
  });

  it('a steady loud bass is not a stream of beats', () => {
    const bass = spectrum((f) => (f < 160 ? 230 : 0));
    const a = feed(make(), bass, 1); // the onset may count once or twice
    const onset = a.beats;
    expect(onset).toBeLessThanOrEqual(3);
    feed(a, bass, 4);
    expect(a.beats).toBe(onset);
  });
});

describe('loopPoints', () => {
  it('skips the encoder silence at the start and loops exactly the musical length', () => {
    const sr = 1000, samples = new Float32Array(12_000);
    for (let i = 50; i < 11_000; i++) samples[i] = Math.sin(i / 7) * 0.5;
    const p = loopPoints(samples, sr, 10);
    expect(p.start).toBeCloseTo(0.05, 6);
    expect(p.end - p.start).toBeCloseTo(10, 6);
  });

  it('loops the whole buffer without a known length, or when it is longer than the buffer', () => {
    const samples = new Float32Array(1000).fill(0.3);
    expect(loopPoints(samples, 100, null)).toEqual({ start: 0, end: 10 });
    expect(loopPoints(samples, 100, 12)).toEqual({ start: 0, end: 10 });
  });

  it('never starts later than the padding allows', () => {
    const samples = new Float32Array(1000); // all silent
    const p = loopPoints(samples, 100, 9);
    expect(p.start).toBeLessThanOrEqual(1);
    expect(p.end).toBeLessThanOrEqual(10);
  });
});

describe('audio interactions', () => {
  const parse = (entry: unknown) => parseInteractions({ interactions: [entry] });

  it('reads a track with defaults', () => {
    const { interactions, warnings } = parse({ type: 'audio', id: 'song', file: 'assets/song.mp3' });
    expect(warnings).toEqual([]);
    expect(interactions.audio).toEqual([
      {
        id: 'song', file: 'assets/song.mp3', title: null, artist: null, loop: true, loopSeconds: null, volume: 0.8,
        visualizer: { center: [0, 2.4, 0], radius: 7, bars: 96, hue: 0.75 }, react: [],
      },
    ]);
  });

  it('turns the visualizer off, clamps numbers and cleans reactors', () => {
    const { interactions } = parse({
      type: 'audio', id: 'song', file: 'assets/a.mp3', visualizer: false, volume: 7, loop: false, loopSeconds: 32,
      react: [{ node: 'pillar', band: 'bass', scale: [1, 99], axis: 'y', glow: 2 }, { node: 'x', band: 'loud' }, { band: 'mid' }, 'nope'],
    });
    const a = interactions.audio[0]!;
    expect(a.visualizer).toBeNull();
    expect(a.volume).toBe(1);
    expect(a.loop).toBe(false);
    expect(a.loopSeconds).toBe(32);
    expect(a.react).toEqual([
      { node: 'pillar', band: 'bass', scale: [1, 20], axis: 'y', glow: 2 },
      { node: 'x', band: 'energy', scale: null, axis: 'all', glow: 0 },
    ]);
  });

  it('refuses paths outside the world and tracks without an id', () => {
    for (const file of ['../secret.mp3', 'https://x.test/a.mp3', '', 42]) {
      const r = parse({ type: 'audio', id: 'song', file });
      expect(r.interactions.audio).toEqual([]);
      expect(r.warnings.length).toBe(1);
    }
    expect(parse({ type: 'audio', file: 'assets/a.mp3' }).interactions.audio).toEqual([]);
  });

  it('warns about a second track with the same id', () => {
    const r = parseInteractions({ interactions: [{ type: 'audio', id: 't', file: 'a.mp3' }, { type: 'audio', id: 't', file: 'b.mp3' }] });
    expect(r.interactions.audio.map((a) => a.file)).toEqual(['a.mp3']);
    expect(r.warnings.length).toBe(1);
  });
});

describe('the music world', () => {
  it('opens with its track, credits and reactive nodes, under the budgets', async () => {
    const bytes = musicBytes();
    expect(bytes.length).toBeLessThan(1024 * 1024);
    const w = await open(bytes);
    expect(w.doc.warnings).toEqual([]);
    const [track] = w.doc.interactions.audio;
    expect(w.doc.interactions.audio.length).toBe(1);
    expect(track).toMatchObject({ id: 'track', file: 'assets/music-neon-pulse.mp3', title: 'Neon Pulse', loop: true });
    expect(track!.loopSeconds).toBeCloseTo((24 * 4 * 60) / 124, 6);
    const mp3 = w.doc.world.files[track!.file]!;
    expect(mp3.length).toBeGreaterThan(100_000);
    expect(mp3.length).toBeLessThanOrEqual(256 * 1024);
    // An MPEG audio frame header (no ID3 tag: metadata is stripped).
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1]! & 0xe0).toBe(0xe0);
    const credits = JSON.stringify(w.doc.world.manifest);
    expect(credits).toContain('CC0-1.0');
    expect(credits).toContain('synth-track.py');
    for (const r of track!.react) expect(w.scene.getObjectByName(r.node), r.node).toBeTruthy();
  });

  it('builds the visualizer and moves it with the music, and settles when it stops', async () => {
    const w = await open(musicBytes());
    const def = w.doc.interactions.audio[0]!;
    const vis = new Visualizer(def, w.scene);
    const a = new SpectrumAnalysis({ bars: def.visualizer!.bars, sampleRate: SR, fftSize: FFT });
    const rest = { ...vis.stats };
    expect(rest.coreScale).toBeCloseTo(1, 1);
    const loud = spectrum((f) => 220 - f / 80);
    for (let i = 0; i < 60; i++) vis.update(a.update(loud, 1 / 60), 1 / 60, true);
    expect(vis.stats.barMax).toBeGreaterThan(rest.barMax + 1);
    expect(vis.stats.coreScale).toBeGreaterThan(1.05);
    for (let i = 0; i < 600; i++) vis.update(a.decay(1 / 60), 1 / 60, false);
    expect(vis.stats.barMax).toBeLessThan(rest.barMax + 0.2);
    vis.dispose();
  });

  it('keeps the track when the world is exported as an edit', async () => {
    const doc = await loadDocument(await openWorld(musicBytes()));
    const result = await exportWorld(doc, { ops: [{ op: 'spawn', position: [0, 1.7, 9], lookAt: [0, 2, 0] }], state: null, by: 'tester', at: new Date('2026-11-16T15:00:00Z') });
    const out = await loadDocument(await openWorld(result.bytes));
    expect(out.warnings).toEqual([]);
    expect(out.interactions.audio[0]?.file).toBe('assets/music-neon-pulse.mp3');
    expect(out.world.files['assets/music-neon-pulse.mp3']).toEqual(doc.world.files['assets/music-neon-pulse.mp3']);
  });
});
