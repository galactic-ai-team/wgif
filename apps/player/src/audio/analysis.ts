/**
 * Turns analyser frequency data into what a visual needs: smoothed bar levels on a log scale,
 * band levels (bass / mid / treble / overall energy) and beats. Pure and deterministic, no Web
 * Audio or DOM, so it is unit-tested with synthetic spectra.
 */
export interface Levels {
  bass: number;
  mid: number;
  treble: number;
  energy: number;
}

export interface AnalysisOptions {
  /** Number of bars to produce. */
  bars: number;
  /** Sample rate of the audio and FFT size of the analyser (bins = fftSize / 2). */
  sampleRate: number;
  fftSize: number;
  /** Frequency span of the bars, Hz (log spaced). */
  minHz?: number;
  maxHz?: number;
}

const BASS: [number, number] = [30, 180];
const MID: [number, number] = [180, 2000];
const TREBLE: [number, number] = [2000, 11000];
/** A beat is a sharp rise in the bass, or bass this much above its recent average, at most this often. */
const BEAT_RATIO = 1.25;
const BEAT_RISE = 0.06;
const BEAT_GAP_SEC = 0.22;

export class SpectrumAnalysis implements Levels {
  readonly bars: Float32Array;
  bass = 0;
  mid = 0;
  treble = 0;
  energy = 0;
  /** True on the update a beat was detected. */
  beat = false;
  beats = 0;
  private readonly edges: Int32Array;
  private readonly bands: { bass: [number, number]; mid: [number, number]; treble: [number, number] };
  private bassAvg = 0;
  private lastBass = 0;
  private sinceBeat = 1e9;

  constructor(readonly opts: AnalysisOptions) {
    const bins = opts.fftSize / 2, hzPerBin = opts.sampleRate / opts.fftSize;
    const lo = Math.max(hzPerBin, opts.minHz ?? 35), hi = Math.min(opts.sampleRate / 2, opts.maxHz ?? 11000);
    this.bars = new Float32Array(opts.bars);
    this.edges = new Int32Array(opts.bars + 1);
    for (let i = 0; i <= opts.bars; i++) {
      const f = lo * (hi / lo) ** (i / opts.bars);
      this.edges[i] = Math.min(bins - 1, Math.max(1, Math.round(f / hzPerBin)));
    }
    // Every bar covers at least one bin of its own.
    for (let i = 1; i <= opts.bars; i++) if (this.edges[i]! <= this.edges[i - 1]!) this.edges[i] = Math.min(bins, this.edges[i - 1]! + 1);
    const bin = (hz: number): number => Math.min(bins - 1, Math.max(0, Math.round(hz / hzPerBin)));
    const band = (b: [number, number]): [number, number] => [bin(b[0]), Math.max(bin(b[0]) + 1, bin(b[1]))];
    this.bands = { bass: band(BASS), mid: band(MID), treble: band(TREBLE) };
  }

  /** Feeds one frame of byte frequency data (0..255 per bin), `dt` seconds after the last. */
  update(freq: ArrayLike<number>, dt: number): this {
    const rise = 1 - Math.exp(-dt * 30), fall = 1 - Math.exp(-dt * 6);
    for (let i = 0; i < this.bars.length; i++) {
      const a = this.edges[i]!, b = this.edges[i + 1]!;
      let peak = 0;
      for (let k = a; k < b; k++) peak = Math.max(peak, freq[k] ?? 0);
      // Treble is quieter in music: tilt it up so the ring is not a slope.
      const tilt = 0.85 + 0.35 * (i / this.bars.length);
      const target = Math.min(1, (peak / 255) * tilt) ** 1.4;
      const cur = this.bars[i]!;
      this.bars[i] = cur + (target - cur) * (target > cur ? rise : fall);
    }
    const avg = (r: [number, number]): number => {
      let sum = 0;
      for (let k = r[0]; k < r[1]; k++) sum += freq[k] ?? 0;
      return sum / Math.max(1, r[1] - r[0]) / 255;
    };
    const smooth = (cur: number, v: number): number => cur + (v - cur) * (v > cur ? rise : fall);
    const bass = avg(this.bands.bass);
    this.bass = smooth(this.bass, bass);
    this.mid = smooth(this.mid, avg(this.bands.mid));
    this.treble = smooth(this.treble, Math.min(1, avg(this.bands.treble) * 1.6));
    this.energy = smooth(this.energy, (bass * 0.5 + this.mid * 0.35 + this.treble * 0.15));
    // Beats: bass well above its own slow average.
    this.sinceBeat += dt;
    this.beat = bass > 0.2 && (bass > this.bassAvg * BEAT_RATIO || bass - this.lastBass > BEAT_RISE) && this.sinceBeat > BEAT_GAP_SEC;
    this.lastBass = bass;
    if (this.beat) {
      this.sinceBeat = 0;
      this.beats++;
    }
    this.bassAvg += (bass - this.bassAvg) * (1 - Math.exp(-dt * 2.5));
    return this;
  }

  /** Level of a named band. */
  level(band: keyof Levels): number {
    return this[band];
  }

  /** Lets everything fall back to silence (while paused). */
  decay(dt: number): this {
    return this.update(SILENCE, dt);
  }
}

const SILENCE: ArrayLike<number> = { length: 0 };

/**
 * Where a loop starts and ends in a decoded track. MP3 and AAC encoders pad the start and end with
 * silence, so a naive loop of the whole buffer has a gap. With the loop's musical length known,
 * the loop starts at the first audible sample and lasts exactly that long.
 */
export function loopPoints(samples: ArrayLike<number>, sampleRate: number, loopSeconds: number | null, threshold = 0.002): { start: number; end: number } {
  const duration = samples.length / sampleRate;
  if (!loopSeconds || loopSeconds >= duration) return { start: 0, end: duration };
  const maxLead = Math.min(samples.length, Math.ceil((duration - loopSeconds) * sampleRate));
  let first = 0;
  while (first < maxLead && Math.abs(samples[first]!) < threshold) first++;
  const start = first / sampleRate;
  return { start, end: Math.min(duration, start + loopSeconds) };
}
