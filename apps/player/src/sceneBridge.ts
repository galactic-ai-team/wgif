import * as THREE from 'three';
import type { Vec3 } from '@wgif/format';
import type { GameState, Interactions } from './interactions.js';
import { LAYER_PROP, LAYER_SOLID, StaticColliders } from './sim/colliders.js';
import { WorldRuntime } from './sim/runtime.js';
import type { WorldDocument } from './world.js';

/** Bridge from the three.js scene graph to the simulation: node hints, collision geometry, runtime setup. */

/** The `extras.wgif` hints of a glTF node (SPEC §5.1). GLTFLoader copies node extras into userData. */
export function wgifHints(object: THREE.Object3D): Record<string, unknown> {
  const hints = (object.userData as { wgif?: unknown }).wgif;
  return typeof hints === 'object' && hints !== null ? (hints as Record<string, unknown>) : {};
}

/** The node's name as written in the glTF. GLTFLoader sanitises `name`, but keeps the original in userData. */
export function nodeName(object: THREE.Object3D): string {
  const original = (object.userData as { name?: unknown }).name;
  return typeof original === 'string' && original ? original : object.name;
}

/** Every object in the scene that carries the given glTF node name. */
export function findNodes(root: THREE.Object3D, name: string): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (nodeName(o) === name) found.push(o);
  });
  return found;
}

/** World-space triangles of all meshes under `root` (xyz per vertex, three vertices per triangle). */
export function worldTriangles(root: THREE.Object3D): number[] {
  const out: number[] = [];
  const v = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const position = mesh.isMesh ? mesh.geometry?.getAttribute('position') : undefined;
    if (!position) return;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(position, index ? index.getX(i + k) : i + k).applyMatrix4(mesh.matrixWorld);
        out.push(v.x, v.y, v.z);
      }
    }
  });
  return out;
}

export function worldPosition(object: THREE.Object3D): Vec3 {
  const p = object.getWorldPosition(new THREE.Vector3());
  return [p.x, p.y, p.z];
}

export interface SceneColliders {
  colliders: StaticColliders;
  /** Node names that became solid colliders, and thin props only balls hit (hoop rims). */
  solid: string[];
  props: string[];
  warnings: string[];
}

/** How much livelier or deader than a plain surface a prop is. A rim takes a lot out of a bounce. */
const PROP_RESTITUTION = 0.7;

/**
 * Builds the collision world for a scene.
 *
 * Solid: the nodes listed in interactions.json `colliders.static` (if the file has no such list,
 * every node hinted `extras.wgif.collider: "static"`). Props
 * (balls only): the nodes of a minigame's target triggers and nodes hinted `role: "target"`, so the
 * ball bounces off a rim it can see. Grabbable nodes move, so they are never static.
 */
export function buildColliders(scene: THREE.Object3D, interactions: Interactions): SceneColliders {
  const colliders = new StaticColliders();
  const warnings: string[] = [];
  const solid: string[] = [], props: string[] = [];
  const moving = new Set(interactions.objects.filter((o) => o.kind === 'grabbable').map((o) => o.node ?? o.id));
  const hinted = (key: string, value: unknown): string[] => {
    const names = new Set<string>();
    scene.traverse((o) => {
      if (wgifHints(o)[key] === value && nodeName(o)) names.add(nodeName(o));
    });
    return [...names];
  };

  for (const name of interactions.staticColliders ?? hinted('collider', 'static')) {
    if (moving.has(name)) continue;
    const nodes = findNodes(scene, name);
    if (nodes.length === 0) {
      warnings.push(`collider "${name}" is not a node in the scene`);
      continue;
    }
    const triangles = nodes.flatMap(worldTriangles);
    if (colliders.addMesh(name, triangles, null, { layer: LAYER_SOLID }).triangles > 0) solid.push(name);
  }

  const targets = new Set<string>(hinted('role', 'target'));
  for (const game of interactions.minigames) {
    for (const id of game.targets) {
      const trigger = interactions.objects.find((o) => o.id === id);
      if (trigger?.node) targets.add(trigger.node);
    }
  }
  for (const name of targets) {
    if (solid.includes(name) || moving.has(name)) continue;
    const triangles = findNodes(scene, name).flatMap(worldTriangles);
    if (colliders.addMesh(name, triangles, null, { layer: LAYER_PROP, restitution: PROP_RESTITUTION }).triangles > 0) props.push(name);
  }
  colliders.build();
  return { colliders, solid, props, warnings };
}

/** Builds the simulation for a document and its freshly parsed scene. `state` is where the world starts from. */
export function createRuntime(doc: WorldDocument, scene: THREE.Object3D, state: GameState = doc.initialState): { runtime: WorldRuntime; built: SceneColliders } {
  scene.updateWorldMatrix(true, true);
  const built = buildColliders(scene, doc.interactions);
  const runtime = new WorldRuntime({
    interactions: doc.interactions,
    colliders: built.colliders,
    state,
    spawn: doc.spawn,
    nodePosition: (name) => {
      const node = findNodes(scene, name)[0];
      return node ? worldPosition(node) : null;
    },
  });
  return { runtime, built };
}
