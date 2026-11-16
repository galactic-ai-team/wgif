import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../../../examples/court/src/prng.js';
import { buildWorldFromImage } from './img2world.js';

export async function runCli(argv: string[]): Promise<void> {
  let outPath = 'examples/img2world-sample.wgif';
  let syntheticDepth = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' && argv[i + 1]) {
      outPath = argv[++i]!;
    } else if (arg === '--synthetic-depth') {
      syntheticDepth = true;
    }
  }

  // Generate a procedural sample outdoor court scene RGBA image (128x96) if no external decoder is used
  const width = 128;
  const height = 96;
  const rgba = new Uint8Array(width * height * 4);
  const rand = mulberry32(0x494d4732);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const isSky = y < height * 0.42;
      rgba[idx] = isSky ? 48 : Math.min(255, 165 + Math.floor(rand() * 20));
      rgba[idx + 1] = isSky ? 82 : Math.min(255, 118 + Math.floor(rand() * 16));
      rgba[idx + 2] = isSky ? 148 : 74;
      rgba[idx + 3] = 255;
    }
  }

  const result = await buildWorldFromImage({
    imageRgba: rgba,
    width,
    height,
    gridWidth: 48,
    gridHeight: 36,
    syntheticDepth,
  });

  const absOut = resolve(process.cwd(), outPath);
  mkdirSync(dirname(absOut), { recursive: true });
  writeFileSync(absOut, result.wgifBytes);
  console.log(
    `[img2world] Wrote ${absOut} (${result.wgifBytes.byteLength} B, model=${result.manifest.provenance.generator.model?.id})`
  );
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}