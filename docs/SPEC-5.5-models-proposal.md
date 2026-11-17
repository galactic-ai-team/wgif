# SPEC §5.5 proposal — embedded AI models (Embedded AI lane, Nova)

**For GPT-6 (format lane) to merge into `docs/SPEC-v0.1-draft.md`.**
Status: draft, for Stephon's review. The reference implementation is live on
branch `feat/embedded-ai`: `packages/format/schema/model-descriptor.v0.1.schema.json`,
the manifest schema sync, the validator rules in `packages/format/src/validate.ts`,
and the court example shipping both models. Packaging summary:
`docs/notes/models-packaging.md`.

## Proposed replacement text for §5.5

> ### 5.5 Models: `models/`
>
> Each embedded model is a file under `models/` with a descriptor in
> `manifest.models[]`. A model is **data**, not code: a player runs it only
> through its own built-in runtimes (a rules interpreter, the JS MLP evaluator),
> never by executing anything from the container (§5.6). Inference MUST be
> on-device; a model MUST NOT fetch network resources.
>
> A descriptor has:
>
> | Field | Meaning |
> |---|---|
> | `id` | Unique within the world. `^[a-z][a-z0-9_-]{0,63}$`. |
> | `path` | MUST be under `models/`. |
> | `runtime` | `"rules"` or `"onnx"`. |
> | `purpose` | What the model is for, e.g. `"rebounder"`. Models with the same purpose are tried in manifest order. |
> | `version` | Semver-ish string, e.g. `"0.1.0"`. |
> | `inputs`, `outputs` | Named fields. For `rules`, `{ name, description? }` — the observation and action fields the interpreter passes. For `onnx`, `{ name, shape, dtype, description?, range? }` — tensor name, shape (e.g. `[1, 14]`), dtype (`float32`, `int64`, …), value range `[min, max]` where known. |
> | `tickHz` | Model steps per second, 1–60 (default 10). The player MUST NOT step a model faster than its `tickHz`. |
> | `deterministic` | Whether the same observation sequence always produces the same action sequence. |
> | `seed` | REQUIRED when `deterministic` is true. A `uint32` the model is seeded with. |
> | `sizeBytesMax` | Cap on the model file's size in bytes. Defaults: rules 65,536 (64 KiB), onnx 51,200 (50 KiB). Hard ceiling 1,048,576 (1 MiB) — a world MUST NOT ship a model larger than this in v0.1. |
> | `license` | License of the model file, e.g. `"CC-BY-4.0"`. |
> | `fallback` | The `id` of another model in the same world to run when this one cannot load. MUST NOT point to itself and MUST NOT form a chain (a fallback MUST NOT itself declare a `fallback`). A fallback is normally the `rules` twin of an `onnx` model. |
>
> **Rules models** are declarative JSON behaviour tables (a state machine: states,
> transitions in file order with first-match-wins, `move` / `hold` / `pass`
> behaviours). A player MUST reject a rules file with unknown conditions,
> behaviours, targets or non-deterministic declarations at load time, never at
> play time. Rules are the fallback, so they must be trustworthy.
>
> **ONNX models** run through an equivalent local runtime — in Phase One,
> the hand-rolled JS MLP evaluator in `@wgif/ai` (`src/jsmlp.ts`), which reads
> the weights out of the `.onnx` file and runs the forward pass in plain
> JavaScript. The runtime-WASM budget is 0 B (PR #3), so ONNX Runtime Web
> (WASM, CPU) is Node-side verification only and MUST NOT ship in the player.
> The player MUST verify the model matches the descriptor's declared
> signature (input/output names, shapes, dtypes) before running it. If an
> ONNX model cannot load (bad file, weight/shape mismatch), the player MUST
> run its declared `fallback` if one exists, and MUST report which runtime is
> actually in use.
>
> **Which capabilities go in `requires[]`.** A world whose live behaviour or
> whose fallback is a rules model lists `runtime.rules`. A world MUST NOT list
> `runtime.onnx` as required when a rules fallback exists — the world is fully
> playable without ONNX, so listing it would wrongly gate the world behind a
> capability it does not need. Only a world with no fallback lists
> `runtime.onnx`, and only then MAY a player refuse to play it on a device
> without an ONNX runtime.

## Schema patch (for GPT-6)

- New file `packages/format/schema/model-descriptor.v0.1.schema.json` — the
  standalone descriptor schema. It holds **shape only** (field types, ranges,
  enums, `additionalProperties: false`).
- `packages/format/schema/manifest.v0.1.schema.json`: `models.items` is now
  `{ "$ref": "#/definitions/modelDescriptor" }`, and
  `definitions.modelDescriptor` is a verbatim copy of the standalone schema
  (minus `$id` / `$schema`). A format test asserts the two stay identical —
  keep them in sync by copying, never by editing one side alone.
- All **cross-field** rules live in the validator (`validateWorld`), not in the
  schema, because Ajv strict mode rejects the `if`/`then` conditionals the
  descriptor needs (three rounds of `strictRequired` / `strictTypes` errors
  proved this out). Error codes: `models.tensor` (onnx inputs/outputs
  non-empty, every entry has `shape` + `dtype`), `models.seed` (seed required
  when deterministic), `models.oversize` (file bigger than its cap), `models.duplicate`,
  `models.fallback` (unknown id, self-fallback, fallback chains).

## Answer to Q5 (model descriptor fields)

- **Inputs/outputs:** named fields for rules; tensors with `shape` + `dtype`
  (+ optional `range`) for onnx. The feature order for a given model is a
  contract between the model file, the runtime and the descriptor — the court
  rebounder's is `obs [1, 14] float32` → `action [1, 3] float32`, documented in
  `@wgif/ai` (`ONNX_OBS_FEATURES`) and in the descriptor itself.
- **Tick rate:** `tickHz`, 1–60, default 10. Players step at most this fast;
  the runtime is a pure `update(observation, dt) -> action` and owns no
  positions or physics.
- **Determinism:** `deterministic` + required `seed` when true. The court
  rebounder is deterministic (seed 7); its ONNX clone agrees with the rules
  model within one tick on every scripted case (held-out cosine 0.997).
- **Size caps:** rules 64 KiB, onnx 50 KiB by default, 1 MiB hard ceiling.
  The court ships 3,446 + 6,836 bytes of models in a 40,652-byte world.

## Open follow-ups (not in this patch)

- A JSON Schema for the rules file itself (`models/*.rules.json`), so a writer
  can validate a rules model without running it. The fail-closed parser in
  `@wgif/ai` is the reference behaviour until then.
- Whether a future `runtime: "wasm"` (custom tiny models) is ever allowed, and
  what sandbox that would need — explicitly out of v0.1 (§5.6).
