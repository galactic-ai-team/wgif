# 🌌 WGIF — World Generative Interactive Format

**Can an interactive, intelligent 3D world be as portable and shareable as a GIF?**

WGIF is an open, versioned, single-file format (`.wgif`) for explorable 3D worlds. A world packs its
geometry, preview, interaction rules, game state and optional tiny on-device AI models. You don't just
watch it: you open it, look around 360°, walk in, play, and (when the creator allows) remix it, all offline.

A Galactic AI Team project. Coordinator: Lumi · Team: GPT-6 (Ace), Claude, Gemini, Nova, Dee.

> **Status:** Phase One (Minimum Viable WGIF) is in progress. See [docs/PHASE1.md](docs/PHASE1.md).
> The spec is a draft: [docs/SPEC-v0.1-draft.md](docs/SPEC-v0.1-draft.md).

## What's here

```
apps/player/        WGIF Player — Vite + TypeScript + Three.js. Open a .wgif, orbit or walk around it.
packages/format/    @wgif/format — ZIP container, manifest types, JSON Schema, validator,
                    pack/unpack, ed25519 signing, edit export.
examples/court/     Handcrafted, procedurally built basketball court → court.wgif (~30 KB).
docs/               Spec draft and the Phase One checklist.
```

## Quick start

```bash
npm ci
npm run pack:court      # builds examples/court/court.wgif and copies it into the player
npm run dev             # opens the player at http://localhost:5173
```

In the player, click **Load sample court**, use **Open .wgif**, or drag a `.wgif` onto the page.
**Mode** switches between orbit (drag, scroll, right-drag) and first-person walk (click to look, WASD to move,
Shift to run, Esc to release).

Everything else:

```bash
npm run lint        # ESLint
npm run typecheck   # tsc in every workspace
npm test            # Vitest: format, example world, headless player pipeline
npm run build       # library, sample world, player bundle (apps/player/dist)
```

## Inside a `.wgif`

A `.wgif` is a ZIP archive whose first entry is an uncompressed `manifest.json`:

```
manifest.json  preview.png  world.glb  interactions.json  game-state.json  models/  assets/  layers/
```

The manifest lists every file with its SHA-256 and declares a mode: `locked`, `editable` or `layered`.
Creators can sign the manifest with ed25519. Locking is enforced by compliant players and made
tamper-evident by the signature. It is not DRM. Details are in the [spec](docs/SPEC-v0.1-draft.md).

```ts
import { packWgif, unpackWgif } from '@wgif/format';
const bytes = await packWgif(manifest, { 'world.glb': glb, 'preview.png': png });
const world = await unpackWgif(bytes);   // world.report.ok, .errors, .warnings, .signature
```

## Contributing

Branch per lane, draft PRs, and nobody merges without Stephon's yes. Free tools only, no deploys,
no secrets. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Code: MIT ([LICENSE](LICENSE)). The example court world is CC-BY-4.0, © Galactic AI Team.
