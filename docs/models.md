# `models/`: packaged inference data

The packaging convention for embedded AI models in a `.wgif` world. Normative
source is SPEC §6 (`docs/spec/wgif-v0.1.md`); the design rationale lives in
`docs/notes/models-packaging.md`, and the runtime that loads these models is
documented in `packages/ai/README.md`.

## Layout

Models are **data**, not software shipped by the archive (SPEC §5.6): no
executable payloads, no scripts, no imported operators, no externally fetched
runtime code. Every model file lives under `models/` at the archive root and
is declared twice: once in `manifest.models[]` (the descriptor below) and once
in `manifest.files[]` (path, size, sha256 — verified by the container checks).

```
models/rebounder.rules.json   # declarative state machine (the behaviour)
models/rebounder-mlp.onnx     # tiny ONNX clone of the same behaviour
```

Name files `<purpose>.<runtime>.<ext>`: rules files end in `.json`, ONNX files
in `.onnx`. A `models/` path MUST be safe (no `..`, no backslashes, no control
characters) and MUST NOT be shared by two models.

## The descriptor (`manifest.models[]`)

At most 64 descriptors, each with a unique `id` matching
`^[a-z][a-z0-9_-]{0,63}$`. The court ships two models for one NPC — the rules
model is the behaviour, the ONNX model is the packaged alternative:

```json
{ "id": "rebounder-rules", "path": "models/rebounder.rules.json",
  "runtime": "rules", "purpose": "rebounder", "version": "0.1.0",
  "inputs": [ { "name": "ball_position" }, "..." ],
  "outputs": [ { "name": "velocity" }, "..." ],
  "tickHz": 10, "deterministic": true, "seed": 7,
  "license": "CC-BY-4.0", "sizeBytesMax": 65536 }
{ "id": "rebounder-mlp", "path": "models/rebounder-mlp.onnx",
  "runtime": "onnx", "purpose": "rebounder", "version": "0.1.0",
  "inputs": [ { "name": "obs", "shape": [1, 14], "dtype": "float32" } ],
  "outputs": [ { "name": "action", "shape": [1, 3], "dtype": "float32" } ],
  "tickHz": 10, "deterministic": true, "seed": 7,
  "license": "CC-BY-4.0", "fallback": "rebounder-rules", "sizeBytesMax": 51200 }
```

| Field | Rule |
| --- | --- |
| `id`, `path`, `runtime` | Required. `runtime` is `rules` or `onnx`. |
| `purpose` | Optional, but give every model one: the loader finds models by purpose, and a fallback MUST share its target's purpose. |
| `version` | Semver-like `x.y.z` (pre-release suffix allowed). |
| `inputs` / `outputs` | Named fields for rules (a field MUST NOT carry `shape`/`dtype`); tensors for ONNX — nonempty, each with `shape` and `dtype` (`float32`, `int32`, `int64`, `bool`). Shapes start with batch dimension 1, use at most four positive dimensions, at most 65,536 elements total. Field names are unique per side; `range: [lo, hi]` MUST have `lo <= hi`. Rules descriptors MAY omit both. |
| `tickHz` | 1–60, default 10 when absent. A maximum update rate, not a real-time guarantee. |
| `deterministic`, `seed` | Rules models MUST declare `deterministic: true` and a uint32 `seed`. Any deterministic model requires a seed. |
| `sizeBytesMax` | See caps below. |
| `license` | Free-text, e.g. `CC-BY-4.0`. |
| `fallback` | Only an ONNX descriptor MAY declare one. See below. |

## Size caps

| Runtime | Default cap (`sizeBytesMax` absent) | Absolute ceiling |
| --- | --- | --- |
| `rules` | 65,536 bytes (64 KiB) | 1,048,576 bytes (1 MiB) |
| `onnx` | 51,200 bytes (50 KiB) | 1,048,576 bytes (1 MiB) |

A provided `sizeBytesMax` MAY raise the default but MUST NOT exceed 1 MiB,
and the actual file MUST fit its effective cap. The validator rejects an
oversize file (`models.oversize`) and a `sizeBytesMax` above 1 MiB (schema).

## Load order and fallback

- **Manifest order is load order.** The loader tries descriptors in order for
  the requested `purpose` and runs the first one that loads. The court lists
  rules first: the rules model is the live behaviour and the source of truth.
- **Fallback:** only ONNX → rules, same `purpose`, no self-fallback, no
  missing target, no ONNX → ONNX, no chains. A broken ONNX model falls back
  to its rules twin at load; a broken rules model is a hard error.
- **Rules files** MUST be valid UTF-8 JSON. The state machine inside is
  validated by the loader (`@wgif/ai` `parseRulesModel`, fail-closed), not by
  the format validator.

## Rules-only fallback when there is no ONNX runtime

A world whose ONNX models all have a usable rules fallback does not need a
general ONNX runtime, and MUST NOT claim to:

- If rules behaviour is required for complete playback, `requires[]` MUST
  contain `runtime.rules`. The court does: the rebounder NPC is required, so
  `requires: ["scene.glb", "runtime.rules"]`.
- If every ONNX model has a usable same-purpose rules fallback, `requires[]`
  SHOULD NOT contain `runtime.onnx`. The court does not require it.
- The proof player has **no** general ONNX runtime and claims no
  `runtime.onnx` capability: ONNX models run through the hand-rolled JS MLP
  evaluator (`packages/ai/src/jsmlp.ts`, no WASM), and `onnxruntime-web` is a
  Node-only devDependency for tests. A world that essentially needs a general
  ONNX runtime without a usable fallback is the only case that MUST require
  `runtime.onnx`.

## What the validator checks, and what the runtime checks

`validateWorld()` (format lane, owned by GPT-6) checks the descriptor and the
packaging: schema shape, duplicate ids/paths, safe `models/` paths, `.json` /
`.onnx` extensions, file presence / hash / size, oversize vs the effective
cap, rules-is-JSON, `deterministic` + `seed`, tensor presence / shapes /
dtypes / ranges, and every fallback rule. The loader (`@wgif/ai`) checks the
file *content* at load, fail-closed: the rules state machine, and the ONNX
graph signature (descriptor `obs [1,14] float32 → action [1,3] float32` plus
the six float32 weight tensors) before the JS MLP runs it.

## Validator checks for GPT-6

Audited against SPEC §6 for this doc: everything above is already enforced
by the descriptor schema or `validateWorld()` — except one case, implemented
in this patch as a **warning** (a SHOULD NOT, not a MUST NOT):

- `requires.onnx-unneeded`: `requires[]` contains `runtime.onnx` while every
  ONNX model in `models[]` has a usable same-purpose rules fallback. A world
  with a usable rules fallback SHOULD NOT require `runtime.onnx`.
