# models/ packaging note

Short note on how models ship inside a `.wgif` world (Embedded AI lane,
Phase One). The normative descriptor schema is
`packages/format/schema/model-descriptor.v0.1.schema.json` and the spec
proposal is `docs/SPEC-5.5-models-proposal.md`; this note is the packaging
summary for authors and players.

## Where models live

- Model files sit under `models/` in the container and are declared in
  `manifest.models[]`, in load order. The court ships two models for one NPC:
  `models/rebounder.rules.json` (3,446 B, live) and
  `models/rebounder-mlp.onnx` (6,836 B, packaged) — `court.wgif` is 40,652 B
  total. Model files are hashed like any other entry.
- A descriptor carries `id`, `path` (must be under `models/`), `runtime`
  (`rules` | `onnx`), `purpose`, `version`, `inputs` / `outputs`,
  `tickHz` (1–60, default 10), `deterministic`, `seed` (required when
  deterministic), `sizeBytesMax` (defaults: rules 64 KiB, onnx 50 KiB; hard
  ceiling 1 MiB), `license`, and an optional `fallback` (another model id).

## Runtime selection

- **Manifest order is load order.** The court lists rules first, so the
  rules model is the live behaviour and the ONNX model is an optional
  optimization a world can lead with by flipping the two entries.
- **ONNX runs through the hand-rolled JS MLP evaluator** (`@wgif/ai`,
  `src/jsmlp.ts`) — no onnxruntime-web, no WASM, 0 B runtime-WASM budget
  (PR #3). It is an optional optimization for small MLPs, not a general
  ONNX runtime: the player does **not** claim `runtime.onnx` (see
  `docs/CAPABILITIES.md`). The evaluator verifies a supported graph
  signature before it runs anything: the descriptor must promise exactly
  `obs [1, 14] float32 -> action [1, 3] float32`, and the file must contain
  the six trained tensors (`W1/b1/W2/b2/W3/b3`) as float32 with the expected
  shapes (14→32→32→3) — anything else (wrong shapes, wrong dtypes, missing
  weights, truncated bytes) is rejected at load and falls back to the rules
  twin. It cannot run an arbitrary graph, and it never tries to.
- **Fallback is same-purpose ONNX → rules only** (no ONNX → ONNX, no
  chains, no self-fallback). A broken ONNX file falls back to its declared
  rules twin and the player reports it; a broken rules model is a load
  error, because the rules are the fallback.
- **Determinism:** rules models must declare `deterministic: true` plus a
  `seed` (the rebounder uses seed 7). The rules parser is fail-closed
  (unknown conditions, behaviours, targets or non-deterministic
  declarations are rejected at load, never at play time), and the specialized
  JS MLP evaluator validates its supported descriptor signature and
  expected ONNX weight names, shapes and dtypes before inference. It does
  not create a general ONNX runtime session.
- **No executable code:** model files are data. `§5.6` forbids executable
  payloads in containers, and the validator rejects bad descriptors and
  fallbacks with the `models.*` error codes (`duplicate`, `oversize`,
  `seed`, `tensor`, `fallback`).

## What may be skipped — and what may not

Only **optional** model behaviour may be skipped. The rebounder NPC is
optional: a world with no matching model, or whose model fails to load, is
still fully explorable — the NPC simply does not attach, and a mid-game
model failure disables the NPC and reports it rather than breaking the
world. Required capabilities are still enforced: a world whose `requires[]`
names a capability the player does not advertise (for example
`runtime.onnx` for a world with no rules fallback, or `runtime.rules` for a
player without the rules interpreter) is refused interactive playback with a
named diagnostic, and the player offers the preview instead. Malformed
archives are rejected before playback, not during it: the reader validates
the ZIP, the per-file hashes, the manifest schema and the model descriptors
(`models.*` error codes) at unpack time, so a bad archive never reaches the
player loop.

## The per-tick hook

The player drives an NPC through `createNpcHook(world, purpose)` in
`@wgif/ai`. It returns a hook with `runtime`, `usedFallback`, `tickHz`,
`warnings`, `state` and `lastAction`, and one method the player calls every
frame: `tick(dt, observation)`. The hook steps the model at its descriptor
tickHz (at most 3 steps per call, so a long frame cannot spiral into
catch-up steps) and returns a `TickResult`: the current `action`, whether a
step was committed (`stepped`), and the step sequence number (`step`).
Movement velocity is persistent — the player integrates the last action's
velocity every frame — but gameplay events are one-shot: a `passBall` is
fresh only on a tick where `stepped` is true, so a stale action is never
re-applied as a new event. The hook owns the model and the schedule; the
player owns positions, physics and the scene. A model step that is still
pending when the hook is reset or disposed resolves into nothing (its
result is discarded), so a detached or reset NPC can never be moved by a
stale step; a rejected step propagates to the player, which disables the
NPC and reports it.
