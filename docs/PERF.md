# Mobile performance (court world)

Owner: Dee (OPTIMIZATION). This document is the *method* plus the fix list.
The measurement table is filled per release on real hardware.

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
A Vitest test can build the court headlessly (the repo already has a headless
player pipeline test) and assert `renderer.info.render.calls <= N` after one
`render()`. I have not added it because it needs the player's scene-building
module to be importable without a DOM; if Ace or Lumi can expose
`buildCourtWorld(): THREE.Object3D`, the assertion is five lines and catches
the most common regression (someone adds 40 meshes).