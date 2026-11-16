import * as THREE from 'three';
import { loadModelFromWorld, type NpcAction, type Vec3 } from '@wgif/ai';
import type { WgifWorld } from '@wgif/format';
import type { WorldViewer } from './viewer.js';
import type { CameraHints } from './world.js';

export interface CourtAi {
  /** The runtime actually driving the rebounder ('rules' or 'onnx'). */
  readonly runtime: string;
  /** True when the ONNX model could not run and the rules model is in use. */
  readonly usedFallback: boolean;
  dispose(): void;
}

const HOME: Vec3 = [0, 0, 6];
const MARKER_RADIUS = 0.35;
const MARKER_COLOR = 0x8b5cf6; // violet — the rebounder is Nova's NPC
const BALL_CARRY_HEIGHT = 0.9;

/**
 * Attaches the court's rebounder NPC to a loaded world. The model is stepped
 * at its descriptor tickHz on the viewer's per-frame hook; between ticks the
 * marker integrates the last action's velocity, clamped to the court bounds.
 * The ball follows the marker while it is held and goes to the player on a
 * pass. Returns null when the world has no rebounder model or no ball node —
 * the world is still fully explorable without it.
 *
 * This is the Phase One wiring for the @wgif/ai lane; the hook it uses
 * (WorldViewer.onTick) is the proposal for Claude, who owns the viewer.
 */
export async function attachCourtAi(world: WgifWorld, viewer: WorldViewer, hints: CameraHints): Promise<CourtAi | null> {
  const ballNode = viewer.scene.getObjectByName('ball');
  if (!ballNode) return null;
  let loaded;
  try {
    loaded = await loadModelFromWorld(world, 'rebounder');
  } catch {
    return null;
  }
  const { model, runtime, usedFallback, tickHz } = loaded;

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(MARKER_RADIUS, 24, 16),
    new THREE.MeshStandardMaterial({ color: MARKER_COLOR }),
  );
  marker.name = 'rebounder';
  viewer.scene.add(marker);

  const bounds = hints.bounds ?? { min: [-17, 0, -10], max: [17, 0, 10] };
  const clamp = (v: number, lo: number, hi: number) => THREE.MathUtils.clamp(v, lo, hi);

  let selfPos: Vec3 = [...HOME];
  let ballPos: Vec3 = ballNode.position.toArray() as Vec3;
  let heldBy: 'player' | 'rebounder' | null = null;
  let lastAction: NpcAction = { state: 'idle', velocity: [0, 0, 0], passBall: false, holdingBall: false, target: ballPos };
  let acc = 0;
  let inFlight = false;
  let timeSec = 0;
  let disposed = false;

  const playerFeet = (): Vec3 => [viewer.camera.position.x, 0, viewer.camera.position.z];

  const step = async (): Promise<void> => {
    if (inFlight || disposed) return;
    inFlight = true;
    try {
      const action = await model.update(
        {
          timeSec,
          ball: { position: ballPos, velocity: [0, 0, 0], heldBy },
          player: { position: playerFeet() },
          self: { position: selfPos },
        },
        1 / tickHz,
      );
      lastAction = action;
      if (action.passBall) {
        heldBy = 'player';
        const p = playerFeet();
        ballPos = [p[0], BALL_CARRY_HEIGHT, p[2]];
      } else if (action.holdingBall) {
        heldBy = 'rebounder';
      }
    } finally {
      inFlight = false;
    }
  };

  const onTick = (dt: number): void => {
    if (disposed) return;
    timeSec += dt;
    acc += dt;
    const tickDt = 1 / tickHz;
    let steps = 0;
    while (acc >= tickDt && steps < 3) {
      acc -= tickDt;
      steps++;
      void step();
    }
    // Integrate between model ticks so the marker moves smoothly.
    selfPos = [
      clamp(selfPos[0] + lastAction.velocity[0] * dt, bounds.min[0], bounds.max[0]),
      0,
      clamp(selfPos[2] + lastAction.velocity[2] * dt, bounds.min[2], bounds.max[2]),
    ];
    if (heldBy === 'rebounder') ballPos = [selfPos[0], BALL_CARRY_HEIGHT, selfPos[2]];
    marker.position.set(selfPos[0], MARKER_RADIUS, selfPos[2]);
    ballNode.position.set(ballPos[0], ballPos[1], ballPos[2]);
  };

  viewer.onTick = onTick;
  return {
    runtime,
    usedFallback,
    dispose(): void {
      disposed = true;
      if (viewer.onTick === onTick) viewer.onTick = undefined;
      viewer.scene.remove(marker);
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
    },
  };
}
