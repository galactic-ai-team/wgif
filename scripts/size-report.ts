#!/usr/bin/env node
/**
 * WGIF size report (Dee / OPTIMIZATION lane).
 *
 * Unpacks every .wgif in the repo and measures apps/player/dist, then prints
 * per-file raw + gzip + brotli sizes against scripts/size-budgets.json.
 *
 * The ZIP directory is parsed directly (no decompression) so we can report
 * BOTH the bytes shipped inside the container and the bytes a player must
 * hold in memory after inflating. Worlds that fail validation are still
 * measurable, which is the point: size is a property of the file, not of
 * whether the manifest happens to be correct today.
 *
 * Also folds in a static render analysis of the court's world.glb against
 * `renderBudget` (see scripts/render-report.ts and docs/PERF.md). Frame time
 * is NOT checked — that needs a GPU. Draw calls, triangles and texture
 * memory are static properties of the GLB and are.
 *
 * Usage:
 *   tsx scripts/size-report.ts [--root .] [--dist apps/player/dist]
 *                              [--budgets scripts/size-budgets.json]
 *                              [--json] [--summary <file>] [--soft] [--strict]
 *
 * Exit code 1 when any budget is exceeded (unless --soft).
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import path from "node:path";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
  inflateRawSync,
} from "node:zlib";
import type { GlbAnalysis, RenderBudget } from "./render-report.js";
import {
  analyzeGlb,
  checkRenderBudget,
  renderMarkdown as renderRenderMarkdown,
} from "./render-report.js";

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

/**
 * docs/spec/wgif-v0.1.md §2 reader safety ceilings + §6 model cap.
 * A violation here is a spec MUST: a compliant reader refuses the world.
 */
export interface SpecLimits {
  /** §2 ZIP entries, including manifest.json. */
  maxZipEntries: number;
  /** §2 uncompressed bytes per entry. */
  maxEntryUncompressedBytes: number;
  /** §2 combined uncompressed ZIP bytes. */
  maxCombinedUncompressedBytes: number;
  /** §2 uncompressed manifest.json. */
  maxManifestUncompressedBytes: number;
  /** §2 each referenced declarative JSON payload (interactions.json, game-state.json, …). */
  maxDeclarativeJsonUncompressedBytes: number;
  /** §6 each unpacked model under models/. */
  maxModelUncompressedBytes: number;
}

/**
 * Phase One targets from docs/BUDGETS.md. Over-target is spec-valid but
 * heavier than we want to ship — the report labels these as SHOULDs.
 */
export interface Budgets {
  version: number;
  worldTotalBytes: number;
  worldEntryBytes: Record<string, number>;
  worldEntryDefaultBytes: number;
  /** Larger per-entry budget for audio payloads (a 30-60 s track is 480-960 KB at 128 kbps). */
  audioEntryBytes: number;
  playerInitialJsGzipBytes: number;
  playerDeferredChunkGzipBytes: number;
  playerDistGzipBytes: number;
  playerRuntimeWasmGzipBytes: number;
  renderBudget: RenderBudget;
  specLimits: SpecLimits;
}

export function loadBudgets(absPath: string): Budgets {
  const raw = JSON.parse(readFileSync(absPath, "utf8")) as Partial<Budgets>;
  const required: (keyof Budgets)[] = [
    "worldTotalBytes",
    "worldEntryBytes",
    "worldEntryDefaultBytes",
    "audioEntryBytes",
    "playerInitialJsGzipBytes",
    "playerDeferredChunkGzipBytes",
    "playerDistGzipBytes",
    "playerRuntimeWasmGzipBytes",
    "renderBudget",
    "specLimits",
  ];
  for (const key of required) {
    if (raw[key] === undefined)
      throw new Error(`budgets: missing key "${key}" in ${absPath}`);
  }
  const renderBudget = raw.renderBudget as Partial<RenderBudget> | undefined;
  if (renderBudget) {
    const requiredRender: (keyof RenderBudget)[] = [
      "targetViewport",
      "maxDrawCalls",
      "maxTriangles",
      "maxTextureMemoryMiB",
      "targetFrameTimeMs",
    ];
    for (const k of requiredRender) {
      if (renderBudget[k] === undefined) {
        throw new Error(`budgets: missing "renderBudget.${k}" in ${absPath}`);
      }
    }
  }
  const specLimits = raw.specLimits as Partial<SpecLimits> | undefined;
  if (specLimits) {
    const requiredSpec: (keyof SpecLimits)[] = [
      "maxZipEntries",
      "maxEntryUncompressedBytes",
      "maxCombinedUncompressedBytes",
      "maxManifestUncompressedBytes",
      "maxDeclarativeJsonUncompressedBytes",
      "maxModelUncompressedBytes",
    ];
    for (const k of requiredSpec) {
      if (specLimits[k] === undefined) {
        throw new Error(`budgets: missing "specLimits.${k}" in ${absPath}`);
      }
    }
  }
  return raw as Budgets;
}

// ---------------------------------------------------------------------------
// zip directory reader (central directory only; no decompression)
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

export interface ZipEntry {
  name: string;
  /** Bytes the entry occupies inside the .wgif container. */
  storedBytes: number;
  /** Bytes after decompression: what the player must hold in memory. */
  expandedBytes: number;
  /** 0 = stored, 8 = deflate. */
  method: number;
  zip64: boolean;
  /** Offset of the local file header. Populated by readZipDirectory; used by locateGlb. */
  localHeaderOffset?: number;
}

export function readZipDirectory(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 22)
    throw new Error("not a zip: shorter than an EOCD record");

  // Scan backwards for the end-of-central-directory record (comment is <= 64 KiB).
  let eocd = -1;
  const stop = Math.max(0, buf.byteLength - 22 - 0xffff);
  for (let i = buf.byteLength - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new Error("not a zip: no end-of-central-directory record");

  const totalEntries = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff)
    throw new Error("zip64 archives are not supported by size-report");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > buf.byteLength) throw new Error("truncated central directory");
    if (dv.getUint32(p, true) !== CEN_SIG)
      throw new Error(`bad central directory signature at ${p}`);

    const method = dv.getUint16(p + 10, true);
    const compressed = dv.getUint32(p + 20, true);
    const uncompressed = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = new TextDecoder().decode(
      buf.subarray(p + 46, p + 46 + nameLen),
    );
    const zip64 = compressed === 0xffffffff || uncompressed === 0xffffffff;
    const localHeaderOffset = dv.getUint32(p + 42, true);

    entries.push({
      name,
      storedBytes: compressed,
      expandedBytes: uncompressed,
      method,
      zip64,
      localHeaderOffset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// measurement primitives
// ---------------------------------------------------------------------------

/** gzip at level 9 so the number is stable run-to-run regardless of host zlib. */
export function gzipBytes(buf: Uint8Array): number {
  return gzipSync(buf, { level: 9 }).byteLength;
}

/** Brotli q9: close to CDN reality without the multi-second q11 cost on 1 MiB. */
export function brotliBytes(buf: Uint8Array): number {
  return brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength,
    },
  }).byteLength;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Truly entropy-coded payloads: re-deflating them costs open-time CPU for ~0%
 * saving, so they SHOULD be stored (method 0).
 * Not on this list: .glb/.gltf. A GLB is a binary container, not a compressed
 * stream — deflate it normally.
 */
const PRECOMPRESSED =
  /\.(png|jpe?g|webp|avif|ktx2|mp3|ogg|opus|mp4|webm|woff2?|zip|gz|br)$/i;

/**
 * Audio payloads get their own, larger per-entry budget. A 30 s music track at 128 kbps is
 * ~480 KB, over the 256 KiB default entry budget; the 512 KiB cap covers about 32 s at that
 * bitrate. A 60 s track at 128 kbps (~960 KB) does not fit — it needs a lower bitrate or a
 * shorter cut.
 */
const AUDIO_ENTRY =
  /\.(mp3|ogg|opus|m4a|aac|wav|flac|webm|oga)$/i;

/**
 * Phase One budget for one world entry: an explicit worldEntryBytes ceiling
 * wins, then audio entries get audioEntryBytes, everything else the default.
 * Shared by the check, the markdown report and the CLI listing so they agree.
 */
export function entryBudget(budgets: Budgets, name: string): number {
  return (
    budgets.worldEntryBytes[name] ??
    (AUDIO_ENTRY.test(name)
      ? budgets.audioEntryBytes
      : budgets.worldEntryDefaultBytes)
  );
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "coverage",
  ".vite",
  ".turbo",
]);

export function findFiles(
  root: string,
  match: (rel: string) => boolean,
): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(path.join(dir, d.name), childRel);
      } else if (d.isFile() && match(childRel)) {
        out.push(childRel);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

// ---------------------------------------------------------------------------
// Vite manifest: which JS is in the initial graph
// ---------------------------------------------------------------------------

interface ViteManifestChunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

export type ViteManifest = Record<string, ViteManifestChunk>;

/** Vite 5 writes `.vite/manifest.json`; Vite 4 writes `manifest.json` at dist root. */
export function readViteManifest(distAbs: string): ViteManifest | null {
  for (const rel of [".vite/manifest.json", "manifest.json"]) {
    const abs = path.join(distAbs, rel);
    if (!existsSync(abs)) continue;
    try {
      return JSON.parse(readFileSync(abs, "utf8")) as ViteManifest;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Files reachable from any entry through static `imports`. Does NOT follow
 * `dynamicImports`. Manifest `imports` values are manifest *keys*, not paths.
 */
export function computeInitialFiles(manifest: ViteManifest): Set<string> {
  const initial = new Set<string>();
  const queue: ViteManifestChunk[] = [];
  for (const chunk of Object.values(manifest)) {
    if (chunk && chunk.isEntry) queue.push(chunk);
  }
  while (queue.length > 0) {
    const chunk = queue.shift();
    if (!chunk) break;
    if (initial.has(chunk.file)) continue;
    initial.add(chunk.file);
    for (const key of chunk.imports ?? []) {
      const child = manifest[key];
      if (child) queue.push(child);
    }
  }
  return initial;
}

// ---------------------------------------------------------------------------
// report model
// ---------------------------------------------------------------------------

export interface WorldReport {
  path: string;
  sha256: string;
  totalBytes: number;
  /** Brotli of the whole .wgif: what a host or chat app would actually transfer. */
  transferBytes: number;
  entries: ZipEntry[];
  notes: string[];
}

export interface DistFile {
  rel: string;
  bytes: number;
  gzip: number;
  brotli: number;
}

export interface PlayerReport {
  distDir: string;
  files: DistFile[];
  /** All JS (initial + deferred), gzip. */
  jsGzip: number;
  /** JS reachable from the entry's static `imports` graph, gzip. */
  jsInitialGzip: number;
  /** JS only reachable via `dynamicImports` (or unreferenced), gzip. */
  jsDeferredGzip: number;
  initial: DistFile[];
  deferred: DistFile[];
  /** Total gzip of `.wasm` / `.onnx` files. */
  wasmGzip: number;
  /**
   * Bytes of bundled sample worlds (`.wgif`, e.g. `samples/*.wgif`). They are content, not the
   * player, and each one is held to the per-world budgets, so they are not in `totalGzip`.
   */
  worldsBytes: number;
  totalGzip: number;
  manifestFound: boolean;
}

export type ViolationSeverity = "spec" | "phase-one";

export interface Violation {
  id: string;
  subject: string;
  actual: number;
  limit: number;
  message: string;
  /**
   * 'spec'      = MUST in docs/spec/wgif-v0.1.md. A reader refuses the world.
   * 'phase-one' = SHOULD in docs/BUDGETS.md. Spec-valid, over Phase One target.
   */
  severity: ViolationSeverity;
}

export interface SizeReport {
  worlds: WorldReport[];
  player: PlayerReport | null;
  render: { label: string; analysis: GlbAnalysis } | null;
  budgetsPath: string;
  duplicates: string[];
  warnings: string[];
}

export function measureWorld(root: string, rel: string): WorldReport {
  const abs = path.join(root, rel);
  const buf = readFileSync(abs);
  const entries = readZipDirectory(buf);
  const notes: string[] = [];

  const wasteful = entries.filter(
    (e) => e.method === 8 && PRECOMPRESSED.test(e.name),
  );
  if (wasteful.length > 0) {
    notes.push(
      `stored deflated: ${wasteful.map((e) => e.name).join(", ")} — already-compressed format, ` +
        "store it (method 0) to save open-time CPU at ~0% size cost",
    );
  }
  const largest = [...entries].sort(
    (a, b) => b.expandedBytes - a.expandedBytes,
  )[0];
  if (largest)
    notes.push(
      `largest entry: ${largest.name} (${formatBytes(largest.expandedBytes)} expanded)`,
    );

  return {
    path: rel,
    sha256: createHash("sha256").update(buf).digest("hex"),
    totalBytes: buf.byteLength,
    transferBytes: brotliBytes(buf),
    entries,
    notes,
  };
}

export function measurePlayer(distDir: string): PlayerReport | null {
  if (!existsSync(distDir)) return null;
  const rels = findFiles(
    distDir,
    (r) => !r.endsWith(".map") && !/^(.vite\/)?manifest\.json$/.test(r),
  );
  const files: DistFile[] = [];
  for (const rel of rels) {
    const buf = readFileSync(path.join(distDir, rel));
    files.push({
      rel,
      bytes: buf.byteLength,
      gzip: gzipBytes(buf),
      brotli: brotliBytes(buf),
    });
  }

  const manifest = readViteManifest(distDir);
  const jsFiles = files.filter((f) => f.rel.endsWith(".js"));
  // Service workers are fetched by the browser, not imported by the app, so
  // they are not chunks. Exclude them from the initial/deferred split so a
  // precached sw.js or Workbox runtime doesn't get flagged as an oversized
  // deferred chunk — but keep them in jsGzip/totalGzip, where they belong.
  const isServiceWorker = (rel: string): boolean =>
    /(^|\/)(sw\.js|workbox-[^/]*\.js)$/.test(rel);
  const chunkFiles = jsFiles.filter((f) => !isServiceWorker(f.rel));
  let initial: DistFile[];
  let deferred: DistFile[];
  if (manifest) {
    const initialSet = computeInitialFiles(manifest);
    initial = chunkFiles.filter((f) => initialSet.has(f.rel));
    deferred = chunkFiles.filter((f) => !initialSet.has(f.rel));
  } else {
    // No manifest: treat every chunk as initial so a lazy chunk can't dodge
    // the 300 KiB gate by staying unclassified. Set build.manifest: true.
    initial = chunkFiles;
    deferred = [];
  }

  const wasmFiles = files.filter((f) => /\.(wasm|onnx)$/i.test(f.rel));
  const worldFiles = files.filter((f) => /\.wgif$/i.test(f.rel));
  const codeFiles = files.filter((f) => !/\.(wasm|onnx|wgif)$/i.test(f.rel));

  return {
    distDir,
    files,
    initial,
    deferred,
    jsGzip: jsFiles.reduce((a, f) => a + f.gzip, 0),
    jsInitialGzip: initial.reduce((a, f) => a + f.gzip, 0),
    jsDeferredGzip: deferred.reduce((a, f) => a + f.gzip, 0),
    wasmGzip: wasmFiles.reduce((a, f) => a + f.gzip, 0),
    worldsBytes: worldFiles.reduce((a, f) => a + f.bytes, 0),
    totalGzip: codeFiles.reduce((a, f) => a + f.gzip, 0),
    manifestFound: manifest !== null,
  };
}

// ---------------------------------------------------------------------------
// GLB location (for render analysis)
// ---------------------------------------------------------------------------

export interface LocatedGlb {
  label: string;
  buf: Uint8Array;
}

/**
 * Find a GLB for render analysis. Prefers a loose examples/court/world.glb;
 * falls back to extracting world.glb from examples/court/court.wgif.
 * Returns null if neither exists — a fresh checkout before `npm run pack:court`.
 */
export function locateGlb(root: string): LocatedGlb | null {
  for (const rel of ["examples/court/world.glb", "examples/court/court.glb"]) {
    const abs = path.join(root, rel);
    if (existsSync(abs)) return { label: rel, buf: readFileSync(abs) };
  }
  const wgifRel = "examples/court/court.wgif";
  const wgifAbs = path.join(root, wgifRel);
  if (!existsSync(wgifAbs)) return null;
  const buf = readFileSync(wgifAbs);

  let entries: ZipEntry[];
  try {
    entries = readZipDirectory(buf);
  } catch {
    return null;
  }
  const entry = entries.find((e) => e.name === "world.glb");
  if (!entry || entry.localHeaderOffset === undefined) return null;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lh = entry.localHeaderOffset;
  if (dv.getUint32(lh, true) !== 0x04034b50) return null;
  const nameLen = dv.getUint16(lh + 26, true);
  const extraLen = dv.getUint16(lh + 28, true);
  const dataStart = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.storedBytes);

  let extracted: Uint8Array;
  if (entry.method === 0) extracted = raw;
  else if (entry.method === 8) extracted = new Uint8Array(inflateRawSync(raw));
  else return null;

  return { label: `${wgifRel} → world.glb`, buf: extracted };
}

// ---------------------------------------------------------------------------
// budget checks
// ---------------------------------------------------------------------------

/**
 * Spec MUST checks: docs/spec/wgif-v0.1.md §2 + §6. A violation here means a
 * compliant reader refuses the world. Run on every `.wgif` in the repo.
 */
export function checkSpecLimits(
  report: SizeReport,
  limits: SpecLimits,
): Violation[] {
  const v: Violation[] = [];

  for (const w of report.worlds) {
    if (w.entries.length > limits.maxZipEntries) {
      v.push({
        id: "spec.entries",
        subject: w.path,
        actual: w.entries.length,
        limit: limits.maxZipEntries,
        severity: "spec",
        message: `${w.path}: ${w.entries.length} ZIP entries > spec ceiling ${limits.maxZipEntries} (§2)`,
      });
    }

    for (const e of w.entries) {
      if (e.expandedBytes > limits.maxEntryUncompressedBytes) {
        v.push({
          id: `spec.entry:${e.name}`,
          subject: w.path,
          actual: e.expandedBytes,
          limit: limits.maxEntryUncompressedBytes,
          severity: "spec",
          message: `${w.path} → ${e.name}: ${formatBytes(e.expandedBytes)} > spec per-entry ceiling ${formatBytes(limits.maxEntryUncompressedBytes)} (§2)`,
        });
      }
    }

    const combined = w.entries.reduce((a, e) => a + e.expandedBytes, 0);
    if (combined > limits.maxCombinedUncompressedBytes) {
      v.push({
        id: "spec.combined",
        subject: w.path,
        actual: combined,
        limit: limits.maxCombinedUncompressedBytes,
        severity: "spec",
        message: `${w.path}: combined ${formatBytes(combined)} > spec ceiling ${formatBytes(limits.maxCombinedUncompressedBytes)} (§2)`,
      });
    }

    const manifest = w.entries.find((e) => e.name === "manifest.json");
    if (
      manifest &&
      manifest.expandedBytes > limits.maxManifestUncompressedBytes
    ) {
      v.push({
        id: "spec.manifest",
        subject: w.path,
        actual: manifest.expandedBytes,
        limit: limits.maxManifestUncompressedBytes,
        severity: "spec",
        message: `${w.path} → manifest.json: ${formatBytes(manifest.expandedBytes)} > spec ceiling ${formatBytes(limits.maxManifestUncompressedBytes)} (§2)`,
      });
    }

    for (const e of w.entries) {
      if (e.name === "manifest.json") continue;
      if (e.name.startsWith("models/")) continue; // handled by model check below
      if (!e.name.endsWith(".json")) continue;
      if (e.expandedBytes > limits.maxDeclarativeJsonUncompressedBytes) {
        v.push({
          id: `spec.json:${e.name}`,
          subject: w.path,
          actual: e.expandedBytes,
          limit: limits.maxDeclarativeJsonUncompressedBytes,
          severity: "spec",
          message: `${w.path} → ${e.name}: ${formatBytes(e.expandedBytes)} > spec declarative-JSON ceiling ${formatBytes(limits.maxDeclarativeJsonUncompressedBytes)} (§2)`,
        });
      }
    }

    for (const e of w.entries) {
      if (!e.name.startsWith("models/")) continue;
      if (e.expandedBytes > limits.maxModelUncompressedBytes) {
        v.push({
          id: `spec.model:${e.name}`,
          subject: w.path,
          actual: e.expandedBytes,
          limit: limits.maxModelUncompressedBytes,
          severity: "spec",
          message: `${w.path} → ${e.name}: ${formatBytes(e.expandedBytes)} > spec model ceiling ${formatBytes(limits.maxModelUncompressedBytes)} (§6)`,
        });
      }
    }
  }

  return v;
}

/**
 * Phase One target checks: docs/BUDGETS.md. Over-target is spec-valid but
 * heavier than we want to ship; the report labels these SHOULDs.
 */
export function checkPhaseOneBudgets(
  report: SizeReport,
  budgets: Budgets,
): Violation[] {
  const v: Violation[] = [];

  for (const w of report.worlds) {
    if (w.totalBytes > budgets.worldTotalBytes) {
      v.push({
        id: "world.total",
        subject: w.path,
        actual: w.totalBytes,
        limit: budgets.worldTotalBytes,
        severity: "phase-one",
        message: `${w.path}: ${formatBytes(w.totalBytes)} > Phase One target ${formatBytes(budgets.worldTotalBytes)}`,
      });
    }
    // Entry-count is spec §2 exactly, checked in checkSpecLimits.
    for (const e of w.entries) {
      const limit = entryBudget(budgets, e.name);
      if (e.expandedBytes > limit) {
        v.push({
          id: `world.entry:${e.name}`,
          subject: w.path,
          actual: e.expandedBytes,
          limit,
          severity: "phase-one",
          message: `${w.path} → ${e.name}: ${formatBytes(e.expandedBytes)} > Phase One target ${formatBytes(limit)}`,
        });
      }
    }
  }

  if (report.player) {
    const p = report.player;
    if (p.jsInitialGzip > budgets.playerInitialJsGzipBytes) {
      v.push({
        id: "player.initial",
        subject: p.distDir,
        actual: p.jsInitialGzip,
        limit: budgets.playerInitialJsGzipBytes,
        severity: "phase-one",
        message: `initial JS ${formatBytes(p.jsInitialGzip)} gzip > ${formatBytes(budgets.playerInitialJsGzipBytes)}`,
      });
    }
    for (const f of p.deferred) {
      if (f.gzip <= budgets.playerDeferredChunkGzipBytes) continue;
      v.push({
        id: "player.deferredChunk",
        subject: f.rel,
        actual: f.gzip,
        limit: budgets.playerDeferredChunkGzipBytes,
        severity: "phase-one",
        message: `deferred chunk ${f.rel}: ${formatBytes(f.gzip)} gzip > ${formatBytes(budgets.playerDeferredChunkGzipBytes)}`,
      });
    }
    if (p.wasmGzip > budgets.playerRuntimeWasmGzipBytes) {
      v.push({
        id: "player.wasm",
        subject: p.distDir,
        actual: p.wasmGzip,
        limit: budgets.playerRuntimeWasmGzipBytes,
        severity: "phase-one",
        message:
          `runtime WASM/models ${formatBytes(p.wasmGzip)} gzip > ${formatBytes(budgets.playerRuntimeWasmGzipBytes)}` +
          (budgets.playerRuntimeWasmGzipBytes === 0
            ? " (Phase One forbids runtime WASM; a nonzero budget is a spec decision)"
            : ""),
      });
    }
    if (p.totalGzip > budgets.playerDistGzipBytes) {
      v.push({
        id: "player.dist",
        subject: p.distDir,
        actual: p.totalGzip,
        limit: budgets.playerDistGzipBytes,
        severity: "phase-one",
        message: `player dist ${formatBytes(p.totalGzip)} gzip > ${formatBytes(budgets.playerDistGzipBytes)}`,
      });
    }
  }

  if (report.render) {
    for (const rv of checkRenderBudget(
      report.render.analysis,
      budgets.renderBudget,
      report.render.label,
    )) {
      v.push({ ...rv, severity: "phase-one" });
    }
  }

  return v;
}

/**
 * Orchestrator: spec MUSTs first, then Phase One SHOULDs. Both still fail CI.
 * Distinguish by `Violation.severity`.
 */
export function checkBudgets(
  report: SizeReport,
  budgets: Budgets,
): Violation[] {
  return [
    ...checkSpecLimits(report, budgets.specLimits),
    ...checkPhaseOneBudgets(report, budgets),
  ];
}

export function buildReport(opts: {
  root: string;
  dist: string;
  budgetsPath: string;
}): SizeReport {
  const warnings: string[] = [];
  const duplicates: string[] = [];

  // Prefer the canonical copy over the one baked into the player's dist.
  const wgifRels = findFiles(opts.root, (rel) => rel.endsWith(".wgif")).sort(
    (a, b) => {
      const ad = a.includes("/dist/") ? 1 : 0;
      const bd = b.includes("/dist/") ? 1 : 0;
      return ad - bd || a.localeCompare(b);
    },
  );

  const seen = new Map<string, string>();
  const worlds: WorldReport[] = [];
  for (const rel of wgifRels) {
    let world: WorldReport;
    try {
      world = measureWorld(opts.root, rel);
    } catch (err) {
      warnings.push(`${rel}: ${(err as Error).message}`);
      continue;
    }
    const first = seen.get(world.sha256);
    if (first) {
      duplicates.push(`${rel} (identical to ${first})`);
      continue;
    }
    seen.set(world.sha256, rel);
    worlds.push(world);
  }

  const player = measurePlayer(path.join(opts.root, opts.dist));
  if (!player)
    warnings.push(
      `player dist not found at ${opts.dist} — run \`npm run build\` first`,
    );

  let render: SizeReport["render"] = null;
  const located = locateGlb(opts.root);
  if (located) {
    try {
      render = { label: located.label, analysis: analyzeGlb(located.buf) };
    } catch (err) {
      warnings.push(
        `render: could not analyze ${located.label}: ${(err as Error).message}`,
      );
    }
  } else {
    warnings.push(
      "render: no GLB found (examples/court/world.glb or world.glb inside examples/court/court.wgif) — run `npm run pack:court` to build the court world",
    );
  }

  return {
    worlds,
    player,
    render,
    budgetsPath: opts.budgetsPath,
    duplicates,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function status(actual: number, limit: number): string {
  const pct = limit > 0 ? (actual / limit) * 100 : 0;
  return actual > limit ? `❌ ${pct.toFixed(0)}%` : `✅ ${pct.toFixed(0)}%`;
}

export function renderMarkdown(
  report: SizeReport,
  budgets: Budgets,
  violations: Violation[],
): string {
  const L: string[] = [];
  L.push("## WGIF size report");
  L.push("");
  L.push(
    `Budgets: \`${report.budgetsPath}\` · documented in \`docs/BUDGETS.md\``,
  );
  L.push("");

  L.push("### Worlds");
  L.push("");
  if (report.worlds.length === 0) {
    L.push("_No .wgif files found._");
  } else {
    L.push(
      "| World | In container | Budget | Status | Expanded | Transfer (brotli) |",
    );
    L.push("|---|---:|---:|---:|---:|---:|");
    for (const w of report.worlds) {
      const expanded = w.entries.reduce((a, e) => a + e.expandedBytes, 0);
      L.push(
        `| \`${w.path}\` | ${formatBytes(w.totalBytes)} | ${formatBytes(budgets.worldTotalBytes)} | ` +
          `${status(w.totalBytes, budgets.worldTotalBytes)} | ${formatBytes(expanded)} | ${formatBytes(w.transferBytes)} |`,
      );
    }
    L.push("");
    for (const w of report.worlds) {
      L.push(
        `<details><summary><code>${w.path}</code> — ${w.entries.length} entries</summary>`,
      );
      L.push("");
      L.push("| Entry | Method | Stored | Expanded | Budget | Status |");
      L.push("|---|---|---:|---:|---:|---:|");
      for (const e of w.entries) {
        const limit = entryBudget(budgets, e.name);
        L.push(
          `| \`${e.name}\` | ${e.method === 8 ? "deflate" : e.method === 0 ? "store" : e.method} | ` +
            `${formatBytes(e.storedBytes)} | ${formatBytes(e.expandedBytes)} | ${formatBytes(limit)} | ` +
            `${status(e.expandedBytes, limit)} |`,
        );
      }
      L.push("");
      for (const n of w.notes) L.push(`- ${n}`);
      L.push("");
      L.push("</details>");
      L.push("");
    }
  }

  L.push("### Player bundle");
  L.push("");
  if (!report.player) {
    L.push("_Player dist not measured._");
  } else {
    const p = report.player;
    L.push(
      `Initial JS (gzip): **${formatBytes(p.jsInitialGzip)}** / ${formatBytes(budgets.playerInitialJsGzipBytes)} — ${status(p.jsInitialGzip, budgets.playerInitialJsGzipBytes)}`,
    );
    L.push("");
    if (p.deferred.length > 0) {
      L.push(
        `Deferred JS: ${p.deferred.length} chunk${p.deferred.length === 1 ? "" : "s"}, **${formatBytes(p.jsDeferredGzip)}** gzip total`,
      );
      L.push("");
      L.push("| Deferred chunk | gzip | per-chunk budget | Status |");
      L.push("|---|---:|---:|---:|");
      for (const f of p.deferred) {
        L.push(
          `| \`${f.rel}\` | ${formatBytes(f.gzip)} | ${formatBytes(budgets.playerDeferredChunkGzipBytes)} | ${status(f.gzip, budgets.playerDeferredChunkGzipBytes)} |`,
        );
      }
      L.push("");
    }
    L.push(
      `Runtime WASM/models (gzip): **${formatBytes(p.wasmGzip)}** / ${formatBytes(budgets.playerRuntimeWasmGzipBytes)} — ${status(p.wasmGzip, budgets.playerRuntimeWasmGzipBytes)}`,
    );
    L.push("");
    L.push(
      `Total dist (gzip, excl. .map, runtime WASM and sample .wgif worlds): **${formatBytes(p.totalGzip)}** / ${formatBytes(budgets.playerDistGzipBytes)} — ${status(p.totalGzip, budgets.playerDistGzipBytes)}` +
        (p.worldsBytes ? ` · sample worlds ${formatBytes(p.worldsBytes)} (each held to the world budgets)` : ""),
    );
    if (!p.manifestFound) {
      L.push("");
      L.push(
        "> ⚠️ No Vite manifest found — every JS file was classified as initial. Set `build.manifest: true` in `apps/player/vite.config.ts` for an accurate initial/deferred split.",
      );
    }
    L.push("");
    const top = [...p.files].sort((a, b) => b.gzip - a.gzip).slice(0, 12);
    L.push("| File | Raw | gzip | brotli |");
    L.push("|---|---:|---:|---:|");
    for (const f of top) {
      L.push(
        `| \`${f.rel}\` | ${formatBytes(f.bytes)} | ${formatBytes(f.gzip)} | ${formatBytes(f.brotli)} |`,
      );
    }
  }

  if (report.render) {
    L.push("");
    const renderViolations = checkRenderBudget(
      report.render.analysis,
      budgets.renderBudget,
      report.render.label,
    );
    L.push(
      renderRenderMarkdown(
        report.render.analysis,
        budgets.renderBudget,
        renderViolations,
        report.render.label,
      ),
    );
  }

  if (report.duplicates.length > 0) {
    L.push("");
    L.push("### Duplicate worlds (skipped)");
    L.push("");
    for (const d of report.duplicates) L.push(`- ${d}`);
  }
  if (report.warnings.length > 0) {
    L.push("");
    L.push("### Warnings");
    L.push("");
    for (const w of report.warnings) L.push(`- ${w}`);
  }

  L.push("");
  if (violations.length === 0) {
    L.push("### ✅ All budgets met");
  } else {
    const specV = violations.filter((v) => v.severity === "spec");
    const phaseOneV = violations.filter((v) => v.severity !== "spec");
    L.push(`### ❌ ${violations.length} budget violation(s)`);
    if (specV.length > 0) {
      L.push("");
      L.push(`#### Spec violations (MUST) — ${specV.length}`);
      L.push("");
      L.push(
        "`docs/spec/wgif-v0.1.md` §2/§6. A compliant reader refuses these worlds.",
      );
      L.push("");
      for (const x of specV) L.push(`- **${x.id}** — ${x.message}`);
    }
    if (phaseOneV.length > 0) {
      L.push("");
      L.push(`#### Phase One target violations (SHOULD) — ${phaseOneV.length}`);
      L.push("");
      L.push(
        "Spec-valid, but over the `docs/BUDGETS.md` Phase One optimization targets.",
      );
      L.push("");
      for (const x of phaseOneV) L.push(`- **${x.id}** — ${x.message}`);
    }
  }
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface Options {
  root: string;
  dist: string;
  budgetsPath: string;
  json: boolean;
  summaryPath: string | null;
  soft: boolean;
  strict: boolean;
}

export function parseArgs(argv: string[], cwd: string): Options {
  const o: Options = {
    root: cwd,
    dist: "apps/player/dist",
    budgetsPath: "scripts/size-budgets.json",
    json: false,
    summaryPath: null,
    soft: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--root":
        o.root = path.resolve(cwd, next());
        break;
      case "--dist":
        o.dist = next();
        break;
      case "--budgets":
        o.budgetsPath = next();
        break;
      case "--json":
        o.json = true;
        break;
      case "--summary":
        o.summaryPath = next();
        break;
      case "--soft":
        o.soft = true;
        break;
      case "--strict":
        o.strict = true;
        break;
      case "-h":
      case "--help":
        o.root = "__help__";
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return o;
}

const HELP = `size-report — WGIF size budgets

  --root <dir>      repo root (default: cwd)
  --dist <dir>      player dist, relative to root (default: apps/player/dist)
  --budgets <file>  budgets JSON, relative to root (default: scripts/size-budgets.json)
  --json            machine-readable output
  --summary <file>  also append a markdown section (use $GITHUB_STEP_SUMMARY in CI)
  --soft            never exit non-zero
  --strict          exit non-zero if the player dist is missing
`;

export function main(argv: string[], cwd: string): number {
  let opts: Options;
  try {
    opts = parseArgs(argv, cwd);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (opts.root === "__help__") {
    console.log(HELP);
    return 0;
  }

  const budgetsAbs = path.resolve(opts.root, opts.budgetsPath);
  const budgets = loadBudgets(budgetsAbs);
  const report = buildReport({
    root: opts.root,
    dist: opts.dist,
    budgetsPath: opts.budgetsPath,
  });
  const violations = checkBudgets(report, budgets);

  if (opts.json) {
    console.log(JSON.stringify({ report, budgets, violations }, null, 2));
  } else {
    for (const w of report.worlds) {
      console.log(
        `${w.path}: ${formatBytes(w.totalBytes)} (budget ${formatBytes(budgets.worldTotalBytes)})`,
      );
      for (const e of w.entries) {
        const limit = entryBudget(budgets, e.name);
        console.log(
          `  ${e.name.padEnd(28)} ${formatBytes(e.expandedBytes).padStart(10)}  / ${formatBytes(limit)}`,
        );
      }
      for (const n of w.notes) console.log(`  · ${n}`);
    }
    if (report.player) {
      const p = report.player;
      console.log(
        `player JS: initial ${formatBytes(p.jsInitialGzip)} / ${formatBytes(budgets.playerInitialJsGzipBytes)}` +
          `  ·  deferred ${formatBytes(p.jsDeferredGzip)} in ${p.deferred.length} chunk(s)` +
          `  ·  wasm ${formatBytes(p.wasmGzip)} / ${formatBytes(budgets.playerRuntimeWasmGzipBytes)}` +
          `  ·  dist ${formatBytes(p.totalGzip)} gzip` +
          (p.worldsBytes ? ` (+ ${formatBytes(p.worldsBytes)} of sample worlds, budgeted per world)` : ""),
      );
    }
    if (report.render) {
      const r = report.render.analysis;
      const memMiB = r.textureMemoryBytes / (1024 * 1024);
      console.log(
        `render: ${report.render.label}` +
          `  ·  draw calls ${r.drawCalls} / ${budgets.renderBudget.maxDrawCalls}` +
          `  ·  triangles ${r.triangles.toLocaleString("en-US")} / ${budgets.renderBudget.maxTriangles.toLocaleString("en-US")}` +
          `  ·  texture ${memMiB.toFixed(2)} MiB / ${budgets.renderBudget.maxTextureMemoryMiB} MiB`,
      );
    }
    for (const w of report.warnings) console.log(`warning: ${w}`);
    console.log(
      violations.length === 0
        ? "all budgets met"
        : `${violations.length} violation(s):`,
    );
    for (const x of violations) {
      const tag = x.severity === "spec" ? "[spec]" : "[phase-one]";
      console.log(`  ✗ ${tag} ${x.message}`);
    }
  }

  if (opts.summaryPath) {
    appendFileSync(
      opts.summaryPath,
      renderMarkdown(report, budgets, violations) + "\n",
    );
  }

  if (!report.player && opts.strict) return 1;
  if (violations.length > 0 && !opts.soft) return 1;
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  /size-report\.(ts|js|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
