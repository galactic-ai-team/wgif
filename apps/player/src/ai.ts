import * as THREE from 'three';
import { createNpcHook, type NpcAction, type Vec3 } from '@wgif/ai';
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

export interface CourtAiOptions {
  /**
   * Called once when the NPC fails mid-game (a model step rejects). The NPC
   * is already disabled by then; the player uses this to report it (the #ai
   * line) instead of leaving a stale "rules model" status on screen.
   */
  onError?: (error: unknown) => void;
}

const HOME: Vec3 = [0, 0, 6];
const MARKER_RADIUS = 0.35;
const MARKER_COLOR = 0x8b5cf6; // violet — the rebounder is Nova's NPC
const BALL_CARRY_HEIGHT = 0.9;

/**
 * Attaches the court's rebounder NPC to a loaded world. The NPC is driven by
 * the @wgif/ai per-tick hook (`createNpcHook`): the hook owns the model and
 * the tick-rate scheduling, the player owns the scene — the marker integrates
 * the hook's last action velocity between ticks, clamped to the court bounds,
 * and the ball follows the marker while it is held and goes to the player on
 * a pass. Returns null when the world has no rebounder model or no ball node —
 * the world is still fully explorable without it.
 *
 * Lifecycle: movement velocity is persistent (the last action's velocity is
 * integrated every frame), but the pass/hold gameplay events are one-shot —
 * they are applied only when the hook reports a fresh model step
 * (`TickResult.stepped`), never from a repeated stale action. If a model
 * step rejects mid-game, the NPC is disabled (marker removed, hook disposed)
 * and `onError` is called once; there is no second runtime fallback — the
 * rules twin already *is* the fallback, so a running model failing means the
 * NPC stops rather than the world breaking. A step that resolves after the
 * NPC is disposed is ignored (the hook discards it, and the player checks
 * `disposed` before applying anything).
 *
 * The hook is rules-first by manifest order, with the JS MLP evaluator as the
 * optional ONNX optimization and the rules twin as fallback (no WASM). The
 * viewer hook it runs on (WorldViewer.onTick) belongs to the player lane.
 */
export async function attachCourtAi(
  world: WgifWorld,
  viewer: WorldViewer,
  hints: CameraHints,
  opts: CourtAiOptions = {},
): Promise<CourtAi | null> {
  const ballNode = viewer.scene.getObjectByName('ball');
  if (!ballNode) return null;
  let hook;
  try {
    hook = await createNpcHook(world, 'rebounder');
  } catch {
    return null;
  }
  const { runtime, usedFallback } = hook;

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
  let timeSec = 0;
  let disposed = false;
  let failed = false;

  const playerFeet = (): Vec3 => [viewer.camera.position.x, 0, viewer.camera.position.z];

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    hook.dispose();
    if (viewer.onTick === onTick) viewer.onTick = undefined;
    viewer.scene.remove(marker);
    marker.geometry.dispose();
    (marker.material as THREE.Material).dispose();
  };

  /** Disables the NPC after a mid-game model failure and reports it once. */
  const fail = (error: unknown): void => {
    if (failed || disposed) return;
    failed = true;
    dispose();
    opts.onError?.(error);
  };

  // One-shot gameplay events: applied only from a fresh model step. The
  // hook's TickResult.stepped is the only thing that says an action is new —
  // a repeated stale action (no step ran this frame) must never re-fire a
  // pass. Ignored entirely once the NPC is disposed or failed.
  const applyAction = (action: NpcAction): void => {
    if (disposed || failed) return;
    lastAction = action;
    if (action.passBall) {
      heldBy = 'player';
      const p = playerFeet();
      ballPos = [p[0], BALL_CARRY_HEIGHT, p[2]];
    } else if (action.holdingBall) {
      heldBy = 'rebounder';
    }
  };

  const onTick = (dt: number): void => {
    if (disposed || failed) return;
    timeSec += dt;
    // The hook steps the model at its descriptor tickHz (at most 3 steps per
    // call) and reports whether a step was committed. Velocity is persistent
    // (integrated below from the last action), but the pass/hold events are
    // applied only on a fresh step. A rejection disables the NPC via fail()
    // instead of leaving an unhandled promise rejection.
    void hook
      .tick(dt, {
        timeSec,
        ball: { position: ballPos, velocity: [0, 0, 0], heldBy },
        player: { position: playerFeet() },
        self: { position: selfPos },
      })
      .then((result) => {
        if (result.stepped) applyAction(result.action);
      })
      .catch(fail);
    // Integrate the last action's velocity between model ticks so the marker
    // moves smoothly; the velocity is the persistent part of the action.
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
    dispose,
  };
}
