import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildCourtGlb, generateOrbitPreviewGif } from './court-builder.js';

export interface CourtBundleArtifacts {
  manifestJson: string;
  sceneGlb: Uint8Array;
  previewGif: Uint8Array;
  sha256Scene: string;
  sha256Preview: string;
}

export function buildReproducibleCourtArtifacts(): CourtBundleArtifacts {
  const sceneGlb = buildCourtGlb(0x57474946);
  const previewGif = generateOrbitPreviewGif(320, 200, 24);

  const sha256Scene = createHash('sha256').update(sceneGlb).digest('hex');
  const sha256Preview = createHash('sha256').update(previewGif).digest('hex');

  const manifest = {
    wgif_version: '0.1.0',
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

  return {
    manifestJson: JSON.stringify(manifest, null, 2) + '\n',
    sceneGlb,
    previewGif,
    sha256Scene,
    sha256Preview,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = resolve(process.cwd(), 'dist');
  mkdirSync(outDir, { recursive: true });
  const artifacts = buildReproducibleCourtArtifacts();
  writeFileSync(resolve(outDir, 'manifest.json'), artifacts.manifestJson);
  writeFileSync(resolve(outDir, 'court.glb'), artifacts.sceneGlb);
  writeFileSync(resolve(outDir, 'preview.gif'), artifacts.previewGif);
  console.log(
    `[pack:court] Built court.glb (${artifacts.sceneGlb.byteLength} B) + preview.gif (${artifacts.previewGif.byteLength} B)`
  );
}
