import type { ModelEntry } from '@wgif/format';

export type { ModelEntry };

export type Vec3 = [number, number, number];

/** The ball as the NPC sees it. Positions are meters in glTF axes (+Y up); velocities m/s. */
export interface BallObservation {
  position: Vec3;
  velocity: Vec3;
  /** Who holds the ball, if anyone. `null` means the ball is loose. */
  heldBy: 'player' | 'rebounder' | null;
}

export interface NpcObservation {
  /** Seconds since the world opened. Models MUST NOT use wall-clock time; this is the only clock. */
  timeSec: number;
  ball: BallObservation;
  player: { position: Vec3 };
  self: { position: Vec3 };
}

export interface NpcAction {
  /** The NPC's state after this tick (rules state name, or a derived label for ONNX). */
  state: string;
  /** Move velocity in m/s. Y is always 0: NPCs walk on the floor. The caller integrates position. */
  velocity: Vec3;
  /** True only on the tick the ball is passed back to the player. */
  passBall: boolean;
  /** True while the NPC carries the ball. */
  holdingBall: boolean;
  /** Where the NPC is heading this tick, if it is moving. */
  target: Vec3 | null;
}

/**
 * One embedded NPC model, rules or ONNX. `update` is async because ONNX
 * inference is async; rules models resolve immediately. The same observation
 * sequence MUST always produce the same action sequence for deterministic models.
 */
export interface NpcModel {
  readonly id: string;
  readonly runtime: 'rules' | 'onnx';
  readonly descriptor: ModelEntry;
  /** Current state (rules state name; a derived label for ONNX). */
  readonly state: string;
  update(obs: NpcObservation, dt: number): Promise<NpcAction>;
  reset(): void;
}

/** Default model tick rate (Hz) when a descriptor omits tickHz. */
export const DEFAULT_TICK_HZ = 10;

/** Default court bounds (meters) used when a world supplies no geometry for an ONNX model. */
export const DEFAULT_COURT_BOUNDS = {
  min: [-17, 0, -10] as Vec3,
  max: [17, 0, 10] as Vec3,
};

/** Default home position for an ONNX model with no rules twin to read it from. */
export const DEFAULT_HOME: Vec3 = [0, 0, 6];
