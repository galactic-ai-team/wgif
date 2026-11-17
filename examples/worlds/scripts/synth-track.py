#!/usr/bin/env python3
"""
Synthesises "Neon Pulse", the original music track of music.wgif, from nothing but code
(numpy oscillators and noise, no samples), and encodes it as MP3 with ffmpeg/libmp3lame.

    python3 examples/worlds/scripts/synth-track.py            # -> assets/music-neon-pulse.mp3

124 BPM, A minor (Am - F - C - G), 24 bars (about 46 s) that loop seamlessly: build, drop,
break, drop, outro, intro (back into the build), so it starts with the beat. Written for this repository by the Galactic AI Team and dedicated to
the public domain (CC0 1.0), like the rest of the generated assets. Needs Python 3 + numpy and
ffmpeg with libmp3lame. The MP3 is committed; the world generator only packs it.
"""
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

SR = 44100
BPM = 124
BEAT = 60 / BPM
BARS = 24
N = int(round(BARS * 4 * BEAT * SR))
rng = np.random.default_rng(124)
here = os.path.dirname(os.path.abspath(__file__))
out_mp3 = os.path.join(here, '..', 'assets', 'music-neon-pulse.mp3')

CHORDS = [  # root (MIDI) and chord tones per bar of a 4-bar cycle
    (45, [57, 60, 64]),  # Am
    (41, [53, 57, 60]),  # F
    (48, [55, 60, 64]),  # C
    (43, [55, 59, 62]),  # G
]
hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)
t_all = np.arange(N) / SR


def section(bar):
    """build 0-3, drop 4-7, break 8-11, drop 12-15, outro 16-19, intro 20-23 (which loops into the build)"""
    return ['build', 'drop', 'break', 'drop', 'outro', 'intro'][bar // 4]


def place(buf, start, sound):
    """Adds `sound` at sample `start`, wrapping round the end so the loop is seamless."""
    start %= N
    end = start + len(sound)
    if end <= N:
        buf[start:end] += sound
    else:
        k = N - start
        buf[start:] += sound[:k]
        buf[: end - N] += sound[k:]


def env(n, attack, decay):
    t = np.arange(n) / SR
    a = np.minimum(1, t / max(attack, 1e-4))
    return a * np.exp(-t / decay)


def tone(freq, dur, harmonics=8, roll=1.6, odd=False, detune=0.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for h in range(1, harmonics + 1):
        if odd and h % 2 == 0:
            continue
        f = freq * h
        if f > SR / 2.2:
            break
        out += np.sin(2 * np.pi * f * t * (1 + detune)) / h ** roll
    return out


def highpass(x):
    return np.diff(x, prepend=0.0)


kick_buf, snare_buf, hat_buf, bass_buf, pad_buf, arp_buf = (np.zeros(N) for _ in range(6))

kick_n = int(0.42 * SR)
kt = np.arange(kick_n) / SR
kick_freq = 45 + 110 * np.exp(-kt / 0.045)
KICK = np.sin(2 * np.pi * np.cumsum(kick_freq) / SR) * np.exp(-kt / 0.16)
KICK[: int(0.004 * SR)] += rng.uniform(-0.6, 0.6, int(0.004 * SR))

clap_n = int(0.25 * SR)
CLAP = highpass(highpass(rng.uniform(-1, 1, clap_n))) * env(clap_n, 0.001, 0.07) * 0.5
for d in (0.011, 0.022):
    CLAP[int(d * SR):] += CLAP[: clap_n - int(d * SR)] * 0.5

hat_n = int(0.06 * SR)
HAT = highpass(highpass(highpass(rng.uniform(-1, 1, hat_n)))) * env(hat_n, 0.0005, 0.014) * 0.25
OHAT = highpass(highpass(highpass(rng.uniform(-1, 1, int(0.22 * SR))))) * env(int(0.22 * SR), 0.001, 0.07) * 0.16

sidechain = np.ones(N)
for bar in range(BARS):
    s = section(bar)
    root, notes = CHORDS[bar % 4]
    b0 = int(bar * 4 * BEAT * SR)
    for beat in range(4):
        at = b0 + int(beat * BEAT * SR)
        kick_on = s in ('drop', 'build') or (s == 'outro' and bar < 19)
        if kick_on:
            place(kick_buf, at, KICK)
            duck = 1 - 0.7 * np.exp(-np.arange(int(BEAT * SR)) / SR / 0.11)
            sidechain[at:at + len(duck)] = np.minimum(sidechain[at:at + len(duck)], duck[: N - at])
        if s == 'drop' and beat in (1, 3):
            place(snare_buf, at, CLAP)
        if s == 'build' and bar == 3:  # snare roll into the drop
            for k in range(4):
                place(snare_buf, at + int(k * BEAT / 4 * SR), CLAP * (0.3 + 0.17 * beat))
        for half in range(2):
            h_at = at + int(half * BEAT / 2 * SR)
            if s != 'break' or half == 1:
                place(hat_buf, h_at, HAT * (1.0 if half else 0.6))
            if half == 1 and s in ('drop', 'outro'):
                place(hat_buf, h_at, OHAT)
        # Bass: off-beat 8ths in the build, rolling 16ths in the drops.
        if s in ('build', 'drop', 'outro'):
            steps = [2] if s == 'build' else [1, 2, 3]
            for st in steps:
                note = root + (12 if st == 2 else 0)
                b = tone(hz(note), BEAT / 4 * 0.95, harmonics=10, roll=1.0) * env(int(BEAT / 4 * 0.95 * SR), 0.003, 0.09)
                place(bass_buf, at + int(st * BEAT / 4 * SR), b * 0.55)
    # Pad: the bar's chord, slow attack, three detuned voices.
    pad_len = 4 * BEAT + 0.6
    p = np.zeros(int(pad_len * SR))
    for m in notes:
        for det in (-0.004, 0.0, 0.0045):
            p += tone(hz(m), pad_len, harmonics=7, roll=1.8, detune=det)
    shape = np.minimum(1, np.arange(len(p)) / SR / 0.6) * np.minimum(1, (len(p) / SR - np.arange(len(p)) / SR) / 0.6)
    pad_gain = {'intro': 0.16, 'build': 0.14, 'drop': 0.1, 'break': 0.2, 'outro': 0.13}[s]
    place(pad_buf, b0, p * shape * pad_gain)
    # Arp: 16th plucks through the chord, in the drops and the break.
    if s in ('drop', 'break') or (s == 'build' and bar >= 2):
        seq = [notes[0] + 12, notes[1] + 12, notes[2] + 12, notes[1] + 24]
        for k in range(16):
            m = seq[(k + bar) % 4] if s != 'break' else seq[k % 4] + (0 if k % 8 < 4 else -12)
            n_len = BEAT / 4 * 1.6
            a = tone(hz(m), n_len, harmonics=9, roll=1.1, odd=True) * env(int(n_len * SR), 0.002, 0.075)
            place(arp_buf, b0 + int(k * BEAT / 4 * SR), a * 0.13)

# A dotted-8th echo on the arp.
delay = int(0.75 * BEAT * SR)
echo = np.zeros(N)
for k, g in ((1, 0.38), (2, 0.16)):
    echo += np.roll(arp_buf, delay * k) * g
arp_buf += echo

mix = kick_buf * 0.9 + snare_buf * 0.6 + hat_buf * 0.7 + (bass_buf * 0.8 + pad_buf + arp_buf) * sidechain
mix = np.tanh(mix * 1.4) / np.tanh(1.4)  # soft clip glue
mix *= 0.89 / np.max(np.abs(mix))
pcm = (mix * 32767).astype('<i2')

with tempfile.TemporaryDirectory() as tmp:
    wav = os.path.join(tmp, 'track.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    rate = sys.argv[1] if len(sys.argv) > 1 else '40k'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-map_metadata', '-1', '-codec:a', 'libmp3lame', '-b:a', rate, '-ac', '1',
                    '-id3v2_version', '0', '-write_xing', '1', out_mp3], check=True)
print(f'{out_mp3}: {os.path.getsize(out_mp3)} bytes, {N / SR:.2f} s at {BPM} BPM')
