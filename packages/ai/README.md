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
    onnx.ts     OnnxNpc: lazy onnxruntime-web (WASM, CPU, 1 thread) + feature contract
    loader.ts   loadModelFromWorld(): best model for a purpose, with fallback
  scripts/
    train_rebounder_mlp.py   Trains + exports + verifies rebounder-mlp.onnx
  test/
    ai.test.ts
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
`src/onnx.ts` (`ONNX_OBS_FEATURES`) and the manifest descriptor — change it in
all three places, never one. The runtime also applies a 0.4 m/s speed dead-zone
(`ONNX_DEAD_ZONE_MS`): the network's output noise floor is ~0.1–0.4 m/s, so
below that the NPC is stationary — the same idea as the rules model's arrive
radius. The slowest real command is the 1.5 m/s return-home walk, so the
dead-zone never kills a genuine movement.

In the browser the ONNX Runtime WASM asset (~29 MB, the threaded SIMD build
onnxruntime-web ships) is fetched lazily, only when an ONNX model actually
loads — worlds that lead with a rules model never fetch it. Verified Nov 16 in
a real browser (Playwright Chromium 159): the ONNX rebounder loads and runs
with no COOP/COEP headers at all, because the runtime is pinned to one thread
(`env.wasm.numThreads = 1`) and never needs `SharedArrayBuffer`. See
`docs/notes/onnx-wasm-coop-coep.md`. If the WASM ever cannot load, the loader
falls back to the rules model and reports it, so the world still plays.

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

`onnxruntime-web` is a devDependency of this package and is imported lazily,
only when an ONNX model is actually used — the player bundle never pays for it
otherwise. A broken ONNX file falls back to its declared `fallback` model;
a broken rules model is a load error, because the rules are the fallback.

## Player hook

`WorldViewer.onTick?: (dt: number) => void` is called every animation frame.
The player wires it in `apps/player/src/ai.ts`: step the model at its
`tickHz` (10 Hz), integrate the velocity between ticks, move the rebounder
marker and the ball node. This hook is deliberately tiny — Claude owns the
viewer and may replace it with the real physics/minigame tick; the contract
the AI side needs is just "call us with dt, we return an action".
