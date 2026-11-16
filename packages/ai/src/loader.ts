import type { WgifWorld } from '@wgif/format';
import type { NpcModel, Vec3 } from './types.js';
import { DEFAULT_COURT_BOUNDS, DEFAULT_HOME } from './types.js';
import { loadRulesModel, parseRulesModel } from './rules.js';
import { JsMlpNpc } from './jsmlp.js';

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
 * walls are — and about the pickup reach, which the JS MLP needs for its
 * pickup decision (it has no rules state machine to make it). Falls back to
 * the default court when there is no twin.
 */
function geometryFromRulesTwin(world: WgifWorld, purpose: string): { home: Vec3; bounds: typeof DEFAULT_COURT_BOUNDS; pickupRadius: number } {
  const twin = (world.manifest.models ?? []).find((m) => m.purpose === purpose && m.runtime === 'rules');
  const bytes = twin ? world.files[twin.path] : undefined;
  if (!twin || !bytes) return { home: DEFAULT_HOME, bounds: DEFAULT_COURT_BOUNDS, pickupRadius: 0.45 };
  try {
    const rules = parseRulesModel(bytes);
    return {
      home: rules.params.home as Vec3,
      bounds: rules.court.bounds,
      pickupRadius: typeof rules.params.pickupRadius === 'number' ? rules.params.pickupRadius : 0.45,
    };
  } catch {
    return { home: DEFAULT_HOME, bounds: DEFAULT_COURT_BOUNDS, pickupRadius: 0.45 };
  }
}

export interface LoadOptions {
  /**
   * Try this runtime first (in manifest order among descriptors of that
   * runtime), then the rest in manifest order. The default (no preference)
   * is plain manifest order. A preference never weakens the fallback: an
   * ONNX model that cannot load still falls back to its declared rules twin.
   */
  preferRuntime?: 'rules' | 'onnx';
}

/**
 * Loads the best model for a purpose from an unpacked world. Tries descriptors
 * in manifest order (or the preferred runtime first when `preferRuntime` is
 * set); an ONNX model that cannot load (bad file, wrong weights) falls back
 * to its declared `fallback` model — normally the rules twin — and reports
 * that in `usedFallback`. A broken rules model is a load error, not a silent
 * skip: rules are the fallback, so they must be trustworthy.
 *
 * ONNX models run through the hand-rolled JS MLP evaluator (JsMlpNpc), not
 * ONNX Runtime Web: the runtime-WASM budget is 0 B (PR #3), so no WASM ships
 * in the player. The ort path (src/onnx.ts) is Node-side verification only.
 */
export async function loadModelFromWorld(world: WgifWorld, purpose = 'rebounder', opts: LoadOptions = {}): Promise<LoadedModel> {
  const descriptors = findModels(world, purpose);
  if (descriptors.length === 0) {
    throw new Error(`world "${world.manifest.id}" has no model with purpose "${purpose}"`);
  }
  const ordered = opts.preferRuntime
    ? [...descriptors.filter((d) => d.runtime === opts.preferRuntime), ...descriptors.filter((d) => d.runtime !== opts.preferRuntime)]
    : descriptors;
  const warnings: string[] = [];
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  for (const descriptor of ordered) {
    const bytes = world.files[descriptor.path];
    if (!bytes) throw new Error(`model "${descriptor.id}" points to missing file "${descriptor.path}"`);
    if (descriptor.runtime === 'rules') {
      return { model: loadRulesModel(descriptor, bytes), runtime: 'rules', usedFallback: false, tickHz: descriptor.tickHz ?? 10, warnings };
    }
    // onnx: try the JS MLP evaluator, fall back to the declared fallback on any load failure.
    try {
      const { home, bounds, pickupRadius } = geometryFromRulesTwin(world, purpose);
      const model = await JsMlpNpc.load(descriptor, bytes, home, bounds, pickupRadius);
      return { model, runtime: 'onnx', usedFallback: false, tickHz: descriptor.tickHz ?? 10, warnings };
    } catch (e) {
      const reason = (e as Error).message;
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
