/** WGIF v0.1 draft manifest types. Mirrors schema/manifest.v0.1.schema.json. */

export const WGIF_VERSION = '0.1' as const;
export const WGIF_MEDIA_TYPE = 'application/vnd.wgif+zip' as const;
export const WGIF_EXTENSION = '.wgif' as const;
export const MANIFEST_PATH = 'manifest.json' as const;

export type WorldMode = 'locked' | 'editable' | 'layered';
export type FileRole = 'scene' | 'preview' | 'interactions' | 'state' | 'model' | 'asset' | 'layer' | 'other';
export type Vec3 = [number, number, number];

export interface Creator {
  name: string;
  url?: string;
  /** ed25519 public key, 32 bytes as lowercase hex. */
  publicKey?: string;
}

export interface EntryPoints {
  scene: string;
  preview: string;
  interactions?: string;
  state?: string;
}

export interface FileEntry {
  path: string;
  sha256: string;
  size: number;
  mediaType?: string;
  role?: FileRole;
}

/**
 * One input/output of an embedded model (manifest.models[] entry).
 * For `rules` models these are named observation/action fields (shape/dtype omitted).
 * For `onnx` models these are tensors: shape and dtype are required and MUST match the graph.
 * Full convention: packages/format/schema/model-descriptor.v0.1.schema.json,
 * docs/SPEC-5.5-models-proposal.md. Owned by the Embedded AI lane.
 */
export interface ModelTensor {
  name: string;
  /** Tensor shape, e.g. [1, 8]. First dimension is the batch (always 1 in v0.1). */
  shape?: number[];
  dtype?: 'float32' | 'int32' | 'int64' | 'bool';
  description?: string;
  /** Expected [min, max] of the values; players SHOULD clamp inputs to this range. */
  range?: [number, number];
}

export interface ModelEntry {
  id: string;
  /** Relative POSIX path; model files MUST live under models/. */
  path: string;
  runtime: 'rules' | 'onnx';
  /** What the model does in this world, e.g. "rebounder". Players match by purpose, not id. */
  purpose?: string;
  version?: string;
  inputs?: ModelTensor[];
  outputs?: ModelTensor[];
  /** How often the player MUST step the model (1-60 Hz; 10 Hz is the v0.1 default). */
  tickHz?: number;
  /** True when the same observation sequence always gives the same actions. */
  deterministic?: boolean;
  /** Deterministic seed (uint32). REQUIRED when deterministic is true. */
  seed?: number;
  /** Hard cap on the model's uncompressed byte size. Defaults: rules 65536, onnx 51200. */
  sizeBytesMax?: number;
  /** SPDX id or free text for the model file itself. */
  license?: string;
  /** Id of another model in the same manifest to use when this one cannot run. No chains. */
  fallback?: string;
}

/** Default per-runtime size caps (bytes) when a descriptor omits sizeBytesMax. */
export const MODEL_SIZE_CAPS = { rules: 64 * 1024, onnx: 50 * 1024 } as const;

export interface LayerEntry {
  id: string;
  path: string;
  author: string;
  created?: string;
}

export interface Provenance {
  parent?: { id: string; signingHash: string };
  generator?: string;
  history?: { action: string; at: string; by?: string; note?: string }[];
}

export interface Signature {
  alg: 'ed25519';
  publicKey: string;
  /** 64-byte ed25519 signature over the 32-byte signing hash, lowercase hex. */
  value: string;
}

export interface WgifManifest {
  $schema?: string;
  wgif: string;
  id: string;
  title: string;
  description?: string;
  creator: Creator;
  created: string;
  modified?: string;
  license?: string;
  mode: WorldMode;
  entry: EntryPoints;
  spawn?: { position: Vec3; lookAt?: Vec3 };
  units?: 'meters';
  requires?: string[];
  files: FileEntry[];
  models?: ModelEntry[];
  layers?: LayerEntry[];
  provenance?: Provenance;
  signature?: Signature;
  extensions?: Record<string, unknown>;
}

/** A manifest before packing: `files` is computed by the packer. */
export type ManifestInput = Omit<WgifManifest, 'files'> & { files?: Partial<FileEntry>[] };

export type WgifFiles = Record<string, Uint8Array>;

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  signature: 'absent' | 'valid' | 'invalid';
}

export interface WgifWorld {
  manifest: WgifManifest;
  /** Payload files keyed by container path (manifest.json excluded). */
  files: WgifFiles;
  report: ValidationReport;
}
