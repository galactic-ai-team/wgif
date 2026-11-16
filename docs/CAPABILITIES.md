# WGIF capabilities and version compatibility — v0.1 RC1

The `requires[]` manifest property is a list of case-sensitive capability IDs. Writers MUST name capabilities needed for complete playback; players MUST refuse interactive playback when any required capability is unsupported, name the missing capabilities, and SHOULD offer the preview. Unknown capabilities are warnings at manifest validation time because validation and player support are separate. **A capability is data describing a built-in player function, not a script the world gets to run.**

## v0.1 registry

| ID | Meaning | Baseline? |
|---|---|---|
| `scene.glb` | Core self-contained glTF 2.0 binary | Yes |
| `interaction.camera` | Camera spawn and bounds hints | No |
| `interaction.grab` | Grabbable objects | No |
| `interaction.trigger` | Built-in trigger events | No |
| `minigame.basketball-shooting` | Court shootout runtime | No |
| `state.initial` | Declarative state seed | No |
| `layer.primitives` | Add/move/remove primitives in an overlay | No |
| `runtime.rules` | Built-in declarative rule tables | No |
| `runtime.onnx` | On-device ONNX CPU/WASM runtime supplied by player | No |
| `gltf.khr-mesh-quantization` | glTF `KHR_mesh_quantization` | No |
| `gltf.khr-texture-basisu` | glTF `KHR_texture_basisu` | No |
| `gltf.ext-meshopt-compression` | glTF `EXT_meshopt_compression` | No |

Writers SHOULD add `minigame.basketball-shooting` for a shootout, `state.initial` for state and `layer.primitives` for layers; the historical court has only `scene.glb` during the transition. The player lane MUST verify that advertised capabilities are truly implemented before claiming support. The proof player currently advertises `scene.glb` and `interaction.camera` only; Claude should extend its supported list as features land. No `requiredExtensions[]` field is introduced in v0.1, because `requires[]` is already normative.

## Compatibility matrix

| World | v0.1 reader | Future v0.2 reader (planned) |
|---|---|---|
| v0.1, known capabilities | Read, validate, run supported features | SHOULD accept |
| v0.1, unsupported required capability | Validate with warning; refuse interactive playback, offer preview | Refuse unless actually supported |
| v0.2 (future), same major | Warn; MAY read only if known v0.1 subset passes validation | Planned native support |
| v1.x or other major | Refuse interactive playback, show preview when safely extractable | Depends on future spec |
| malformed or unsafe ZIP | Reject | Reject |

`0.x` is experimental, so minor versions may need explicit migration. New schema filenames MUST be introduced rather than mutating a frozen published schema.

## Migration hook

See `packages/format/src/migrations.ts`. A migration is registered by a reader/authoring tool, never by a `.wgif` file. Future `0.1 -> 0.2` transforms are explicit, offline, produce a new archive, preserve provenance and discard any invalid signature. **No hook is implemented until the 0.2 contract is approved.**
