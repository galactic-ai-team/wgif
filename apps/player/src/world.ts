import { unpackWgif, type WgifWorld } from '@wgif/format';

/** Capabilities actually implemented by this player, not merely known to the WGIF spec. */
const PLAYER_CAPABILITIES = new Set(['scene.glb', 'interaction.camera']);

export class WorldOpenError extends Error {
  constructor(message: string, public details: string[] = []) {
    super(message);
    this.name = 'WorldOpenError';
  }
}

/** Opens and validates a .wgif. Throws WorldOpenError with readable details if it cannot be played. */
export async function openWorld(bytes: Uint8Array): Promise<WgifWorld> {
  let world: WgifWorld;
  try {
    world = await unpackWgif(bytes);
  } catch (e) {
    throw new WorldOpenError(`Could not open file: ${(e as Error).message}`);
  }
  if (!world.report.ok) {
    throw new WorldOpenError('This .wgif failed validation', world.report.errors.map((e) => `${e.code}: ${e.message}`));
  }
  const missing = (world.manifest.requires ?? []).filter((cap) => !PLAYER_CAPABILITIES.has(cap));
  if (missing.length) {
    throw new WorldOpenError('This world requires unsupported player features', missing.map((cap) => `requires: ${cap}`));
  }
  return world;
}

export interface CameraHints {
  position: [number, number, number];
  lookAt: [number, number, number];
  eyeHeight: number;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/** Reads spawn/camera hints from the manifest and (optionally) interactions.json. */
export function cameraHints(world: WgifWorld): CameraHints {
  const hints: CameraHints = {
    position: world.manifest.spawn?.position ?? [0, 1.7, 8],
    lookAt: world.manifest.spawn?.lookAt ?? [0, 1, 0],
    eyeHeight: 1.7,
  };
  const path = world.manifest.entry.interactions;
  const raw = path ? world.files[path] : undefined;
  if (raw) {
    try {
      const cam = (JSON.parse(new TextDecoder().decode(raw)) as { camera?: Partial<CameraHints> & { firstPersonHeight?: number } }).camera;
      if (cam?.firstPersonHeight) hints.eyeHeight = cam.firstPersonHeight;
      if (cam?.bounds) hints.bounds = cam.bounds;
    } catch {
      /* interactions.json is optional for the proof player */
    }
  }
  return hints;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
