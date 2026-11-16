import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../../../examples/court/src/prng.js';
import { buildWorldFromImage } from './img2world.js';
import { decodePngToRgba } from './png-decode.js';

export async function runCli(argv: string[]): Promise<void> {
  let inPath: string | undefined;
  let outPath = 'examples/img2world-sample.wgif';
  let syntheticDepth = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--input' || arg === '-i') && argv[i + 1]) {
      inPath = argv[++i]!;
    } else if ((arg === '--output' || arg === '-o') && argv[i + 1]) {
      outPath = argv[++i]!;
    } else if (arg === '--synthetic-depth') {
      syntheticDepth = true;
    }
  }

  let width = 128;
  let height = 96;
  let rgba: Uint8Array;

  if (inPath) {
    const absIn = resolve(process.cwd(), inPath);
    const fileBytes = new Uint8Array(readFileSync(absIn));
    const decoded = decodePngToRgba(fileBytes);
    width = decoded.width;
    height = decoded.height;
    rgba = decoded.rgba;
  } else {
    rgba = new Uint8Array(width * height * 4);
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
  }

  const gridW = Math.min(64, Math.max(8, width));
  const gridH = Math.min(64, Math.max(8, height));

  const result = await buildWorldFromImage({
    imageRgba: rgba,
    width,
    height,
    gridWidth: gridW,
    gridHeight: gridH,
    syntheticDepth,
  });

  const absOut = resolve(process.cwd(), outPath);
  mkdirSync(dirname(absOut), { recursive: true });
  writeFileSync(absOut, result.wgifBytes);
  console.log(
    `[img2world] Wrote ${absOut} (${result.wgifBytes.byteLength} B, generator=${result.manifest.provenance.generator})`
  );
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}