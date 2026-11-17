# `examples/worlds` — more sample worlds for testing

Five extra `.wgif` worlds, each built by a committed, deterministic generator (`npm run build`
rebuilds them byte for byte, and CI checks the committed files match). They are copied into the
player as `samples/<name>.wgif`, so a link like `…/?src=samples/rooftop.wgif` opens one directly.

| File | World | What it tests |
| --- | --- | --- |
| `gallery.wgif` | **Open-Air Gallery** — a roofless room under the night sky hung with six public-domain paintings (Hokusai, van Gogh, Vermeer, Monet, Botticelli, Klimt) and a glass orb to pick up | Picture-based world: six JPEG textures embedded in the GLB, `locked` mode (no export), wall colliders for walking, one grabbable |
| `rooftop.wgif` | **Rooftop Night Court** — a half court on a city rooftop at dusk under a real 360° photo, with string lights, neon trim and a 45-second one-hoop Shootout | Equirectangular panorama sky (`extras.wgif.role: "sky"`), emissive props, the built-in `basketball-shooting` minigame on a different court, `editable` mode, `game-state.json` |
| `car.wgif` | **Neon Lot** — a red coupe on a showroom turntable in a night-time car lot, with a cone slalom, a tabletop jump, jersey barriers and a painted ring track. Orbit the car, or press **🚗 Drive** (F / Enter) and drive it round | The player's vehicle component: an `interactions[]` entry of `"type": "vehicle"` (body node + four wheel nodes), arcade physics against the static colliders and bounds, chase camera, desktop keys and a touch pad, orbit centred on the car. `editable`. Fully procedural, no textures (~120 KB) |
| `music.wgif` | **Neon Pulse** — an audio-reactive stage: an original 46-second 124 BPM loop packed in the file drives a crown of 96 spectrum bars (and its mirror), a pulsing core, halo rings, beat particle bursts and glowing light towers. Tap to play, then orbit and zoom while the camera slowly turns | The player's audio component: an `interactions[]` entry of `"type": "audio"` (an MP3 under `assets/`, Web Audio analyser, built-in visualizer, `react[]` bindings on scene nodes), iOS gesture unlock, lazy-loaded code. `editable`. MP3 40 kbps mono (~227 KiB), no textures (~300 KB) |
| `city.wgif` | **Neon Grid City (stress)** — 16×16 blocks with 240 glowing towers (263 nodes), 12 orbs to throw through four neon rings, three overlay layers (160 added primitives + a move/remove) on a signed base | Many nodes and colliders (scene ~97 % of the 768 KiB Phase One scene budget), `layered` mode, Ed25519 signature that stays valid under layers, layered export |

`npx tsx examples/worlds/src/cli.ts --xl <dir>` also writes **`city-xl.wgif`** (34×34 blocks,
1536² texture, ~2.7 MB): a device stress build that is deliberately **over** the 1 MiB Phase One
world budget (still far inside the SPEC §2 safety ceilings). It is never committed, so CI's size
gate does not see it; use it to test opening and exporting big files on phones.

## Image sources and licences

All third-party images are free to reuse and are credited inside each world
(`manifest.extensions["x-credits"]`, and on the textured node as `extras.wgif.credit`):

- Paintings: Wikimedia Commons, **public domain** (licence string checked through the Commons API
  by `scripts/prepare-assets.py`): see `assets/CREDITS.md` for the six file pages.
- Rooftop sky: **"Rooftop Night"** by Greg Zaal, [Poly Haven](https://polyhaven.com/a/rooftop_night), **CC0**
  (the tonemapped JPG, downsized to 2048×1024).
- City window texture, the car and the car lot, all geometry: procedural (this generator).
- Music: **"Neon Pulse"**, an original track synthesized by `scripts/synth-track.py` (numpy, no samples), **CC0 1.0**.

The worlds themselves are CC-BY-4.0 like the court.

## The city's signature is a test signature

`city.wgif` is signed with a key derived from the **public** string `CITY_TEST_KEY_SEED` in
`src/city.ts`, so anyone can re-create the signature. A valid signature on it proves only that
the signed bytes did not change, never who made them.

## Rebuilding

```bash
npm run build --workspace @wgif/example-worlds        # worlds -> examples/worlds/*.wgif + apps/player/public/samples/
python3 examples/worlds/scripts/prepare-assets.py     # only to re-fetch the images (network + Pillow)
NODE_PATH=<playwright-core> node examples/worlds/scripts/capture-previews.mjs http://localhost:4173/   # new preview renders
NODE_PATH=<playwright-core> node apps/player/e2e/sample-worlds.e2e.mjs http://localhost:4173/ --shots shots   # browser check
```

Preview images are real renders of each world from the player (spawn view, 480×288 palette PNG;
the car world's is its orbit view of the car, the music world's its orbit view while playing).

## Driving the car (`car.wgif`)

| | Desktop | Phone |
| --- | --- | --- |
| Get in / out | **F** or **Enter**, or the 🚗 Drive / ■ Exit car button | 🚗 Drive / ■ Exit car button |
| Gas | W or ↑ | hold **Gas** |
| Brake, then reverse | S or ↓ (Space brakes) | hold **Brake** |
| Steer | A / D or ← / → | ◀ ▶ |
| Car back on the turntable | R | Load the world again |

Orbit (drag / pinch) always circles the car; getting out stops it and orbits it where it stopped.
The vehicle definition is a proposal for the format lane: see `docs/notes/vehicle-component.md`.
`NODE_PATH=<playwright-core> node apps/player/e2e/car.e2e.mjs http://localhost:4173/ --shots shots`
checks it in a real browser at desktop and 390×844 touch.

## Playing the music (`music.wgif`)

| | Desktop | Phone |
| --- | --- | --- |
| Start | click **▶ Tap to play** | tap **▶ Tap to play** |
| Play / pause | ▶ / ⏸ on the music bar, or **P** | ▶ / ⏸ on the music bar |
| Volume | the slider on the music bar | the slider |
| Look around | drag to orbit, scroll to zoom, right-drag to pan | drag, pinch |

The track is encoded from `scripts/synth-track.py` (`python3 examples/worlds/scripts/synth-track.py`,
needs numpy and ffmpeg with libmp3lame); the MP3 is committed and the world generator only packs it.
The audio entry is a proposal for the format lane: see `docs/notes/audio-component.md`.
`NODE_PATH=<playwright-core> node apps/player/e2e/music.e2e.mjs http://localhost:4173/ --shots shots`
checks it in a real browser at desktop and 390×844 touch (it reads the analyser; it cannot listen).
