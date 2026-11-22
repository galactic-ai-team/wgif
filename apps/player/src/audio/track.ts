import { loopPoints } from './analysis.js';

/**
 * One music track from inside a world, played through Web Audio: source -> gain -> analyser ->
 * speakers. Nothing is fetched: the bytes come from the .wgif, so it plays offline.
 *
 * Browsers only start audio from a user gesture, and iOS Safari only from a context created or
 * resumed inside one, so `play()` must be called from a tap or click handler: it creates (or
 * resumes) the AudioContext synchronously before anything async happens. Pause suspends the
 * context, so play carries on where it stopped.
 */
export type TrackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

/**
 * iOS plays Web Audio in the "ambient" session by default, which the ringer switch mutes: the
 * visual moves and nothing is heard. A page that plays music says so through Safari's
 * `navigator.audioSession`, where it exists; elsewhere this does nothing.
 */
function audioSession(type: 'playback' | 'auto'): void {
  const session = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (!session) return;
  try {
    session.type = type;
  } catch {
    // An unknown type on an older implementation: keep the default.
  }
}

export interface TrackOptions {
  loop: boolean;
  loopSeconds: number | null;
  volume: number;
  fftSize?: number;
}

export class MusicTrack {
  state: TrackState = 'idle';
  error: string | null = null;
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  readonly freq: Uint8Array<ArrayBuffer>;
  onChange: (state: TrackState) => void = () => undefined;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private decoding: Promise<void> | null = null;
  private volumeLevel: number;

  constructor(private readonly bytes: Uint8Array, private readonly opts: TrackOptions) {
    this.volumeLevel = opts.volume;
    this.freq = new Uint8Array((opts.fftSize ?? 2048) / 2);
  }

  get volume(): number {
    return this.volumeLevel;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  get fftSize(): number {
    return this.freq.length * 2;
  }

  /** Starts or resumes playback. Call it from a user gesture. */
  play(): Promise<void> {
    if (this.state === 'playing') return Promise.resolve();
    const Ctor = (globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as AudioContextCtor | undefined;
    if (!Ctor) return this.fail('This browser has no Web Audio, so the track cannot play.');
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volumeLevel;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = 0.6;
      // Headroom for loud masters, so the bars and the bass still move instead of sitting at the top.
      this.analyser.minDecibels = -90;
      this.analyser.maxDecibels = -12;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    // Resume first, synchronously inside the gesture (iOS needs this before any await).
    const resumed = this.ctx.resume();
    audioSession('playback');
    if (!this.source) {
      this.set('loading');
      this.decoding ??= this.start();
      return this.decoding
        .then(() => resumed)
        .then(
          () => {
            // Only a decoded, started track plays: after a failed decode there is no source.
            if (this.state === 'loading' && this.source) this.set('playing');
          },
          (e: unknown) => this.fail(String(e)),
        );
    }
    this.set('playing');
    return resumed.catch((e: unknown) => this.fail(String(e)));
  }

  pause(): void {
    if (this.state !== 'playing' && this.state !== 'loading') return;
    void this.ctx?.suspend();
    audioSession('auto');
    this.set('paused');
  }

  toggle(): Promise<void> {
    if (this.state === 'playing' || this.state === 'loading') {
      this.pause();
      return Promise.resolve();
    }
    return this.play();
  }

  setVolume(v: number): void {
    this.volumeLevel = Math.max(0, Math.min(1, v));
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(this.volumeLevel, this.ctx.currentTime, 0.03);
  }

  /** Current frequency data (0..255 per bin), or silence when not playing. */
  frequencies(): Uint8Array {
    if (this.analyser && this.state === 'playing') this.analyser.getByteFrequencyData(this.freq);
    else this.freq.fill(0);
    return this.freq;
  }

  dispose(): void {
    try {
      this.source?.stop();
    } catch {
      // never started
    }
    void this.ctx?.close().catch(() => undefined);
    if (this.ctx) audioSession('auto');
    this.ctx = null;
    this.source = null;
    this.decoding = null;
    this.state = 'idle';
  }

  private async start(): Promise<void> {
    const ctx = this.ctx!;
    let buffer: AudioBuffer;
    try {
      // decodeAudioData detaches its argument: give it a copy of the payload.
      const copy = this.bytes.slice().buffer;
      buffer = await new Promise<AudioBuffer>((resolve, reject) => {
        const p = ctx.decodeAudioData(copy, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
    } catch (e) {
      // Forget the failed attempt, so the next tap decodes again instead of "playing" nothing.
      if (this.ctx === ctx) this.decoding = null;
      await this.fail(`The track could not be decoded: ${(e as Error)?.message ?? e}`);
      return;
    }
    if (this.ctx !== ctx) return; // disposed while decoding
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = this.opts.loop;
    const { start, end } = loopPoints(buffer.getChannelData(0), buffer.sampleRate, this.opts.loopSeconds);
    source.loopStart = start;
    source.loopEnd = end;
    source.connect(this.gain!);
    source.onended = () => {
      if (this.source === source && !this.opts.loop) {
        this.source = null;
        this.decoding = null;
        audioSession('auto');
        this.set('paused');
      }
    };
    source.start(0, start);
    this.source = source;
    if (this.state === 'paused') void ctx.suspend();
  }

  private fail(message: string): Promise<void> {
    this.error = message;
    this.set('error');
    return Promise.resolve();
  }

  private set(state: TrackState): void {
    if (this.state === state) return;
    this.state = state;
    this.onChange(state);
  }
}
