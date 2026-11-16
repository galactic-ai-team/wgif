import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildCourtGlb, generateOrbitPreviewGif } from './court-builder.js';
import { crc32, zlibCompressDeterministic } from './prng.js';

export interface SpecV01Manifest {
  wgif_version: '0.1';
  id: string;
  title: string;
  description: string;
  created_at: string;
  license: string;
  entrypoints: {
    scene: string;
    preview: string;
  };
  camera: {
    default_mode: 'walk' | 'orbit';
    spawn: {
      position: [number, number, number];
      target: [number, number, number];
      fov_deg: number;
    };
    bounds: {
      min: [number, number, number];
      max: [number, number, number];
    };
  };
  provenance: {
    origin: 'procedural' | 'image-to-world' | 'handcrafted';
    generator: {
      name: string;
      version: string;
      seed?: number;
      model?: {
        id: string;
        license: string;
      };
      parameters?: Record<string, unknown>;
    };
    source_inputs?: Array<{
      role: string;
      mime_type: string;
      sha256: string;
      dimensions: [number, number];
    }>;
    assets: Array<{
      path: string;
      sha256: string;
    }>;
  };
}

export interface CourtBundleArtifacts {
  manifest: SpecV01Manifest;
  manifestJson: string;
  sceneGlb: Uint8Array;
  previewGif: Uint8Array;
  wgifBytes: Uint8Array;
  sha256Scene: string;
  sha256Preview: string;
  sha256Wgif: string;
}

/**
 * Deterministic ZIP container packer for `.wgif` archives.
 * Uses fixed DOS timestamp (1980-01-01 00:00:00) and sorted entry order:
 *   1. manifest.json
 *   2. preview.gif
 *   3. scene/*.glb
 */
export function packDeterministicWgifZip(
  files: Array<{ path: string; data: Uint8Array }>
): Uint8Array {
  const localHeaders: Uint8Array[] = [];
  const centralHeaders: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.path);
    const uncompressedCrc = crc32(file.data);
    // Strip 2-byte ZLIB header and 4-byte Adler32 trailer to get raw RFC 1951 DEFLATE stream
    const zlibStream = zlibCompressDeterministic(file.data);
    const deflated = zlibStream.subarray(2, zlibStream.length - 4);

    const useStore = deflated.length >= file.data.length;
    const payload = useStore ? file.data : deflated;
    const method = useStore ? 0 : 8;

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed (2.0)
    lv.setUint16(6, 0, true); // Flags
    lv.setUint16(8, method, true); // Compression method
    lv.setUint16(10, 0, true); // Fixed DOS time 00:00:00
    lv.setUint16(12, 0x0021, true); // Fixed DOS date 1980-01-01
    lv.setUint32(14, uncompressedCrc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    localHeaders.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory signature
    cv.setUint16(4, 20, true); // Version made by
    cv.setUint16(6, 20, true); // Version needed
    cv.setUint16(8, 0, true); // Flags
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true); // DOS time
    cv.setUint16(14, 0x0021, true); // DOS date
    cv.setUint32(16, uncompressedCrc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centralHeaders.push(central);

    localOffset += local.length;
  }

  let cdSize = 0;
  for (const c of centralHeaders) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, localOffset, true);
  ev.setUint16(20, 0, true);

  const out = new Uint8Array(localOffset + cdSize + 22);
  let pos = 0;
  for (const l of localHeaders) {
    out.set(l, pos);
    pos += l.length;
  }
  for (const c of centralHeaders) {
    out.set(c, pos);
    pos += c.length;
  }
  out.set(eocd, pos);
  return out;
}

export function buildReproducibleCourtArtifacts(): CourtBundleArtifacts {
  const sceneGlb = buildCourtGlb(0x57474946);
  const previewGif = generateOrbitPreviewGif(320, 200, 24);

  const sha256Scene = createHash('sha256').update(sceneGlb).digest('hex');
  const sha256Preview = createHash('sha256').update(previewGif).digest('hex');

  const manifest: SpecV01Manifest = {
    wgif_version: '0.1',
    id: 'urn:wgif:galactic-ai:examples:court-v1',
    title: 'Galactic Hardwood Arena (Procedural Phase 1)',
    description:
      'Handcrafted deterministic 3D basketball court with procedural maple planks, regulation lines, tapered diamond rim nets, arena walls, and stadium lights.',
    created_at: '2026-01-01T00:00:00.000Z',
    license: 'MIT',
    entrypoints: {
      scene: 'scene/court.glb',
      preview: 'preview.gif',
    },
    camera: {
      default_mode: 'walk',
      spawn: {
        position: [0, 1.7, 9.2],
        target: [0, 1.5, 0],
        fov_deg: 60,
      },
      bounds: {
        min: [-15.2, 0.2, -8.8],
        max: [15.2, 6.5, 8.8],
      },
    },
    provenance: {
      origin: 'procedural',
      generator: {
        name: '@wgif/court-builder',
        version: '0.1.0',
        seed: 1464293702,
      },
      assets: [
        { path: 'scene/court.glb', sha256: sha256Scene },
        { path: 'preview.gif', sha256: sha256Preview },
      ],
    },
  };

  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  const manifestBytes = new TextEncoder().encode(manifestJson);

  const wgifBytes = packDeterministicWgifZip([
    { path: 'manifest.json', data: manifestBytes },
    { path: 'preview.gif', data: previewGif },
    { path: 'scene/court.glb', data: sceneGlb },
  ]);

  const sha256Wgif = createHash('sha256').update(wgifBytes).digest('hex');

  return {
    manifest,
    manifestJson,
    sceneGlb,
    previewGif,
    wgifBytes,
    sha256Scene,
    sha256Preview,
    sha256Wgif,
  };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  const here = dirname(currentFile);
  const repoRoot = resolve(here, '../../..');
  const artifacts = buildReproducibleCourtArtifacts();

  // Write canonical examples/court.wgif and examples/court/court.wgif
  const rootExamplesWgif = resolve(repoRoot, 'examples/court.wgif');
  const pkgCourtWgif = resolve(repoRoot, 'examples/court/court.wgif');
  const distDir = resolve(repoRoot, 'examples/court/dist');

  mkdirSync(dirname(rootExamplesWgif), { recursive: true });
  mkdirSync(distDir, { recursive: true });

  writeFileSync(rootExamplesWgif, artifacts.wgifBytes);
  writeFileSync(pkgCourtWgif, artifacts.wgifBytes);
  writeFileSync(resolve(distDir, 'manifest.json'), artifacts.manifestJson);
  writeFileSync(resolve(distDir, 'court.glb'), artifacts.sceneGlb);
  writeFileSync(resolve(distDir, 'preview.gif'), artifacts.previewGif);

  console.log(
    `[pack:court] Built deterministic examples/court.wgif (${artifacts.wgifBytes.byteLength} B, sha256=${artifacts.sha256Wgif.slice(0, 12)}…)`
  );
}