# WGIF v0.1 — file format specification

**Single normative v0.1 contract:** WGIF manifest version `"0.1"`. This
specification, the five versioned JSON Schemas, and the format validator define
v0.1 conformance. `docs/SPEC-v0.1-draft.md` and
`docs/SPEC-5.5-models-proposal.md` are superseded historical pointers.
Phase One's merge does not by itself authorize a `v0.1.0` tag or package bump;
those remain subject to the explicit owner release gate.

**Conformance language.** MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY express
requirements for conforming v0.1 implementations. The five JSON Schemas in
`packages/format/schema/` define permitted JSON shapes. The additional
cross-field, archive, and integrity requirements below are implemented by
`packages/format/src/{zipSafety,validate,container,signing}.ts`. A successful
schema check alone is not sufficient to establish a valid WGIF archive.

## 1. Identity, versions, and compatibility

- The extension is `.wgif`; the provisional, unregistered media type is
  `application/vnd.wgif+zip`. The container is ZIP, **not** a GIF/ZIP polyglot
  and not a browser-native GIF. A preview image is an archive member.
- `manifest.json` MUST contain `"wgif": "0.1"` for a v0.1-authored world.
  This is MAJOR.MINOR, distinct from software/package release `0.1.0`.
  A reader MUST reject an unknown major version. The current v0.1 reader
  warns on a higher minor version; a player MAY decline interactive playback
  if it cannot establish compatible behavior. No automatic v0.2 migration is
  specified.
- The only list of mandatory player features is manifest `requires[]`.
  It MAY be absent (equivalent to an empty list). An unsupported requirement
  MUST prevent interactive playback, with a named diagnostic and preferably
  a safe preview. An unknown capability is a **validation warning**, not an
  archive-integrity error. Implementations MUST advertise only capabilities
  they actually support; a model payload cannot add executable capabilities.

## 2. ZIP envelope and limits

The first bytes MUST be ZIP local-file-header magic `PK\x03\x04`; the first
local entry, at byte offset zero, MUST be `manifest.json` and MUST be STORED
(ZIP method 0). Other entries MAY use STORED (0) or DEFLATE (8). Writers SHOULD
place other entries in lexicographic path order and use a fixed DOS timestamp
(2000-01-01 00:00) to enable reproducible archives.

Readers MUST preflight ZIP structure before inflation and MUST reject encrypted
entries, unsupported compression methods, split/multidisk archives, ZIP64,
data descriptors, symlinks, directory entries, duplicate names, overlapping
local records, prepended/trailing unindexed data, and central/local header
inconsistencies. ZIP entry paths are case-sensitive UTF-8 relative POSIX
paths. Paths MUST NOT be empty, longer than 512 characters, absolute, drive-
prefixed, contain `\\` or ASCII control characters, or contain empty, `.`,
`..`, or `__proto__` path segments. `manifest.json` MUST appear exactly once
and MUST NOT appear in its own `files[]` list.

| Reader safety ceiling | v0.1 value |
| --- | ---: |
| ZIP entries (including `manifest.json`) | 256 |
| Uncompressed bytes per entry | 16 MiB (16,777,216) |
| Combined uncompressed ZIP bytes | 64 MiB (67,108,864) |
| Uncompressed `manifest.json` | 1 MiB (1,048,576) |
| Each referenced declarative JSON payload | 1 MiB (1,048,576) |

Readers MUST enforce these limits **both before inflation**, using ZIP
central-directory sizes, **and as actual bytes are produced during inflation**.
A lying uncompressed-size field MUST NOT permit output past the entry or
aggregate budget; readers MUST reject decoded sizes inconsistent with the
ZIP's declared sizes. A reader MUST NOT rely on advertised sizes alone.

A reader MAY impose tighter device limits. These are **safety ceilings**, not
size targets: authors SHOULD follow `docs/BUDGETS.md` for the smaller Phase 1
optimization budgets (notably the approximately 1 MiB world target).

## 3. Manifest and files

`manifest.json` MUST be UTF-8 JSON conforming to
`packages/format/schema/manifest.v0.1.schema.json` (JSON Schema draft-07).
Top-level properties not named by that schema MUST be rejected; experimental
metadata belongs under `extensions` with keys matching `x-[a-z0-9-]+`.
Authors SHOULD preserve unknown namespaced extension values on export.

| Field | Requirement |
| --- | --- |
| `wgif` | REQUIRED MAJOR.MINOR string; exactly `"0.1"` for v0.1 writers |
| `id` | REQUIRED stable ID, 3–128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]{2,127}` |
| `title`, `creator`, `created` | REQUIRED; nonempty title (max 200), creator object with nonempty `name` (max 200), UTC timestamp |
| `mode` | REQUIRED: `locked`, `editable`, or `layered` |
| `entry` | REQUIRED: `scene` and `preview` archive paths; optional `interactions` and `state` paths |
| `files` | REQUIRED nonempty array of `{path, sha256, size}`; optional `mediaType`, `role` |
| `description`, `license`, `modified` | OPTIONAL, with schema lengths and timestamp pattern |
| `spawn`, `units` | OPTIONAL: `spawn.position` as three numbers and optional `lookAt`; `units` if present MUST be `meters` (+Y up) |
| `requires` | OPTIONAL array of unique case-sensitive capability identifiers |
| `models`, `layers` | OPTIONAL model descriptors and ordered layer descriptors (see §§6–7) |
| `provenance`, `signature`, `extensions`, `$schema` | OPTIONAL, schema-constrained metadata |

Timestamps MUST use the schema's UTC ISO-8601 form
`YYYY-MM-DDTHH:MM:SS[.fraction]Z`. `entry.scene` MUST name a `.glb`; `entry.preview`
MUST name a `.gif`, `.png`, `.jpg`, `.jpeg`, or `.webp`. Optional
`entry.interactions` and `entry.state` MUST name `.json` files. Every path in
`entry`, `models[]`, and `layers[]` MUST be declared and present in the ZIP.

`files[]` MUST enumerate **every** archive payload entry except `manifest.json`
exactly once, with no extra or missing entries. `sha256` MUST be 64 lowercase
hex characters encoding SHA-256 of the **uncompressed** payload bytes; `size`
MUST be their uncompressed byte length. The validator MUST reject mismatched
hashes, sizes, unsafe paths, absent references, and undeclared payloads.
`role`, when provided, MUST be one of `scene`, `preview`, `interactions`,
`state`, `model`, `asset`, `layer`, or `other`. Content hashes, not ZIP CRCs,
establish payload integrity.

## 4. Scene, preview, and embedded assets

The primary scene MUST be a self-contained glTF 2.0 binary `.glb`. It MUST NOT
reference external HTTP, network, or filesystem assets. A GLB MAY use embedded
`data:` URIs; authors SHOULD put referenced resources inside the GLB or the
WGIF archive. A conforming player MUST NOT fetch resources or execute content
supplied by a world to satisfy scene, model, interaction, or asset references.
The v0.1 extension allowlist is:

| glTF extension | Required WGIF capability when listed in `extensionsUsed` |
| --- | --- |
| `KHR_mesh_quantization` | `gltf.khr-mesh-quantization` |
| `KHR_texture_basisu` | `gltf.khr-texture-basisu` |
| `EXT_meshopt_compression` | `gltf.ext-meshopt-compression` |

A GLB MUST NOT declare glTF extensions outside this list. Its
`extensionsRequired` entries MUST also occur in `extensionsUsed`; every
listed `extensionsUsed` extension MUST have the corresponding capability in
`manifest.requires[]`. The release gate strictly parses the GLB JSON chunk;
full glTF geometry/rendering validation remains a player responsibility.
Node `extras.wgif` MAY carry data-only hints for built-in colliders or
interactions but MUST NOT contain executable behavior.

`entry.preview` MUST resolve to an embedded image. Authors SHOULD keep its
longest dimension at most 512 pixels and its size at most 256 KiB. Auxiliary
textures, audio, and other opaque **data** MAY be packaged under `assets/`;
they MUST be declared, hashed and bounded like all other payloads. No v0.1
`assets[]` manifest property exists. An asset path is not permission to fetch
it from the network or run it as code. Payload filenames ending in `.js`,
`.cjs`, `.mjs`, `.wasm`, `.htm`, `.html`, `.sh`, `.exe`, `.dll`, `.bat`, or
`.ps1` MUST be rejected by the v0.1 validator; readers MUST NOT execute
arbitrary bundled code regardless of extension.

## 5. Declarative interaction and initial-state payloads

When present, `entry.interactions` names `interactions.json` (or another
`.json` path). The payload MUST be valid UTF-8 JSON, at most 1 MiB, conforming
to `schema/interactions.v0.1.schema.json`. It MAY contain:

- `camera`: optional `spawn` / `lookAt` 3-vectors, positive
  `firstPersonHeight` (at most 100), and `bounds` with `min`/`max` 3-vectors.
- `objects`: at most 10,000 entries, each requiring `id`, `node`, and `kind`
  (`grabbable`, `trigger`, `static`, or `dynamic`); optional spawn, primitive
  shape (`sphere`, `box`, `cylinder`), bounded physics, and declarative `on`
  events (`enterFromAbove`, `enter`, `grab`; events `score`, `reset`, `activate`).
- `colliders.static`: a unique list of named nodes; optional `minigames`
  (at most 100) with the built-in `basketball-shooting` type, `ball`, `targets`,
  and `rules` (`durationSec`, `pointsPerBasket`, optional `threePointRadius`).
- `interactions`: an optional array of at most 10,000 declarative objects;
  the schema allows this compatibility field but does not define an arbitrary
  executable behavior language for it.

When present, `entry.state` names `game-state.json` (or another `.json`
path). It MUST be valid UTF-8 JSON, at most 1 MiB, conforming to
`schema/game-state.v0.1.schema.json`. It MAY contain a nonnegative integer
`score`, up to 100 `minigames` by ID (each holding nonnegative `highScore`,
`plays`, or `score`), and up to 10,000 `objects` by ID (each with optional
position/scale 3-vectors, rotation 4-vector, and `enabled` boolean).
This is initial **data**, not an authorization for arbitrary code execution.

Both payloads, and each layer JSON (§7), SHOULD contain `"version": "0.1"`.
The current v0.1 validator accepts omitted `version` or legacy
`"0.1-draft"` **with a warning**, not an error. If supplied, version MUST be
one of those two values. Player support for interaction, physics, minigame,
and state semantics remains capability-gated: schema-valid data alone does
not imply the proof player implements every feature.

## 6. `models/`: packaged inference data

`manifest.models[]` MAY list at most 64 model descriptors, each with a
unique `id`, a safe `models/` path, and runtime `rules` or `onnx`. A descriptor
MAY include `purpose`, semver-like `version`, named `inputs`/`outputs`,
`tickHz` (1–60, default 10), `deterministic`, unsigned 32-bit `seed`,
`sizeBytesMax`, `license`, and `fallback`. The standalone
`schema/model-descriptor.v0.1.schema.json` mirrors the copy embedded in the
manifest schema. IDs MUST match `[a-z][a-z0-9_-]{0,63}`; duplicate model
IDs and duplicate model paths MUST be rejected. `rules` paths MUST end in
`.json`; `onnx` paths MUST end in `.onnx`. Only descriptors in
`manifest.models[]` are discoverable model candidates. Other safely declared
files under `models/` remain inert payloads and MUST NOT be auto-executed.

Each rules file MUST be valid UTF-8 JSON; its descriptor MUST declare
`deterministic: true` and a `seed`. A player supporting rules MUST reject
unknown or nondeterministic rules at **model load**. An ONNX descriptor MUST
provide nonempty `inputs` and `outputs`; each tensor MUST name its `shape`
and `dtype` (`float32`, `int32`, `int64`, or `bool`). Tensor shapes MUST start
with batch dimension 1, use at most four positive dimensions and contain at
most 65,536 elements. Named-field (non-tensor) rules descriptors MAY omit
`inputs` and `outputs`. Duplicate field names and invalid numeric ranges
MUST be rejected. `tickHz` is a maximum update rate, not a real-time guarantee;
players MUST NOT step a model faster than its declared rate. Before inference,
a player MUST validate that an ONNX model's supported graph and tensor
signature agree with its descriptor.

Each unpacked model MUST remain at or under 1 MiB (1,048,576 bytes). When
`sizeBytesMax` is absent, the enforced caps are 65,536 bytes for rules and
51,200 bytes for ONNX. A provided `sizeBytesMax` MAY raise that default but
MUST NOT exceed 1 MiB; the actual file MUST fit its effective cap.

Only an ONNX descriptor MAY declare `fallback`, and it MUST reference a
**different**, same-`purpose` rules model in `models[]`; self-fallback,
missing targets, ONNX-to-ONNX fallbacks, and fallback chains are forbidden.
Models of the same `purpose` SHOULD be tried in manifest order unless the
user explicitly selects a local runtime preference. A fallback MUST select
the exact model identified by `fallback`, not an arbitrary same-purpose model.
Fallback occurs only after archive validation succeeds; missing archive files,
hash mismatches and schema errors MUST reject the archive, not trigger fallback.
If rules behavior is required
for complete playback, `requires[]` MUST contain `runtime.rules`. An optional
ONNX alternative with usable rules fallback SHOULD NOT require
`runtime.onnx`; only a world that essentially needs a general ONNX runtime
without a usable fallback MUST require `runtime.onnx`.

Models are **data**, not software shipped by the archive. Runtimes MUST be
player-supplied and operate locally. The proof player's restricted JavaScript
MLP reader supports one known ONNX-shaped network; it does **not** advertise
or implement the general `runtime.onnx` capability and uses no runtime WASM.
Implementations MUST NOT evaluate scripts, imported custom operators, or
externally fetched runtime code from an archive.

## 7. Layers, modes, and portable edit/export

`mode` is a creator-declared policy, not DRM. In `locked` mode a compliant
player MUST NOT export edited content as the original signed world. In
`editable` mode tools MAY modify payloads and export a new `.wgif` but MUST
recompute file hashes and MUST NOT preserve a signature over changed signed
content. In `layered` mode tools MAY append overlay entries while preserving
a valid base signature, but MUST NOT change signed base content under that
signature. Any `layers[]` in the manifest requires `mode: "layered"`.

`layers[]` is an ordered list of `{id, path, author, created?}`. Each layer
path MUST be unique, below `layers/`, end with `.json`, and have a matching
`files[]` entry with `role: "layer"`; every layer-role file MUST be referenced
from `layers[]`. Each layer file MUST be valid UTF-8 JSON, at most 1 MiB, and
conform to `schema/layer.v0.1.schema.json`: optional bounded `add` (primitive
`box`/`sphere`/`cylinder`, ID, position and optional size/color), `move`
(ID and position, optional rotation/scale), and unique `remove` IDs. No
remote imports or executable actions are specified.

When exporting edits, a writer SHOULD update `modified` and append a
`provenance.history[]` record with `action` and UTC `at`, optionally `by` and
`note`. `provenance.parent`, when present, MUST be an object containing both
`id` and a lowercase-hex, 64-character `signingHash` of the parent signed
view; a string parent is invalid. `provenance.generator` and `params` MAY
identify deterministic generation. An exporter SHOULD reopen and validate
the serialized archive before offering it for transfer to another device.

## 8. Signature and verification

A manifest MAY have an Ed25519 `signature` object with `alg: "ed25519"`, a
64-digit lowercase-hex `publicKey`, and a 128-digit lowercase-hex `value`.
A signing tool computes SHA-256 over RFC 8785-style canonical JSON of the
**signed view** and signs the resulting 32-byte digest. The signed view
excludes `signature`, `layers`, `modified`, `provenance.history`, and file
entries whose `role` is `layer`; other manifest fields and each non-layer
file's `path`, `sha256`, and `size` contribute. Signed base files MUST NOT
change without invalidating or dropping the signature. A changed signed
world SHOULD record its original `{id, signingHash}` as provenance parent.

The validator reports `signature` as `absent`, `valid`, or `invalid`; an
invalid signature currently yields a **warning** rather than changing the
archive's schema/hash `report.ok`. A player MUST NOT present an invalid
signature as a verified origin. Cryptographic validity does **not** identify
or endorse the real-world creator; no PKI is mandated. The reference
`exportEditedWorld()` refuses to return a newly exported archive that fails
post-export validation or has an invalid remaining signature. Overlay layers,
`modified`, and `provenance.history` are excluded from the creator signature;
players MUST NOT present their authors or timestamps as cryptographically
verified. Unsigned locked worlds MAY open, but MUST be labeled unverified
when displaying origin status.

## 9. Conformance and release boundary

Readers MUST enforce §§2–8 with full archive and payload validation; merely
parsing `manifest.json` does not establish portability. Writers SHOULD run
`wgif validate` and `wgif inspect` on the produced bytes and test reopen on
another compatible player/device. A web player intended to meet the Phase 1
offline criterion MUST work after installation or through a documented
local equivalent with networking disconnected; a remotely hosted page that
cannot start offline does not meet that criterion. Direct `file://` execution
is NOT required: an installed offline-capable PWA or local application suffices.

This document specifies the **v0.1 data contract**, not confirmation of
full player feature support or release authorization. `docs/FREEZE-v0.1.md`
remains fail-closed until owner ratification, capability, offline/browser,
security, reproducibility, version/lock, and release-evidence gates are
independently completed. Do not change package versions or publish `v0.1.0`
merely because this specification file exists.
