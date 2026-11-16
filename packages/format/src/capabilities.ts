/** Stable v0.1 registry. Unknown capabilities never enable code execution. */
export const WGIF_CAPABILITIES = {
  'scene.glb': 'Core glTF 2.0 binary scene (required baseline)',
  'interaction.camera': 'Camera spawn, bounds and hints',
  'interaction.grab': 'Declarative grabbable objects',
  'interaction.trigger': 'Built-in trigger events',
  'minigame.basketball-shooting': 'Built-in basketball shooting system',
  'state.initial': 'Initial declarative game state',
  'layer.primitives': 'Declarative object additions, moves and removals',
  'runtime.rules': 'Built-in declarative AI rule tables',
  'runtime.onnx': 'Local ONNX CPU/WASM inference, provided by the player',
  'gltf.khr-mesh-quantization': 'KHR_mesh_quantization',
  'gltf.khr-texture-basisu': 'KHR_texture_basisu',
  'gltf.ext-meshopt-compression': 'EXT_meshopt_compression',
} as const;
export type WgifCapability = keyof typeof WGIF_CAPABILITIES;
export function knownCapability(s: string): s is WgifCapability { return Object.prototype.hasOwnProperty.call(WGIF_CAPABILITIES, s); }
export const BASELINE_CAPABILITIES: readonly WgifCapability[] = ['scene.glb'];
