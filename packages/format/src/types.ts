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

export interface ModelEntry {
  id: string;
  path: string;
  runtime: 'rules' | 'onnx';
  purpose?: string;
  [extra: string]: unknown;
}

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
