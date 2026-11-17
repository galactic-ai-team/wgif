/**
 * Tiny synthesized sound effects (Web Audio). No audio files: nothing to download, license or cache.
 * Browsers only allow sound after a tap or key press, so the context is created on the first one.
 */
const MUTE_KEY = 'wgif.muted';

type Wave = 'sine' | 'square' | 'triangle' | 'sawtooth';

export class Sfx {
  muted: boolean;
  private ctx: AudioContext | null = null;
  private lastBounce = 0;

  constructor() {
    this.muted = readFlag();
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.muted) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      // private mode: the choice just does not persist
    }
    if (muted) void this.ctx?.suspend();
    else this.unlock();
  }

  /** A ball hitting something. Louder for harder hits, brighter for metal. */
  bounce(speed: number, metal: boolean): void {
    const now = performance.now();
    if (now - this.lastBounce < 40) return;
    this.lastBounce = now;
    const gain = Math.min(0.5, 0.05 + speed * 0.04);
    if (metal) {
      this.tone('triangle', 640, 0.12, gain * 0.8, 520);
      this.tone('sine', 1510, 0.09, gain * 0.3);
    } else {
      this.tone('sine', 150, 0.11, gain, 70);
    }
  }

  swish(): void {
    this.noise(0.28, 0.22, 2600);
  }

  score(): void {
    this.tone('triangle', 660, 0.09, 0.2);
    this.tone('triangle', 990, 0.16, 0.2, undefined, 0.09);
  }

  beep(high = false): void {
    this.tone('square', high ? 880 : 440, high ? 0.3 : 0.12, 0.12);
  }

  buzzer(): void {
    this.tone('sawtooth', 196, 0.7, 0.18);
    this.tone('sawtooth', 147, 0.7, 0.14);
  }

  grab(): void {
    this.tone('sine', 220, 0.06, 0.12, 300);
  }

  private tone(type: Wave, freq: number, duration: number, gain: number, endFreq?: number, delay = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator(), amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  private noise(duration: number, gain: number, cutoff: number): void {
    const ctx = this.ready();
    if (!ctx) return;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 1;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 2147483648 - 1) * (1 - i / data.length);
    }
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), amp = ctx.createGain();
    src.buffer = buffer;
    filter.type = 'highpass';
    filter.frequency.value = cutoff;
    amp.gain.value = gain;
    src.connect(filter).connect(amp).connect(ctx.destination);
    src.start();
  }

  private ready(): AudioContext | null {
    return !this.muted && this.ctx?.state === 'running' ? this.ctx : null;
  }
}

function readFlag(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}
