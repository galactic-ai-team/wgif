import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as THREE from 'three';
import type { GameState } from '../src/interactions.js';
import { parseGlb } from '../src/glb.js';
import { createRuntime, type SceneColliders } from '../src/sceneBridge.js';
import { IDLE_INPUT, TICK, type PlayerInput, type RuntimeEvent, type WorldRuntime } from '../src/sim/runtime.js';
import { loadDocument, openWorld, type WorldDocument } from '../src/world.js';

export const courtBytes = (): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL('../../../examples/court/court.wgif', import.meta.url))));

export interface OpenedWorld {
  doc: WorldDocument;
  scene: THREE.Group;
  built: SceneColliders;
  runtime: WorldRuntime;
}

/** Opens a .wgif the way the player does, minus the renderer. */
export async function open(bytes: Uint8Array = courtBytes(), state?: GameState): Promise<OpenedWorld> {
  const doc = await loadDocument(await openWorld(bytes));
  const scene = await parseGlb(doc.world.files[doc.world.manifest.entry.scene]!);
  return { doc, scene, ...createRuntime(doc, scene, state) };
}

/** Runs the simulation for a while and returns every event it raised. */
export function run(runtime: WorldRuntime, seconds: number, input: PlayerInput = IDLE_INPUT): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (let i = 0; i < Math.round(seconds / TICK); i++) {
    runtime.step(input);
    events.push(...runtime.drain());
  }
  return events;
}

export function ofType<T extends RuntimeEvent['type']>(events: RuntimeEvent[], type: T): Extract<RuntimeEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RuntimeEvent, { type: T }> => e.type === type);
}
