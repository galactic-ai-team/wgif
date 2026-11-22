import { afterEach, describe, expect, it } from 'vitest';
import { MusicTrack } from '../src/audio/track.js';

/** Just enough Web Audio for MusicTrack: decoding fails or succeeds as told. */
class FakeContext {
  static decodes = 0;
  static decodeFails = true;
  state = 'running';
  sampleRate = 44100;
  currentTime = 0;
  destination = {};
  createGain() {
    return { connect() {}, gain: { value: 1, setTargetAtTime() {} } };
  }
  createAnalyser() {
    return { connect() {}, fftSize: 2048, getByteFrequencyData() {} };
  }
  createBufferSource() {
    return { connect() {}, start() {}, stop() {}, buffer: null as unknown, loop: false, loopStart: 0, loopEnd: 0, onended: null as unknown };
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  decodeAudioData(_bytes: ArrayBuffer, ok: (b: unknown) => void, fail: (e: Error) => void) {
    FakeContext.decodes++;
    if (FakeContext.decodeFails) {
      const e = new Error('bad data');
      fail(e);
      return Promise.reject(e);
    }
    const buffer = { sampleRate: 44100, length: 44100, duration: 1, getChannelData: () => new Float32Array(44100) };
    ok(buffer);
    return Promise.resolve(buffer);
  }
}

const g = globalThis as Record<string, unknown>;
const session = { type: 'auto' };
const track = (): MusicTrack => new MusicTrack(new Uint8Array([1, 2, 3]), { loop: true, loopSeconds: null, volume: 1 });

describe('MusicTrack', () => {
  afterEach(() => {
    delete g.AudioContext;
    delete (navigator as unknown as Record<string, unknown>).audioSession;
    FakeContext.decodes = 0;
    FakeContext.decodeFails = true;
    session.type = 'auto';
  });

  it('a tap after a failed decode tries again and still says so, instead of "playing" nothing', async () => {
    g.AudioContext = FakeContext;
    const t = track();
    await t.play();
    expect(t.state).toBe('error');
    await t.play();
    // On dev the second tap left state "playing" with no source after one decode.
    expect(t.state).toBe('error');
    expect(FakeContext.decodes).toBe(2);
    // A track that decodes on the next try plays.
    FakeContext.decodeFails = false;
    await t.play();
    expect(t.state).toBe('playing');
    expect(FakeContext.decodes).toBe(3);
  });

  it('asks for the media playback audio session while it plays (iOS ringer switch), and gives it back', async () => {
    g.AudioContext = FakeContext;
    FakeContext.decodeFails = false;
    Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
    const t = track();
    await t.play();
    expect(t.state).toBe('playing');
    expect(session.type).toBe('playback');
    t.pause();
    expect(session.type).toBe('auto');
    await t.play();
    expect(session.type).toBe('playback');
    t.dispose();
    expect(session.type).toBe('auto');
  });
});
