import type { MinigameDef, ShootingRules } from '../interactions.js';

/**
 * The `basketball-shooting` minigame: a timed Shootout.
 *
 * idle → countdown (3, 2, 1) → playing (the clock runs) → overtime (the buzzer has gone but a shot
 * released in time is still in the air) → over. This class only keeps the clock and the score; the
 * runtime tells it about shots and baskets.
 */
export type ShootoutPhase = 'idle' | 'countdown' | 'playing' | 'overtime' | 'over';

export interface ShootoutResult {
  score: number;
  makes: number;
  attempts: number;
  highScore: number;
  newHigh: boolean;
}

/** What happened during one tick: whole seconds passing, and phase changes. */
export type ShootoutSignal =
  | { kind: 'countdown'; seconds: number }
  | { kind: 'go' }
  | { kind: 'second'; timeLeft: number }
  | { kind: 'buzzer' }
  | { kind: 'over'; result: ShootoutResult };

export const COUNTDOWN_SEC = 3;
/** How long the game waits for a buzzer-beater to come down before calling it. */
export const OVERTIME_SEC = 5;

export class Shootout {
  phase: ShootoutPhase = 'idle';
  timeLeft: number;
  score = 0;
  makes = 0;
  attempts = 0;
  highScore: number;
  plays: number;
  result: ShootoutResult | null = null;
  rules: ShootingRules;
  private clock = 0;

  constructor(readonly def: MinigameDef, saved?: { highScore: number; plays: number }) {
    this.rules = { ...def.rules };
    this.timeLeft = this.rules.durationSec;
    this.highScore = saved?.highScore ?? 0;
    this.plays = saved?.plays ?? 0;
  }

  get id(): string {
    return this.def.id;
  }

  /** True from the first countdown beep until the final score is in. */
  get running(): boolean {
    return this.phase === 'countdown' || this.phase === 'playing' || this.phase === 'overtime';
  }

  /** Shots released now count. */
  get live(): boolean {
    return this.phase === 'playing';
  }

  start(): void {
    this.phase = 'countdown';
    this.clock = COUNTDOWN_SEC;
    this.timeLeft = this.rules.durationSec;
    this.score = this.makes = this.attempts = 0;
    this.result = null;
  }

  /** Abandons the game without recording it. */
  stop(): void {
    this.phase = 'idle';
    this.timeLeft = this.rules.durationSec;
  }

  setRules(rules: ShootingRules): void {
    this.rules = { ...rules };
    if (!this.running) this.timeLeft = this.rules.durationSec;
  }

  shot(): void {
    if (this.live) this.attempts++;
  }

  basket(points: number): void {
    if (this.phase !== 'playing' && this.phase !== 'overtime') return;
    this.score += points;
    this.makes++;
  }

  /** Advances the clock. `pending` says whether a shot released before the buzzer is still in flight. */
  tick(dt: number, pending: boolean, out: ShootoutSignal[]): void {
    if (this.phase === 'countdown') {
      const before = Math.ceil(this.clock);
      this.clock -= dt;
      if (this.clock <= 0) {
        this.phase = 'playing';
        out.push({ kind: 'go' });
      } else if (Math.ceil(this.clock) < before) {
        out.push({ kind: 'countdown', seconds: Math.ceil(this.clock) });
      }
    } else if (this.phase === 'playing') {
      const before = Math.ceil(this.timeLeft);
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      if (this.timeLeft <= 0) {
        this.phase = 'overtime';
        this.clock = OVERTIME_SEC;
        out.push({ kind: 'buzzer' });
      } else if (Math.ceil(this.timeLeft) < before) {
        out.push({ kind: 'second', timeLeft: Math.ceil(this.timeLeft) });
      }
    }
    if (this.phase === 'overtime') {
      this.clock -= dt;
      if (!pending || this.clock <= 0) this.finish(out);
    }
  }

  private finish(out: ShootoutSignal[]): void {
    const newHigh = this.score > this.highScore;
    if (newHigh) this.highScore = this.score;
    this.plays++;
    this.phase = 'over';
    this.result = { score: this.score, makes: this.makes, attempts: this.attempts, highScore: this.highScore, newHigh };
    out.push({ kind: 'over', result: this.result });
  }
}
