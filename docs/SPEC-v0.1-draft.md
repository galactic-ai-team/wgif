# WGIF v0.1 — Specification (DRAFT)

**Status:** draft for team review. Owner of the final text: GPT-6 (Ace), Format & Architecture lane.
Coordinator: Lumi. Nothing here is frozen until Stephon approves v0.1.

**Reference implementation:** [`packages/format`](../packages/format) (reader, writer, validator, signing).
**Schema:** [`packages/format/schema/manifest.v0.1.schema.json`](../packages/format/schema/manifest.v0.1.schema.json).
**Example:** [`examples/court/court.wgif`](../examples/court) (built by `npm run pack:court`).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

---

## 1. Goals and non-goals

WGIF ("World Generative Interactive Format") is a single-file container for an explorable,
interactive 3D world, meant to be as easy to share as a GIF.

Goals for v0.1:

- One file that holds geometry, textures, audio, interaction rules, game state and optional small AI models.
- Fully offline playback. Nothing in a world may require a network call to open or play.
- An ordinary preview image for platforms that can't render the world.
- Creator-declared edit permissions (locked / editable / layered) with signatures and provenance.
- An open, documented, versioned format that doesn't depend on any one player.

Non-goals for v0.1: DRM, executable scripting (see §5.6), streaming or very large worlds, and multiplayer.

## 2. File identity

- Extension: `.wgif`. Media type: `application/vnd.wgif+zip` (provisional, unregistered).
- A `.wgif` file is a ZIP archive (PKWARE APPNOTE; deflate or stored entries only, no encryption, no ZIP64 in v0.1).
- `manifest.json` MUST be the **first** local entry and MUST be **stored** (uncompressed). This lets
  sniffers identify a WGIF by reading the first ~100 bytes (`PK\x03\x04` … `manifest.json` … `"wgif"`).
- Writers SHOULD produce reproducible output: entries sorted by path after the manifest, and a fixed
  entry timestamp (the reference writer uses DOS time 2000-01-01 00:00, written identically in every timezone).

> Open question (Q1): should the preview also be prepended *outside* the ZIP, as a real GIF
> polyglot, so `.wgif` files render as GIFs in apps that only sniff the magic bytes? ZIP readers
> tolerate leading data. Tracked for the Format and Optimization lanes.

## 3. Container layout

```
world.wgif
├── manifest.json        REQUIRED  — §4
├── preview.gif|png      REQUIRED  — static or animated preview (entry.preview)
├── world.glb            REQUIRED  — scene, glTF 2.0 binary (entry.scene)
├── interactions.json    OPTIONAL  — interaction rules and minigames (entry.interactions)
├── game-state.json      OPTIONAL  — initial / saved state (entry.state)
├── models/              OPTIONAL  — embedded AI models (§5.5)
├── assets/              OPTIONAL  — textures, audio and other payload files
└── layers/              OPTIONAL  — user layers in layered worlds (§8)
```

All entry paths are relative POSIX paths. They MUST NOT start with `/`, contain `..` or `.`
segments, backslashes, empty segments, NUL or drive letters. The names above are conventions:
the manifest's `entry` object is the source of truth for where each role lives.

## 4. Manifest (`manifest.json`)

UTF-8 JSON object, validated by the JSON Schema above. Fields:

| Field | Req | Meaning |
|---|---|---|
| `wgif` | ✔ | Format version `MAJOR.MINOR`, `"0.1"` for this draft. |
| `id` | ✔ | Stable world id (`[A-Za-z0-9][A-Za-z0-9._:-]{2,127}`). Kept across edits of the same world. |
| `title` | ✔ | Human title. |
| `description` | | Free text. |
| `creator` | ✔ | `{ name, url?, publicKey? }`. `publicKey` is the creator's ed25519 key (hex). |
| `created` / `modified` | ✔ / | UTC timestamps, `YYYY-MM-DDTHH:MM:SS[.fff]Z`. |
| `license` | | SPDX id or free text. |
| `mode` | ✔ | `locked`, `editable` or `layered` (§6). |
| `entry` | ✔ | `{ scene, preview, interactions?, state? }`, paths into the container. |
| `spawn` | | `{ position: [x,y,z], lookAt?: [x,y,z] }` in meters, glTF axes (+Y up). |
| `units` | | `"meters"` (the only value in v0.1). |
| `requires` | | Capability strings a player needs (e.g. `scene.glb`, `minigame.basketball-shooting`, `runtime.onnx`). |
| `files` | ✔ | One entry per payload file: `{ path, sha256, size, mediaType?, role? }`. |
| `models` | | Embedded model descriptors (§5.5). |
| `layers` | | Ordered user layers (§8). |
| `provenance` | | `{ parent?, generator?, history? }` (§7). |
| `signature` | | `{ alg: "ed25519", publicKey, value }` (§7). |
| `extensions` | | Namespaced extra data, keys `x-<name>`. |

Rules:

- `files[]` MUST list **every** entry in the container except `manifest.json`, and nothing else.
  `sha256` is lowercase hex of the raw (uncompressed) bytes. `size` is the uncompressed byte length.
- `role` is one of `scene, preview, interactions, state, model, asset, layer, other`.
- Unknown top-level fields are a schema error in v0.1 (strict). Forward-compatible data goes in `extensions`.

## 5. Payload files

### 5.1 Scene: `world.glb`
glTF 2.0 binary. v0.1 players MUST support core glTF 2.0 with embedded buffers and images. They
SHOULD support `KHR_mesh_quantization`, `KHR_texture_basisu` and `EXT_meshopt_compression`; worlds
that use them MUST list them in `requires` (Optimization lane to finalize). External URIs are
forbidden: everything has to be inside the GLB or in the container.

Nodes MAY carry `extras.wgif` hints, such as `{ "collider": "static" }`, `{ "role": "target" }` or
`{ "role": "grabbable" }`. Players use these hints, but `interactions.json` is authoritative.

### 5.2 Preview: `preview.gif|png|jpg|webp`
A plain image. It SHOULD be ≤ 512 px on the long edge and ≤ 256 KB. Animated GIF is preferred
when the creator wants a "GIF that opens into a world".

### 5.3 Interactions: `interactions.json` (shape is a DRAFT, owned by the Format + Player lanes)
Declarative data, not code. The v0.1 draft shape, as used by the example court:

```json
{
  "version": "0.1-draft",
  "camera": { "spawn": [0,1.7,9.5], "lookAt": [0,1.2,0], "firstPersonHeight": 1.7,
              "bounds": { "min": [-17,0,-10], "max": [17,6,10] } },
  "objects": [ { "id": "ball", "node": "ball", "kind": "grabbable", "physics": { "shape": "sphere", "radius": 0.12, "mass": 0.6, "restitution": 0.75 } },
               { "id": "rim_home", "node": "rim_home", "kind": "trigger", "shape": { "type": "cylinder", "center": [12.425,3.05,0], "radius": 0.225, "height": 0.1 },
                 "on": { "enterFromAbove": { "event": "score", "target": "ball" } } } ],
  "colliders": { "static": ["floor_court", "..."] },
  "minigames": [ { "id": "shootout", "type": "basketball-shooting", "ball": "ball", "targets": ["rim_home","rim_away"],
                   "rules": { "durationSec": 60, "pointsPerBasket": 2 } } ]
}
```

A JSON Schema for this file is a Phase One deliverable (GPT-6, together with Claude).

### 5.4 State: `game-state.json`
Initial state that players load, such as scores and object transforms. Players save the
**runtime** state locally (for example in IndexedDB, keyed by `id` + base signing hash), and only
write it back into the file on an explicit export (§8).

### 5.5 Models: `models/`
Each embedded model is a file under `models/` with a descriptor in `manifest.models[]`:
`{ id, path, runtime: "rules" | "onnx", purpose?, ... }`. `rules` models are declarative JSON
behaviour tables. `onnx` models run through ONNX Runtime Web (WASM, CPU) or an equivalent local
runtime. Inference MUST be on-device. The Embedded AI lane (Nova) owns the full convention
(inputs, outputs, tick rate, size caps).

### 5.6 No executable code in v0.1
Containers MUST NOT rely on JavaScript, WASM or any other code being executed from the file.
Players MUST NOT execute code found in a container. Behaviour comes only from the player's
built-in systems plus declarative data. Scripting is future work and needs its own sandbox design.

## 6. Modes: locked, editable, layered

`mode` is the **creator's declared policy**. It is enforced by **compliant players**, backed by the
creator signature (§7). It is **not DRM**. A `.wgif` is a ZIP, so anyone with a ZIP tool can change
any byte. What the signature guarantees is that such changes are **detectable**: a modified world
can no longer claim to be the creator's authentic, signed original.

| Mode | Compliant player MUST | Compliant player MUST NOT |
|---|---|---|
| `locked` | Allow explore and play. Save runtime state locally (scores and so on) outside the file. | Offer edit tools, or export a modified world that keeps the creator's identity or signature. |
| `editable` | Allow edits and exports. On export, recompute hashes, append to `provenance.history`, and drop a creator signature that no longer verifies, recording it as `provenance.parent`. | Keep an invalid signature in an exported file. |
| `layered` | Keep the base world bit-identical. Store user additions as files under `layers/`, listed in `layers[]`. The base signature stays valid (§7). | Modify any non-layer file. |

If a `locked` world has no valid signature, the player SHOULD show it as "unsigned / unverified".
It MAY still play it.

## 7. Provenance and signatures

**Signing hash.** Take the manifest and remove `signature`, `layers`, `modified` and
`provenance.history`. Reduce `files[]` to the non-`layer` entries, each as `{path, sha256, size}`,
sorted by path. Serialise the result as canonical JSON (keys sorted, no whitespace; RFC 8785/JCS for
the value set WGIF uses). The **signing hash** is SHA-256 over those UTF-8 bytes.

In practice this is the manifest's **hash list** (every non-layer file's SHA-256) bound together with
the fields that define the world and its permissions (`id`, `mode`, `creator`, `entry`, …). Signing
the hash list alone would let anyone flip `locked` to `editable` without breaking the signature.

**Signature.** `signature.value` is an ed25519 signature (RFC 8032, 64 bytes, hex) over the 32-byte
signing hash, using `signature.publicKey`. If `creator.publicKey` is present, it MUST equal
`signature.publicKey`.

**Provenance.**
- `provenance.parent = { id, signingHash }` records the world this one was derived from. Writers set it
  when an edit drops the creator signature, or when forking (a fork also gets a new `id`).
- `provenance.history[] = { action, at, by?, note? }` is an append-only edit log. It is not signed, so
  it is advisory.
- `provenance.generator` names the tool that produced the file.

**Key handling.** Private keys never go into a container, a repo, or a chat. v0.1 has no PKI: trust in
a `publicKey` comes from outside the file (for example, a creator publishing their key). Key discovery is
an open question (Q3).

## 8. Layered edits and export

- A layer is a JSON file under `layers/` with entry `{ id, path, author, created? }` in `layers[]`.
  Layers are applied in array order on top of the base scene. Its contents (add or move nodes,
  extra interactions) are a DRAFT owned by the Player lane.
- Adding, removing or reordering layers changes only fields excluded from the signing hash, so the
  base creator signature stays valid and players can show "original by X + N layers".
- Export of an `editable` world: see §6. The reference implementation is `exportEditedWorld()`.

## 9. Reader (player) requirements and security

A reader MUST:

1. Reject input that is not a ZIP, or that has no `manifest.json` at the root.
2. Enforce limits before inflating. The reference defaults are ≤ 4096 entries, ≤ 256 MiB per entry and
   ≤ 512 MiB total uncompressed. Players MAY lower them (mobile).
3. Reject unsafe entry paths (§3), and never write entries to the filesystem using their raw paths.
4. Validate `manifest.json` against the schema. Reject an unknown `MAJOR` version. Accept a newer
   `MINOR` with a warning.
5. Check that every `entry.*`, `models[].path` and `layers[].path` is listed in `files[]`; that every
   listed file is present, with a matching `size` and `sha256`; and that no unlisted files exist.
6. Verify `signature` if present, and report `valid`, `invalid` or `absent` to the user.
7. Never execute code from the container (§5.6), and never fetch network resources to render the world.

## 10. Compatibility and versioning

- `wgif` is `MAJOR.MINOR`. A **MINOR** bump only adds optional fields or capabilities. Old readers
  ignore the parts they don't understand, which may degrade the experience but never breaks safety.
  A **MAJOR** bump may change or remove anything. Old readers MUST refuse it and show the preview.
- `requires[]` lists the capabilities needed to fully experience the world. Players SHOULD show a
  "needs a newer player" notice, plus the preview, for unknown capabilities rather than failing silently.
- `extensions["x-…"]` carry experimental data. Writers MUST preserve unknown extensions on export.
  Promoting an extension into the core spec needs a MINOR bump.
- Each published schema is immutable (`manifest.v0.1.schema.json`). New versions get new files.
- Every v0.x MAY break compatibility. v1.0 freezes the rules in this section.

## 11. Open questions for team review

- Q1. GIF polyglot preview (§2). (Format + Optimization)
- Q2. JSON Schemas for `interactions.json`, `game-state.json` and layer files. (Format + Player)
- Q3. Key discovery and trust for creator public keys, and whether to add an optional detached signature file. (Format)
- Q4. Size budgets per device class, and which glTF compression extensions are mandatory. (Optimization)
- Q5. Model descriptor fields: input/output tensors, tick rate, determinism. (Embedded AI)
- Q6. How an image/GIF-to-world generator records its source and parameters in `provenance`. (World Generation)

## Appendix A: example manifest (abridged, from `examples/court`)

```json
{
  "wgif": "0.1",
  "id": "galactic.examples.court",
  "title": "Galactic Court",
  "creator": { "name": "Galactic AI Team" },
  "created": "2026-11-15T00:00:00Z",
  "mode": "editable",
  "units": "meters",
  "entry": { "scene": "world.glb", "preview": "preview.png", "interactions": "interactions.json", "state": "game-state.json" },
  "spawn": { "position": [0, 1.7, 9.5], "lookAt": [0, 1.2, 0] },
  "requires": ["scene.glb"],
  "files": [
    { "path": "game-state.json", "sha256": "…", "size": 219, "mediaType": "application/json", "role": "state" },
    { "path": "world.glb", "sha256": "…", "size": 91384, "mediaType": "model/gltf-binary", "role": "scene" }
  ]
}
```
