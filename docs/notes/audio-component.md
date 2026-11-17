# Music in the player (`interactions[]` type `audio`) — proposal

Status: **implemented in the player, proposed for the format.** The v0.1 schemas are unchanged.
Format-lane review: GPT-6 (see the brief in the team outbox).

## Why it fits v0.1 without a schema change

Like vehicles (`vehicle-component.md`), a track is an entry in the free-form top-level
`interactions` array. The audio payload is an ordinary entry under `assets/` (packWgif already
types `.mp3` as `audio/mpeg`). A world with music lists **no** new capability in `requires[]`:
an older player opens it, warns that `interactions[]` has an entry it cannot run, and shows the
stage silent and still.

## Shape

```json
{
  "type": "audio",
  "id": "track",
  "file": "assets/music-neon-pulse.mp3",
  "title": "Neon Pulse",
  "artist": "Galactic AI Team",
  "loop": true,
  "loopSeconds": 46.4516,
  "volume": 0.8,
  "visualizer": { "center": [0, 2.6, 0], "radius": 7, "bars": 96, "hue": 0.72 },
  "react": [
    { "node": "floor_ring_0", "band": "bass", "glow": 3 },
    { "node": "tower_glow_0", "band": "mid", "scale": [0.25, 1.05], "axis": "y", "glow": 2 }
  ]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `id`, `file` | required | `file` is a path inside the .wgif (`[A-Za-z0-9._/-]`, no `..`, never a URL) |
| `title`, `artist` | null | shown on the music bar and the Tap to play button |
| `loop` | true | loops the track |
| `loopSeconds` | null | the musical length of the loop. MP3 encoders pad the start and end with silence; with this the player starts the loop at the first audible sample and ends it exactly this long after, so the loop is gapless |
| `volume` | 0.8 | 0..1, start volume (the slider changes it) |
| `visualizer` | `{}` → defaults | the built-in visual (below); `false` or `null` for none (`center` [0,2.4,0], `radius` 7 (1–100), `bars` 96 (8–256), `hue` 0.75) |
| `react[]` | [] | up to 64 scene nodes that follow a band (`bass` 30–180 Hz, `mid` 180 Hz–2 kHz, `treble` 2–11 kHz, `energy`): `scale` [at silence, at full] on `axis` (`x`/`y`/`z`/`all`), and `glow` extra emissive intensity. Reactive nodes are kept out of static merging |

Only the first track plays; a second one is warned about and ignored.

## What the player does

- The audio code is a lazy chunk (`audio/music.ts`, ~6 KiB gzip) loaded only for worlds with a
  track, so the initial JS is unchanged in size class. It is precached like every other file, so it
  works offline.
- On open: a big **▶ Tap to play** over the world and a music bar (▶/⏸, title, volume). Nothing
  plays before a gesture. The tap creates/resumes the `AudioContext` synchronously inside the
  gesture (the iOS Safari unlock), then decodes the payload. `webkitAudioContext` is used where
  needed.
- Graph: buffer source (loop between the computed loop points) → gain → analyser (FFT 2048) →
  speakers. Pause suspends the context; play resumes it. Hiding the page pauses. **P** toggles.
- Analysis (`audio/analysis.ts`, pure and unit-tested): 96 log-spaced bars 35 Hz–11 kHz, fast-rise /
  slow-fall smoothing, band levels and a beat detector (sharp bass rise or bass 1.25× its running
  average, at most every 0.22 s).
- Visual (`audio/visualizer.ts`): a ring of spectrum bars with a mirrored hanging ring, a core that
  bulges with the spectrum, two halo rings, a floor glow, particle bursts on beats, a slowly
  drifting hue, and the `react[]` nodes. While playing the orbit slowly turns by itself; drag and
  pinch still work. The orbit overview frames the visualizer.

## Format-lane questions

1. Capability name if this becomes normative (`interaction.audio`?), and whether a world may list it
   in `requires[]` to refuse to open silently.
2. An audio size budget. Today the MP3 has to fit the 256 KiB "other entry" budget, which is ~45 s
   at 40 kbps mono. Proposal: an `audio` budget of 1 MiB per entry within the world total.
3. Allowed types: MP3 (`audio/mpeg`) plays everywhere including iOS; Ogg/Opus does not on older
   iOS. Suggest MP3 required, others optional with an MP3 fallback.
4. Whether `react[]` should grow to colours and positions, or stay scale + glow.
5. Credits: the track's licence lives in `manifest.extensions["x-credits"]` like images.

## Known limits

- Only one track; no playlists or positional (3D) audio.
- On iPhone the ring/silent switch mutes Web Audio.
- Reloading the world (e.g. after an edit) stops the music and shows Tap to play again.
- The 🔊 button mutes the game sound effects, not the music (use ⏸ or the slider).
