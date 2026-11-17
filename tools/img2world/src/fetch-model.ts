/**
 * One-time offline model bootstrap for `tools/img2world`.
 * Downloads `onnx-community/depth-anything-v2-small` (Apache-2.0, ViT-S q8 quantized)
 * into `.cache/models/onnx-community/depth-anything-v2-small/` and verifies SHA-256 digests.
 *
 * Runtime (`img2world.ts`) sets `allowRemoteModels = false` and never accesses the network.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PinnedModelArtifact {
  relativePath: string;
  url: string;
  sha256: string;
  approxBytes: number;
}

export interface PinnedModelSpec {
  id: string;
  revision: string;
  license: 'Apache-2.0';
  cacheSubdir: string;
  artifacts: PinnedModelArtifact[];
}

const HF_BASE =
  'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main';

export const PINNED_DEPTH_MODEL: PinnedModelSpec = {
  id: 'onnx-community/depth-anything-v2-small',
  revision: 'main',
  license: 'Apache-2.0',
  cacheSubdir: '.cache/models/onnx-community/depth-anything-v2-small',
  artifacts: [
    {
      relativePath: 'config.json',
      url: `${HF_BASE}/config.json`,
      sha256: 'e0d494957db52e7e7a8c50339f9a789d763598a098a359ef2417121b91811316',
      approxBytes: 1054,
    },
    {
      relativePath: 'preprocessor_config.json',
      url: `${HF_BASE}/preprocessor_config.json`,
      sha256: 'c2f62165214a97d7f46166a352c15d0b51672b6f6a667275a45f93c11653c382',
      approxBytes: 438,
    },
    {
      relativePath: 'onnx/model_quantized.onnx',
      url: `${HF_BASE}/onnx/model_quantized.onnx`,
      sha256: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
      approxBytes: 25412896,
    },
  ],
};

export function computeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyPinnedModelBytes(
  bytes: Uint8Array,
  expectedSha256: string
): boolean {
  const actual = computeSha256Hex(bytes);
  return actual.toLowerCase() === expectedSha256.toLowerCase();
}

export function verifyCachedModel(rootDir = process.cwd()): {
  ready: boolean;
  missingOrInvalid: string[];
} {
  const baseDir = resolve(rootDir, PINNED_DEPTH_MODEL.cacheSubdir);
  const missingOrInvalid: string[] = [];

  for (const art of PINNED_DEPTH_MODEL.artifacts) {
    const fullPath = resolve(baseDir, art.relativePath);
    if (!existsSync(fullPath)) {
      missingOrInvalid.push(`${art.relativePath} (missing)`);
      continue;
    }
    const bytes = new Uint8Array(readFileSync(fullPath));
    if (!verifyPinnedModelBytes(bytes, art.sha256)) {
      missingOrInvalid.push(`${art.relativePath} (sha256 mismatch)`);
    }
  }

  return {
    ready: missingOrInvalid.length === 0,
    missingOrInvalid,
  };
}

export async function fetchAndPinModel(
  options: { rootDir?: string; allowUnverifiedHashUpdate?: boolean } = {}
): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const baseDir = resolve(rootDir, PINNED_DEPTH_MODEL.cacheSubdir);

  const status = verifyCachedModel(rootDir);
  if (status.ready) {
    console.log(
      `[img2world:fetch-model] Cached model ${PINNED_DEPTH_MODEL.id} (${PINNED_DEPTH_MODEL.license}) already verified at ${baseDir}`
    );
    return;
  }

  for (const art of PINNED_DEPTH_MODEL.artifacts) {
    const destPath = resolve(baseDir, art.relativePath);
    mkdirSync(dirname(destPath), { recursive: true });

    console.log(`[img2world:fetch-model] Downloading ${art.url} ...`);
    const res = await fetch(art.url);
    if (!res.ok) {
      throw new Error(
        `Failed to download ${art.url}: HTTP ${res.status} ${res.statusText}`
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const digest = computeSha256Hex(buf);

    if (
      !options.allowUnverifiedHashUpdate &&
      digest.toLowerCase() !== art.sha256.toLowerCase()
    ) {
      throw new Error(
        `SHA-256 mismatch for ${art.relativePath}: expected ${art.sha256}, got ${digest}`
      );
    }

    writeFileSync(destPath, buf);
    console.log(
      `[img2world:fetch-model] Pinned ${art.relativePath} (${buf.byteLength} B, sha256=${digest})`
    );
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    const st = verifyCachedModel();
    if (!st.ready) {
      console.error(
        `[img2world:fetch-model] Offline model cache incomplete: ${st.missingOrInvalid.join(', ')}`
      );
      process.exitCode = 1;
    } else {
      console.log('[img2world:fetch-model] Offline model cache verified OK.');
    }
  } else {
    fetchAndPinModel().catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    });
  }
}
