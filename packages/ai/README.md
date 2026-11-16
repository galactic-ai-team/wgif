# @wgif/ai — Embedded AI for WGIF worlds

Small offline intelligence inside worlds. Phase One ships one NPC — the court
rebounder — two ways: a declarative rules model (the live behaviour) and a tiny
ONNX clone of it (distilled from the rules policy, with the rules model as its
fallback). Everything runs on-device; nothing here makes a network call.

## What lives here

```
packages/ai/
  src/
    types.ts    Observation / action / model interfaces
    rules.ts    Rules-model parser (fail-closed) + deterministic RulesNpc
    features.ts Feature contract (obs [1, 14] / action [1, 3]) + descriptor-signature check
    jsmlp.ts    JsMlpNpc: hand-rolled JS MLP evaluator (the player runtime for onnx)
    onnx.ts     OnnxNpc: ONNX Runtime Web — Node-side verification only, not exported
    loader.ts   loadModelFromWorld(): best model for a purpose, with fallback
  scripts/
    train_rebounder_mlp.py   Trains + exports + verifies rebounder-mlp.onnx
  test/
    ai.test.ts
    fixtures/   Bad-shape / bad-dtype / truncated .onnx files for the fail-closed tests
```

## The rebounder

A loose ball is chased, picked up, carried to the player and passed back.
States (`examples/court/models/rebounder.rules.json`):

```
idle → chase → pickup → carry → pass → idle
```

The runtime is a pure function: `update(observation, dt) -> action`. It owns no
positions and no physics — the caller integrates `action.velocity` and moves
the ball when `holdingBall` / `passBall` say so. The same observation sequence
always produces the same action sequence (seed 7, no randomness, no wall clock).

### Missed shot

The rebounder's job is the missed shot: the ball leaves the player's hands,
misses, and lands loose on the floor — the NPC walks to it, picks it up,
carries it back and passes it to the player, then walks home and waits for
the next one. That whole loop (opening loose ball, a miss near the rim, a
long miss into the far corner, exactly one fresh pass per loop, no re-fire
while the player holds the ball) is covered end to end through the hook in
`packages/ai/test/hook.test.ts` ("missed shot → fetch → pass"). The loop
needs the ball to become loose — today that happens at spawn, and it will
happen on every missed shot once the shooting minigame (Claude's lane,
PHASE1 item 5) runs; the NPC is ready for it, and a ball that rolls out of
bounds is left alone (the NPC cannot leave the court to fetch it).

### Rules model (live in Phase One)

`models/rebounder.rules.json` is the source of truth: a declarative state
machine — states, transitions evaluated in file order (first match wins),
`move` / `hold` / `pass` behaviours. The parser rejects unknown conditions,
unknown behaviours, dangling transitions, unresolvable speeds and
non-deterministic declarations at load time, never at play time.

### ONNX model (distilled clone)

`models/rebounder-mlp.onnx` (6,836 bytes, 14 → 32 → 32 → 3) is trained on
synthetic states sampled from the rules policy — see
`scripts/train_rebounder_mlp.py`. Held-out vs the rules policy: velocity
direction cosine 0.997, speed MAE 0.12 m/s, pass accuracy 0.998. The graph is
stateless: the held flags in the observation carry the state, and the training
target is one rules tick from the canonical state for the observation (see
`canonical_state` in the script), so the clone agrees with the rules model
within one tick everywhere.

Feature order (`obs`, `[1, 14]`, float32) is a contract shared by the script,
`src/features.ts` (`ONNX_OBS_FEATURES`), both evaluators and the manifest
descriptor — change it in all four places, never one. The runtime also applies
a 0.4 m/s speed dead-zone (`ONNX_DEAD_ZONE_MS`): the network's output noise
floor is ~0.1–0.4 m/s, so below that the NPC is stationary — the same idea as
the rules model's arrive radius. The slowest real command is the 1.5 m/s
return-home walk, so the dead-zone never kills a genuine movement.

ONNX models run through the hand-rolled JS MLP evaluator (`src/jsmlp.ts`,
Option A): it reads the six trained tensors straight out of the `.onnx` file
and runs the forward pass in plain JavaScript — no onnxruntime-web, no WASM,
no COOP/COEP question. The runtime-WASM budget is 0 B (PR #3), so the player
bundle ships zero WASM: verified Nov 16, the built player contains no `.wasm`
asset and no onnxruntime reference, and the ONNX rebounder loads and runs in a
real browser (Playwright Chromium 159, plain and with COOP/COEP) with no WASM
fetch and no console errors. The evaluator is fail-closed: wrong weight
shapes, missing weights, non-float32 weights and a descriptor that does not
promise the `obs [1, 14] float32 -> action [1, 3] float32` signature all
throw at load, and the loader falls back to the rules model. ONNX Runtime Web
(`src/onnx.ts`) stays as the independent Node-side cross-check — the two
evaluators must agree on every observation — and is not exported from the
package, so the player bundle can never pull it in. See
`docs/notes/onnx-wasm-coop-coep.md` for the earlier threaded-WASM check that
motivated Option A (threaded build, single-threaded at `numThreads = 1`).

To retrain (needs Python + the `onnx` / `onnxruntime` / `numpy` packages):

```bash
python3 packages/ai/scripts/train_rebounder_mlp.py
```

The script refuses to write a model that fails its gates (cosine, speed error,
pass accuracy, ORT-vs-NumPy agreement, determinism, 50 KiB cap). Regenerate
only when the rules file changes, and commit the result — `court.wgif` embeds it.

### Loading and fallback

```ts
import { loadModelFromWorld } from '@wgif/ai';
const { model, runtime, usedFallback, tickHz, warnings } = await loadModelFromWorld(world, 'rebounder');
// runtime is 'onnx' when the runtime loads, otherwise 'rules' (the fallback).
// tickHz is the descriptor's tick rate (10 for the rebounder).
const action = await model.update(observation, dt);
```

`onnxruntime-web` is a devDependency of this package for the Node-side
verification tests only, and is never imported by the player path. A broken
ONNX file falls back to its declared `fallback` model; a broken rules model is
a load error, because the rules are the fallback.

## Player hook

`WorldViewer.onTick?: (dt: number) => void` is called every animation frame.
The rebounder NPC is driven through the @wgif/ai per-tick hook —
`createNpcHook(world, purpose)` returns `tick(dt, observation)`, which steps
the model at its descriptor tickHz (at most 3 steps per call) and returns a
`TickResult`: the current action, whether a step was committed (`stepped`),
and the step sequence number (`step`). Velocity is persistent (the player
integrates the last action's velocity every frame); gameplay events are
one-shot and are applied only when `stepped` is true. A rejected step
propagates — the player disables the NPC and reports it — and a step that
resolves after reset/dispose is discarded. See
`docs/notes/models-packaging.md` for the packaging summary.
The player wires it in `apps/player/src/ai.ts`: step the model at its
`tickHz` (10 Hz), integrate the velocity between ticks, move the rebounder
marker and the ball node. This hook is deliberately tiny — Claude owns the
viewer and may replace it with the real physics/minigame tick; the contract
the AI side needs is just "call us with dt, we return an action".
