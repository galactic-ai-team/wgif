# Size & speed budgets (Phase One)

A WGIF world should feel as light as a GIF. That only stays true if it is
enforced, so the numbers below are machine-readable in
`scripts/size-budgets.json` and checked by `npm run size:report` on every CI run.
Change a budget in one place: the JSON.

## Device classes

| Class | Representative hardware | Target |
|---|---|---|
| **C1 — low-end mobile** | 2019–2021 Android, 4 GB RAM, Mali-G52 / Adreno 610, 720–1080p, Chrome | 30 fps sustained, cold open ≤ 2.0 s |
| **C2 — mainstream mobile / thin laptop** | Adreno 640+, Apple A12+, Intel Iris Xe | 60 fps, cold open ≤ 1.2 s |
| **C3 — desktop** | discrete GPU or Apple M-series | 60 fps, cold open ≤ 0.6 s |

"Cold open" = file picked → first interactive frame, local file, no network.

## Byte budgets

| Budget | Limit | Today | Headroom |
|---|---:|---:|---:|
| `.wgif` total | **1 MiB** | ~30 KB | 34× |
| `preview.png` | 256 KiB | — | — |
| `world.glb` | 768 KiB | — | — |
| `manifest.json` | 16 KiB | — | — |
| `interactions.json`, `game-state.json` | 32 KiB each | — | — |
| any other entry | 256 KiB | — | — |
| entries per world | 256 | — | — |
| **player JS, total gzip** | **300 KiB** | ~207 KiB | 1.45× |
| any single JS chunk gzip | 256 KiB | — | — |
| player dist total gzip (excl. `.map`) | 1.5 MiB | — | — |

Unknown entry names fall back to the 256 KiB default, so a new asset type
cannot sneak in unbounded.

## Time budgets (measured manually, see `docs/PERF.md`)

| Metric | C1 | C2 | C3 |
|---|---:|---:|---:|
| cold open → first frame | ≤ 2000 ms | ≤ 1200 ms | ≤ 600 ms |
| steady-state p95 frame time | ≤ 33 ms | ≤ 16.7 ms | ≤ 16.7 ms |
| draw calls | ≤ 150 | ≤ 300 | ≤ 500 |
| triangles | ≤ 100 k | ≤ 300 k | ≤ 1 M |

These are not in CI — CI has no GPU, and a synthetic number from a headless
renderer would be a lie. They are recorded per release in `docs/PERF.md`.

## Why 1 MiB and 300 KiB

- 1 MiB expanded is ~10–30 ms of GLB parse plus ~4–10 ms of SHA-256 on C1.
  At 4 MiB those numbers start to be visible as a stall on open.
- 300 KiB gzip of JS is roughly 1 s of parse+compile on a C1 device. Three.js
  alone is ~150 KiB gzip, so the app + format layer gets ~150 KiB. That is
  enough for a hand-written player and *not* enough for a JSON-Schema
  compiler, a physics engine and an ML runtime in the same chunk. Those must
  be lazy chunks or absent.

## Known gaps in this budget (follow-ups)

1. **Preview decode size is not budgeted.** A 256 KiB PNG can decode to
   64 MiB of RGBA (4096²). Add a check on the PNG IHDR: ≤ 1024×1024.
2. **Compressed-in-container vs shipped bytes.** `.wgif` entries are already
   deflated, so brotli over the whole file saves little. The report prints
   both numbers so nobody optimizes the wrong one.
3. **No memory budget.** `performance.measureUserAgentSpecificMemory` is
   Chromium-only and cross-origin-isolated-only. Track manually for now.

## Running it

```bash
npm run build
npm run size:report                          # human table
npm run size:report -- --summary /tmp/s.md   # also write markdown
npm run size:report -- --json                # machine-readable