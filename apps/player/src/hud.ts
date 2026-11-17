import type { WorldRuntime } from './sim/runtime.js';
import type { ShootoutResult } from './sim/shootout.js';
import type { ControlMode } from './viewer.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * The heads-up display over the scene: scoreboard, power bar, prompts, banners and the touch
 * buttons. It only reads the runtime. The DOM is written when a value changes, not every frame.
 */
export class Hud {
  private readonly scoreboard = $('scoreboard');
  private readonly time = $('hud-time');
  private readonly score = $('hud-score');
  private readonly best = $('hud-best');
  private readonly shots = $('hud-shots');
  private readonly bannerEl = $('banner');
  private readonly result = $('result');
  private readonly crosshair = $('crosshair');
  private readonly power = $('power');
  private readonly powerFill = $('power-fill');
  private readonly prompt = $('prompt');
  private readonly action = $('action');
  private readonly ballReset = $('ballreset');
  private readonly cache = new Map<string, string>();
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;

  frame(rt: WorldRuntime | null, mode: ControlMode, opts: { touch: boolean; editing: boolean }): void {
    const game = rt?.shootout ?? null;
    const walking = !!rt && mode === 'walk';
    // While editing on a phone the edit panel needs the top of the screen; the clock is not running anyway.
    this.show(this.scoreboard, !!game && !opts.editing);
    if (game) {
      const seconds = game.phase === 'idle' || game.phase === 'countdown' ? game.rules.durationSec : Math.ceil(game.timeLeft);
      this.text(this.time, String(seconds));
      this.text(this.score, String(game.score));
      this.text(this.best, String(game.highScore));
      // Live makes/attempts, so a player can see every released shot is counted.
      this.text(this.shots, `${game.makes}/${game.attempts}`);
      this.set('board-class', game.phase === 'playing' ? (game.timeLeft <= 10 ? 'live urgent' : 'live') : '', (v) => (this.scoreboard.className = v));
    }
    this.show(this.crosshair, walking && !opts.editing);
    this.show(this.power, walking && rt.charging);
    if (walking && rt.charging) {
      this.set('power', `${Math.round(rt.power * 100)}%`, (v) => (this.powerFill.style.width = v));
      this.set('lock', rt.aimLocked ? 'locked' : '', (v) => (this.power.className = v));
    }

    let prompt = '';
    if (walking && !opts.editing) {
      if (game?.phase === 'countdown') prompt = 'Get ready…';
      else if (rt.held && !rt.charging) prompt = opts.touch ? 'Aim at a hoop, hold Shoot to charge, let go to shoot' : 'Aim at a hoop · hold click or Space to charge · release to shoot';
      else if (!rt.held && rt.canGrab()) prompt = opts.touch ? 'Tap Grab to pick up the ball' : 'Click or press E to pick up the ball';
    }
    this.show(this.prompt, prompt !== '');
    if (prompt) this.text(this.prompt, prompt);

    this.show(this.action, walking && opts.touch && !opts.editing);
    this.text(this.action, rt?.held ? 'Shoot' : 'Grab');
    this.show(this.ballReset, walking && opts.touch && !game?.running);
  }

  /** Shows a short message in the middle of the scene. */
  banner(text: string, ms = 900): void {
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerEl.hidden = true;
    // Reading the size restarts the CSS animation for back-to-back banners.
    void this.bannerEl.offsetWidth;
    this.bannerEl.textContent = text;
    this.bannerEl.hidden = false;
    this.bannerTimer = setTimeout(() => (this.bannerEl.hidden = true), ms);
  }

  showResult(result: ShootoutResult): void {
    $('result-title').textContent = result.newHigh ? 'New high score!' : 'Time!';
    const made = result.attempts > 0 ? ` · ${result.makes} of ${result.attempts} shots` : '';
    $('result-line').textContent = `${result.score} points${made} · best ${result.highScore}`;
    this.result.hidden = false;
  }

  hideResult(): void {
    this.result.hidden = true;
  }

  private show(el: HTMLElement, visible: boolean): void {
    if (el.hidden === visible) el.hidden = !visible;
  }

  private text(el: HTMLElement, value: string): void {
    this.set(`t:${el.id}`, value, (v) => (el.textContent = v));
  }

  private set(key: string, value: string, apply: (value: string) => void): void {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    apply(value);
  }
}
