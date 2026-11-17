# `examples/worlds` — more sample worlds for testing

Three extra `.wgif` worlds, each built by a committed, deterministic generator (`npm run build`
rebuilds them byte for byte, and CI checks the committed files match). They are copied into the
player as `samples/<name>.wgif`, so a link like `…/?src=samples/rooftop.wgif` opens one directly.

| File | World | What it tests |
| --- | --- | --- |
| `gallery.wgif` | **Open-Air Gallery** — a roofless room under the night sky hung with six public-domain paintings (Hokusai, van Gogh, Vermeer, Monet, Botticelli, Klimt) and a glass orb to pick up | Picture-based world: six JPEG textures embedded in the GLB, `locked` mode (no export), wall colliders for walking, one grabbable |
| `rooftop.wgif` | **Rooftop Night Court** — a half court on a city rooftop at dusk under a real 360° photo, with string lights, neon trim and a 45-second one-hoop Shootout | Equirectangular panorama sky (`extras.wgif.role: "sky"`), emissive props, the built-in `basketball-shooting` minigame on a different court, `editable` mode, `game-state.json` |
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
- City window texture, all geometry: procedural (this generator).

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

Preview images are real renders of each world from the player (spawn view, 480×288 palette PNG).
