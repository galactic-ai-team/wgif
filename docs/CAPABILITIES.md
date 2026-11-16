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
| `runtime.onnx` | General on-device ONNX runtime supplied by a player (not implemented by the v0.1 proof player) | No |
| `gltf.khr-mesh-quantization` | glTF `KHR_mesh_quantization` | No |
| `gltf.khr-texture-basisu` | glTF `KHR_texture_basisu` | No |
| `gltf.ext-meshopt-compression` | glTF `EXT_meshopt_compression` | No |

Writers SHOULD add `minigame.basketball-shooting` for a shootout, `state.initial` for state and `layer.primitives` for layers; the current court example declares `scene.glb` and `runtime.rules`. The player lane MUST verify that advertised capabilities are truly implemented before claiming support.

For `models[]`, `runtime.onnx` and `runtime.rules` follow the same **required-for-play** semantics as other `requires[]` entries. Bundling an optional ONNX model does not require `runtime.onnx` if an essential same-purpose rules fallback is available. If the rules behavior is essential, list `runtime.rules` instead; if there is no fallback and ONNX is essential, list `runtime.onnx`. Model descriptors do not introduce a second `requiredExtensions[]` list. The proof player currently advertises `scene.glb`, `interaction.camera`, and `runtime.rules` (see `apps/player/src/world.ts`). Its small JavaScript MLP evaluator can try a supported ONNX-shaped model as an **optional** optimization, but does not claim general `runtime.onnx` support. The player MUST keep this advertised set synchronized with features it actually implements.

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
