# WGIF v0.1 — Release candidate 1

**Status:** proposed release candidate, **not ratified**; requires Stephon's approval. Format lane: GPT-6 (Ace). 2026-11-15.

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are normative in the RFC 2119 / RFC 8174 sense only when uppercase. The normative container implementation is `packages/format`. The JSON Schemas in `packages/format/schema` are versioned alongside this specification.

## 1. Purpose and scope

WGIF (World Generative Interactive Format) packages a portable, offline, navigable 3D world in one `.wgif` file, with an image preview and optional declarative interactions, initial state, user layers and local model assets. The v0.1 proof is a handcrafted basketball court; image-to-world and animated previews are later milestones. v0.1 is **not** a browser-native GIF replacement, codec, DRM system, executable bundle, multiplayer protocol or scene-generation API.

## 2. Identity and ZIP profile (Q1 resolved)

Extension `.wgif`; provisional media type `application/vnd.wgif+zip` (not registered). A v0.1 file MUST start with a ZIP local file header (`PK\x03\x04`) at byte 0. Its first local entry MUST be named `manifest.json` and MUST use ZIP method 0 (stored). Other entries MUST use method 0 or 8 (deflate). Readers MUST reject encryption, split volumes, ZIP64, data descriptors, duplicate names, directory entries, symlinks, overlapping local records and central/local header inconsistencies. Entry names are UTF-8 relative POSIX paths. A path MUST NOT contain `.` or `..` segments, empty segments, backslashes, control characters, absolute paths, drive-letter prefixes or reserved `__proto__` segments. Names are case-sensitive.

The preview **lives inside the ZIP** as the `entry.preview` image. **GIF/ZIP polyglots are not part of v0.1.** Prepending a GIF would conflict with byte-zero ZIP identification and expand the security surface. A receiving application that cannot decode WGIF MAY extract the preview through a compatible intermediary; arbitrary GIF viewers are not promised to display `.wgif` files. A future minor version may specify external preview discovery.

Writers SHOULD use manifest first, payload entries sorted lexicographically, and fixed DOS timestamp 2000-01-01 00:00 local time to enable reproducible builds. No content fetched from the network is needed for playback.

## 3. Container layout and manifest

```text
manifest.json       required; first local entry; uncompressed UTF-8 JSON
world.glb           required (manifest entry.scene may rename)
preview.png         required (or GIF/JPEG/WebP; manifest entry.preview may rename)
interactions.json   optional, declarative only
game-state.json     optional, initial state only
layers/*.json       optional overlay layer files
models/*            optional data-only inference assets
assets/*            optional referenced textures/audio/etc
```

The uncompressed manifest MUST be at most 1 MiB and satisfy `schema/manifest.v0.1.schema.json`. Required properties: `wgif`, `id`, `title`, `creator`, `created`, `mode`, `entry`, `files`. This release specifies `wgif: "0.1"`, `id` as a stable world identifier, and `mode` as one of `locked`, `editable`, `layered`. `creator.publicKey` MAY contain the public ed25519 key. `created` and `modified` are UTC ISO-8601 timestamps. `entry.scene` MUST reference a `.glb`; `entry.preview` MUST reference a GIF, PNG, JPEG or WebP. `entry.interactions` and `entry.state`, when present, MUST reference `.json` files. `units` is `meters`; +Y is up. `spawn.position` is in meters.

`files[]` MUST list each ZIP entry except `manifest.json` exactly once and MUST have `path`, lowercase hex SHA-256 of the **uncompressed** bytes and uncompressed `size`. `role` MAY be `scene`, `preview`, `interactions`, `state`, `model`, `asset`, `layer`, `other`. Each file referenced by any `entry`, `models[]` or `layers[]` MUST be listed and present. Unknown top-level fields fail the v0.1 schema. Experimental fields belong in namespaced `extensions["x-..."]`; tools SHOULD preserve them during export.

## 4. Scene, preview and models

The scene MUST be self-contained glTF 2.0 binary (`.glb`), with no external HTTP or filesystem URI references. Players MUST implement glTF core sufficient to show the scene; use of optional glTF extensions MUST be declared in `requires[]`. `extras.wgif` node hints MAY describe built-in collider or interaction roles but MUST NOT contain executable code. Players SHOULD show the preview when rendering is unsupported. Preview images SHOULD be at most 512 px on the longest side and 256 KiB.

### 4.1 Embedded models (Nova / Format review)

`models[]` MAY describe self-contained files under `models/` using `runtime: "rules" | "onnx"`. Each descriptor MUST have a unique `id`, a safe `models/` `path`, and a `runtime`. It MAY include `purpose`, `version`, `inputs`, `outputs`, `tickHz` (1–60, default 10), `deterministic`, `seed`, `sizeBytesMax`, `license` and `fallback`. See `schema/model-descriptor.v0.1.schema.json`. Model data MUST NOT contain executable scripts; inference MUST stay on-device in a **player-supplied** runtime without network fetches. Model loading is not a baseline requirement for a v0.1 player.

Rules models MUST be valid UTF-8 JSON and declare `deterministic: true` and a `seed` in their descriptor. ONNX models MUST declare named input/output tensors, including shapes and dtypes, with batch size 1 and at most 65,536 elements per tensor. The player MUST verify actual graph tensors against the descriptors before inference. All models MUST remain below 1 MiB uncompressed; absent `sizeBytesMax`, the defaults are 64 KiB for rules and 50 KiB for ONNX. `sizeBytesMax` may raise that default up to 1 MiB. `tickHz` is a maximum model-update frequency, not a promise of real-time scheduling. Players MUST NOT execute any WGIF-supplied JS, WASM, shell code or user-defined ONNX/custom operators.

`fallback` is the ID of a same-`purpose` **rules** model for an ONNX descriptor. It MUST resolve to a different model in `models[]`, MUST NOT chain, and MUST NOT change any signed payload bytes. Players with the optional ONNX capability SHOULD try the primary model in manifest order; if it fails to initialize, a player supporting `runtime.rules` MUST use the declared rules fallback and SHOULD report the actual runtime. Invalid container hashes, schema violations or malicious payloads are **not** normal runtime fallbacks: readers MUST reject those archives before playback.

`requires[]` is the **only** mandatory capability list. If a world needs rules for essential behavior (including an ONNX-to-rules fallback), it MUST declare `runtime.rules`. An optional ONNX alternative with a valid rules fallback MUST NOT, by itself, force `runtime.onnx` into `requires[]`. If ONNX is essential and no usable fallback exists, the world MUST declare `runtime.onnx`; if ONNX is entirely optional, it MAY omit both runtime capabilities. Unknown required capabilities prevent interactive playback, with an understandable error and a safe preview when available. No `requiredExtensions` field is introduced in v0.1.

**Offline deployment note:** an ONNX runtime's WASM is part of the *installed player*, not the `.wgif`. A web player MUST precache its local runtime resources for offline ONNX playback or fall back to rules; it MUST NOT download runtime code in response to opening a world while offline.

## 5. Declarative payloads (Q2 baseline)

`entry.interactions`, `entry.state` and each `layers[].path` MUST be valid UTF-8 JSON, not scripts, and SHOULD carry `version: "0.1"`; the old `"0.1-draft"` tag remains accepted with a warning. JSON without `version` is accepted for early examples with a warning. Each JSON payload MUST be at most 1 MiB. `interactions.v0.1.schema.json` declares camera hints, object kinds, finite physics parameters, triggers, collider references and the `basketball-shooting` minigame. `game-state.v0.1.schema.json` declares initial scores and object transforms. `layer.v0.1.schema.json` declares bounded `add`, `move` and `remove` operations, without arbitrary import URLs or code. These are **data contracts**; player support for each action is gated by capability strings. A layer MAY contain an empty operation list.

All v0.1 readers MUST NOT execute JavaScript, WASM, shell scripts, HTML or arbitrary code embedded in a world. They MUST NOT fetch external resources to open or play a world. Validation rejects payload filenames with common executable extensions; this is defense in depth, not a substitute for never evaluating untrusted scene data.

## 6. Modes and edit export

`mode` is a **creator-declared policy** recognized by compliant software, **not DRM**. Anyone can extract or modify ZIP bytes. A valid signature makes unauthorized changes *detectable*, not impossible.

| Mode | Compliant player behaviour |
|---|---|
| `locked` | MUST allow navigation/play as supported, MUST NOT expose editing or re-export as the original creator's authentic signed world; MAY keep runtime save state locally. |
| `editable` | MAY edit/export; MUST recompute file hashes; MUST drop a signature if its signed view changes; SHOULD append advisory provenance history and set provenance parent to the signed original. |
| `layered` | MAY add ordered `layers/*.json` entries and `layers[]` descriptors; MUST NOT modify non-layer base content while retaining its signature. A layer's addition does **not** attest to its creator's identity. |

When a signed file is modified, a player MUST distinguish intact base authenticity from user-authored overlays. A `locked` world without a signature MAY open, but MUST be displayed as **unverified** if origin/trust is surfaced in the UI. An invalid signature SHOULD be flagged prominently; a player MAY refuse the file or offer the preview.

## 7. Signing, provenance and key trust (Q3 resolved)

The signing hash binds manifest identity, creator, mode, entry points, required capabilities and SHA-256 payload hashes. Compute `signedView(manifest)` by removing `signature`, `layers`, `modified`, and `provenance.history`, and replacing `files[]` with entries of `{path,sha256,size}` excluding role `layer`, sorted by path. Remove an empty `provenance` object after excluding history. Serialize the signed view as RFC 8785 canonical JSON (UTF-16 key ordering, ECMAScript number and string serialization, no whitespace), then SHA-256 the UTF-8 canonical bytes. ed25519 signs the **raw 32-byte digest**, not its hex text. The signature contains `alg:"ed25519"`, lowercase hex `publicKey` (32 bytes) and `value` (64 bytes). If `creator.publicKey` is provided it MUST match `signature.publicKey`.

Integrity and identity are different: a cryptographically valid signature proves possession of a private key, not that a self-declared creator name corresponds to a real person. **Trust discovery in v0.1 is out-of-band.** Users MAY independently compare the public key (or SHA-256 fingerprint of its 32 raw bytes) against a creator-operated trusted channel. Players SHOULD label keys they have not independently verified as "signature valid, creator unverified". Private signing keys MUST stay outside `.wgif` files, repositories and logs. **Detached signature files are deferred**: v0.1 embeds the signature in `manifest.json` and does not require a detached variant.

`provenance.parent` records `{id, signingHash}`; `provenance.generator` records the tool; `provenance.params` MAY contain a JSON object of arbitrary generator parameters (its properties MAY contain nested JSON values); `provenance.history[]` contains `{action,at,by?,note?}`. `provenance.params` is included in the creator signing hash: changing it invalidates an existing signature. History, layers and modified timestamp are excluded from the creator signature, so they are **advisory and not independently authenticated**. Players MUST NOT display them as cryptographically proven authorship.

## 8. Reader security and limits

Readers MUST preflight ZIP central directory offsets, filenames, methods, sizes and entry count **before inflation**, and MUST enforce the v0.1 untrusted-input ceilings: **256 entries, 16 MiB per entry, 64 MiB total uncompressed**. Players MAY impose lower limits (including a 1 MiB "micro-world" profile), but MUST NOT silently raise the ceilings for arbitrary untrusted files. The separate 1 MiB limits for `manifest.json` and each declarative JSON payload still apply. These are decompression-safety ceilings, **not** recommended asset budgets; larger worlds would need a future profile/version and explicit trust policy. Readers MUST reject the unsafe paths and archive structures in §2 and MUST NOT extract raw names to the filesystem. After inflation, readers MUST validate the manifest, JSON payloads, declarations, SHA-256 and signature status. Readers SHOULD surface structured errors and warnings; invalid JSON, missing files and hash mismatches are errors. A player MUST refuse interactive playback when any `requires[]` capability is not implemented by that player and MUST explain which capabilities are missing; it SHOULD show the bundled preview when it can do so safely. Manifest validation MAY report unknown capabilities as warnings because syntactic validity and runtime feature support are separate checks. No code in the file may be executed by the reader.

## 9. Compatibility, `requires[]` and migration

See [CAPABILITIES.md](CAPABILITIES.md) for the closed v0.1 capability registry and compatibility matrix. `wgif` uses `MAJOR.MINOR`; the only fully specified version in this release is `0.1`. New minor versions SHOULD add only optional fields/capabilities, but **0.x is unstable** and readers SHOULD offer preview fallback. Unknown major versions MUST be refused as interactive worlds. Unknown `requires[]` MUST be reported; an interactive player MUST NOT launch a world until all its declared `requires[]` capabilities are supported. Preview-only mode MAY remain available. `requiredExtensions[]` is not added in v0.1: `requires[]` already fulfills this contract, and glTF's own `extensionsRequired` remains authoritative within the GLB. The immutable v0.1 schema MUST NOT be silently broadened in place after approval.

Migrations MUST be opt-in offline transforms. The planned `0.1 -> 0.2` hook receives immutable `{from,to,manifest,files}`, returns a new `{manifest,files,warnings}`, and MUST recalculate payload hashes and remove invalidated signatures when serialized. No 0.2 migration is available until 0.2 exists. Readers MUST NOT automatically migrate signed originals when simply opening them.

## 10. Example and test vectors

`examples/court/court.wgif` is a v0.1 example. A portable positive/negative archive corpus is in `tests/fixtures/` and canonical-JSON signing vectors are covered by Vitest. A player SHOULD accept `good-minimal.wgif` and reject each `bad-*.wgif` fixture. A signed-but-unknown public key is *not* equivalent to a trusted creator identity.

## 11. Review decisions and lane follow-ups

- **Q1 (Format + Optimization):** no GIF polyglot in v0.1; keep ZIP byte-zero and preview as normal image payload. Revisit only with demonstrated compatibility benefit and a parser security plan.
- **Q2 (Format + Player):** publish conservative schemas now; Claude to verify node names, collision contract, minigame event semantics and layer application order before v0.1 approval.
- **Q3 (Format):** public key in manifest plus externally published fingerprint, no public key registry or PKI and no detached signature in v0.1. Clearly distinguish verification from trust.
- **Q4 (Optimization):** untrusted-world ceilings are 256 entries / 16 MiB each / 64 MiB total, while 1 MiB is a useful opt-in micro-world profile, **not** a universal cap. These are safety limits, not asset quality budgets; Dee to propose target budgets/compression matrix.
- **Q5 (Embedded AI):** Nova to specify model tensor IO, determinism and update rate; current descriptor is intentionally minimal.
- **Q6 (World Generation):** generator lane to define namespaced source provenance without embedding network-only dependencies.
- **Ruling — offline delivery / `file://` (Format, GPT-6/Ace, 2026-11-16):** WGIF v0.1 players MUST support offline playback via an installed PWA or equivalent local application; direct `file://` execution is NOT required. HTTP(S) origins are acceptable for browser delivery. (Answers Dee's Optimization-lane question.)
- **Ruling — `requires[]` vs `requiredExtensions[]` (Format, GPT-6/Ace, 2026-11-16):** `manifest.requires[]` fully supersedes `requiredExtensions[]`. One canonical capability registry ([CAPABILITIES.md](CAPABILITIES.md)) covers glTF extensions, gameplay systems, AI runtimes and other dependencies. Unsupported required capabilities MUST block interactive playback with a readable explanation (see §8 and §9).

- **Ruling — `provenance.params` (Format, GPT-6/Ace, 2026-11-16):** APPROVED as optional, arbitrary JSON metadata for generation parameters, added under `provenance.properties` as `"params": { "type": "object", "additionalProperties": true }`. It remains covered by the signing hash. WGIF manifest versions are `MAJOR.MINOR`, so `0.1.1` is not a valid manifest version: include `params` before v0.1 freezes, or introduce it in v0.2 afterward. This optional field is implemented pre-freeze in the v0.1 schema and TypeScript types, without a manifest version bump. Source: `wgif-packets/replies/gpt6/2026-11-16_0150_rulings2.md`.
- **Ruling — ONNX runtime for Phase One (Format, GPT-6/Ace, 2026-11-16):** prefer Dee's Option A, a small (~2 KiB) player-bundled JS MLP evaluator with no runtime WASM. It MUST NOT claim general `runtime.onnx` support unless it can correctly execute the documented required ONNX operations. Nova's lazy ONNX Runtime Web implementation stays as the optional general-purpose path. No executable code inside `.wgif`. Source: `wgif-packets/replies/gpt6/2026-11-16_0150_rulings2.md`.
- **Ruling — AI capability IDs (Format, GPT-6/Ace, 2026-11-16):** `runtime.rules` is required for rules-based NPCs; `runtime.onnx` is required when ONNX execution is essential. With a working rules fallback, only `runtime.rules` needs to be mandatory. Every model (including ONNX models) MUST have a unique `models[].id`; no model-specific capability ID is needed (see §4.1 and [CAPABILITIES.md](CAPABILITIES.md)). Source: `wgif-packets/replies/gpt6/2026-11-16_0150_rulings2.md`.
- **Ruling — GPT-6 commit identity (Format, GPT-6/Ace, 2026-11-16):** standardize on `GPT-6 (Ace) <gpt6@galactic-ai-team.invalid>` going forward. GPT-6 states no additional implementation patch is required for these rulings. Source: `wgif-packets/replies/gpt6/2026-11-16_0150_rulings2.md`.

**Approval gate:** Stephon explicitly approves the spec and any merge. Until then this is RC1, not a normative published final standard.
