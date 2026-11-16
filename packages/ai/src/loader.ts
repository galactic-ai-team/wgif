import type { WgifWorld } from '@wgif/format';
import type { NpcModel, Vec3 } from './types.js';
import { DEFAULT_COURT_BOUNDS, DEFAULT_HOME } from './types.js';
import { loadRulesModel, parseRulesModel } from './rules.js';
import { OnnxNpc, OnnxRuntimeUnavailableError } from './onnx.js';

export interface LoadedModel {
  model: NpcModel;
  /** The runtime actually running (may differ from the first descriptor tried). */
  runtime: 'rules' | 'onnx';
  /** True when the requested model could not run and its declared fallback is in use. */
  usedFallback: boolean;
  /** Tick rate of the model that is actually running (descriptor tickHz, default 10). */
  tickHz: number;
  warnings: string[];
}

/** All models in the world with this purpose, in manifest order. */
export function findModels(world: WgifWorld, purpose: string): import('@wgif/format').ModelEntry[] {
  return (world.manifest.models ?? []).filter((m) => m.purpose === purpose);
}

/**
 * Court geometry for an ONNX model, read from its rules twin (same purpose)
 * when the world has one, so the two models agree about where home and the
 * walls are. Falls back to the default court when there is no twin.
 */
function geometryFromRulesTwin(world: WgifWorld, purpose: string): { home: Vec3; bounds: typeof DEFAULT_COURT_BOUNDS } {
  const twin = (world.manifest.models ?? []).find((m) => m.purpose === purpose && m.runtime === 'rules');
  const bytes = twin ? world.files[twin.path] : undefined;
  if (!twin || !bytes) return { home: DEFAULT_HOME, bounds: DEFAULT_COURT_BOUNDS };
  try {
    const rules = parseRulesModel(bytes);
    return { home: rules.params.home as Vec3, bounds: rules.court.bounds };
  } catch {
    return { home: DEFAULT_HOME, bounds: DEFAULT_COURT_BOUNDS };
  }
}

/**
 * Loads the best model for a purpose from an unpacked world. Tries descriptors
 * in manifest order; an ONNX model that cannot load (runtime missing, bad file)
 * falls back to its declared `fallback` model — normally the rules twin — and
 * reports that in `usedFallback`. A broken rules model is a load error, not a
 * silent skip: rules are the fallback, so they must be trustworthy.
 */
export async function loadModelFromWorld(world: WgifWorld, purpose = 'rebounder'): Promise<LoadedModel> {
  const descriptors = findModels(world, purpose);
  if (descriptors.length === 0) {
    throw new Error(`world "${world.manifest.id}" has no model with purpose "${purpose}"`);
  }
  const warnings: string[] = [];
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  for (const descriptor of descriptors) {
    const bytes = world.files[descriptor.path];
    if (!bytes) throw new Error(`model "${descriptor.id}" points to missing file "${descriptor.path}"`);
    if (descriptor.runtime === 'rules') {
      return { model: loadRulesModel(descriptor, bytes), runtime: 'rules', usedFallback: false, tickHz: descriptor.tickHz ?? 10, warnings };
    }
    // onnx: try it, fall back to the declared fallback on any load failure.
    try {
      const { home, bounds } = geometryFromRulesTwin(world, purpose);
      const model = await OnnxNpc.load(descriptor, bytes, home, bounds);
      return { model, runtime: 'onnx', usedFallback: false, tickHz: descriptor.tickHz ?? 10, warnings };
    } catch (e) {
      const reason = e instanceof OnnxRuntimeUnavailableError ? 'onnx runtime unavailable' : (e as Error).message;
      warnings.push(`onnx model "${descriptor.id}" could not load (${reason})`);
      const fallback = descriptor.fallback ? byId.get(descriptor.fallback) : undefined;
      if (!fallback) continue;
      const fallbackBytes = world.files[fallback.path];
      if (!fallbackBytes) {
        throw new Error(`fallback model "${fallback.id}" points to missing file "${fallback.path}"`, { cause: e });
      }
      if (fallback.runtime !== 'rules') continue;
      warnings.push(`using fallback rules model "${fallback.id}"`);
      return { model: loadRulesModel(fallback, fallbackBytes), runtime: 'rules', usedFallback: true, tickHz: fallback.tickHz ?? 10, warnings };
    }
  }
  throw new Error(`no model with purpose "${purpose}" could be loaded: ${warnings.join('; ')}`);
}
