export * from './types.js';
export * from './rules.js';
export * from './features.js';
export * from './jsmlp.js';
export * from './loader.js';
// NOTE: './onnx.js' (OnnxNpc, ONNX Runtime Web) is deliberately NOT exported
// here. It is Node-side verification only — the player runs .onnx models
// through the JS MLP evaluator (JsMlpNpc), and exporting the ort path would
// let the player bundle pull in onnxruntime-web and its ~29 MB WASM. Tests
// import OnnxNpc from '../src/onnx.js' directly.
