# Mobile performance (court world)

Owner: Dee (OPTIMIZATION). This document is the *method* plus the fix list.
The measurement table is filled per release on real hardware.

## Court-world render budget (390×844, 60 fps)

Phase One target: **390 × 844** logical pixels, iPhone 12/13/14 class,
60 fps sustained. Machine-readable in `scripts/size-budgets.json` under
`renderBudget`, enforced by `scripts/render-report.ts` (folded into
`npm run size:report`).

| Metric | Budget | Enforcement |
|---|---:|---|
| Draw calls | **150** | static — GLB primitive count |
| Triangles | **150,000** | static — GLB accessor count |
| Texture memory (GPU upload, with mipmaps) | **32 MiB** | static — GLB image dimensions × 4 B/px × 4/3 |
| Frame time | **16.7 ms** | **manual only** — needs a real GPU |

The first three are conservative upper bounds from the GLB alone: the
analyzer assumes no batching and no instancing, so the real number after
`mergeGeometries()` is lower. Texture memory is the *uploaded* size
(RGBA8 + mipmaps, i.e. `w*h*4*4/3`), not the on-disk PNG size — a
512×512 PNG that compresses to 40 KiB is 1.3 MiB on the GPU, and that
gap is where mobile frame budgets die.

Frame time cannot be verified statically. The 16.7 ms target is
documented so the other three numbers have something to be conservative
*relative to*; measure it on a real 390×844 phone each release and fill
the table below.

## Why not CI

CI has no GPU and headless WebGL lies about both frame time and draw-call
overhead. Draw calls and triangle counts *are* deterministic and can be
asserted in a unit test (see below); frame time cannot.

## What to capture

Add `?perf=1` to the player URL to enable a small overlay that samples
`renderer.info.render.calls`, `.triangles`, and a 120-frame ring buffer of
`performance.now()` deltas. Report p50/p95, not the mean — the mean hides
the jank that users actually feel.

| Device class | Device | Draw calls | Triangles | p50 frame | p95 frame | Cold open |
|---|---|---:|---:|---:|---:|---:|
| C1 | `<fill>` | | | | | |
| C2 | `<fill>` | | | | | |
| C3 | `<fill>` | | | | | |

## Fixes, in order of payoff

1. **Merge static geometry by material.** The procedural court is built from
   many small meshes; each is a draw call. `mergeGeometries()` over everything
   that never moves (floor, lines, backboard, stanchion, hoops) collapses the
   scene to ~3–5 draw calls. Expect the single biggest win. Caveat: merged
   meshes lose per-object frustum culling — irrelevant for one court, not
   irrelevant for a stadium.
2. **InstancedMesh for repeats.** Court markings, hoop hardware, any repeated
   prop. One draw call per (geometry, material) pair.
3. **Cap device pixel ratio.** `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`,
   or 1.5 on C1. A 3× phone renders 9× the pixels; this is usually the
   difference between 30 and 60 fps and costs nothing to implement.
4. **Static shadow map.** One directional light, 1024², `shadowMap.autoUpdate = false`,
   `needsUpdate = true` once after load. Shadow rendering every frame for a
   scene that doesn't move is pure waste.
5. **Disable antialiasing on C1.** MSAA on a tiled mobile GPU is expensive;
   `antialias: devicePixelRatio < 2`.
6. **Material count.** Each unique material is a state change. Merge lines
   into one material, share the floor material.
7. **No per-frame allocation.** Reuse `Vector3`/`Quaternion` temporaries;
   GC pauses show up as p95 spikes, which is exactly what the table measures.
8. **Orbit damping off on C1.** Small, but it forces a render every frame
   while the scene is otherwise idle.

## Regression guard that *can* live in CI

Draw calls and triangles are properties of the scene graph, not the GPU.
The static GLB analyzer (`scripts/render-report.ts`) now checks these
against `renderBudget` in `npm run size:report`, so a change that pushes
the court over 150 draw calls or 150k triangles fails CI. This is a
*static* check — it catches regressions from someone adding 40 meshes, not
regressions from someone changing the material pipeline. The player's
runtime `renderer.info.render.calls` can still differ from the static count
after batching/instancing; that's why the analyzer is conservative.