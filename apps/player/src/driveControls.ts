import type { DriveInput } from './sim/vehicle.js';

/**
 * Driver input for desktop and touch, turned into one `DriveInput`.
 *
 * Desktop: W / Up to accelerate, S / Down to brake and then reverse, A / D or Left / Right to steer,
 * Space for the brake. Touch: the on-screen pad (steer left / right under the left thumb, gas and
 * brake under the right); every button is held, and several can be held at once.
 */
export interface DriveHooks {
  /** R: put the vehicle back on its spawn. */
  onReset(): void;
}

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
/** Pad buttons: `data-drive` is one of these. */
type Pad = 'left' | 'right' | 'gas' | 'brake';

const typing = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export class DriveControls {
  readonly drive: DriveInput = { throttle: 0, steer: 0, brake: false };
  private enabled = false;
  private readonly keys = new Set<string>();
  /** Pad buttons held, by pointer id. */
  private readonly held = new Map<number, Pad>();
  private readonly abort = new AbortController();

  constructor(private readonly pad: HTMLElement | null, private readonly hooks: DriveHooks) {
    const on = { signal: this.abort.signal };
    window.addEventListener('keydown', (e) => this.key(e, true), on);
    window.addEventListener('keyup', (e) => this.key(e, false), on);
    window.addEventListener('blur', () => this.clear(), on);
    if (pad) {
      pad.addEventListener('pointerdown', (e) => this.press(e), on);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) pad.addEventListener(type, (e) => this.release(e), on);
      pad.addEventListener('contextmenu', (e) => e.preventDefault(), on);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.pad) this.pad.hidden = !enabled;
    this.clear();
  }

  dispose(): void {
    this.abort.abort();
  }

  private clear(): void {
    this.keys.clear();
    this.held.clear();
    this.pad?.querySelectorAll('[data-drive]').forEach((b) => b.classList.remove('down'));
    this.refresh();
  }

  private refresh(): void {
    const k = this.keys, pads = new Set(this.held.values());
    const gas = k.has('KeyW') || k.has('ArrowUp') || pads.has('gas');
    const back = k.has('KeyS') || k.has('ArrowDown') || pads.has('brake');
    const left = k.has('KeyA') || k.has('ArrowLeft') || pads.has('left');
    const right = k.has('KeyD') || k.has('ArrowRight') || pads.has('right');
    this.drive.throttle = this.enabled ? (gas ? 1 : 0) - (back ? 1 : 0) : 0;
    this.drive.steer = this.enabled ? (right ? 1 : 0) - (left ? 1 : 0) : 0;
    this.drive.brake = this.enabled && k.has('Space');
    if (this.pad) {
      for (const b of this.pad.querySelectorAll<HTMLElement>('[data-drive]')) b.classList.toggle('down', pads.has(b.dataset.drive as Pad));
    }
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (!this.enabled || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (KEYS.has(e.code)) {
      e.preventDefault();
      if (down) this.keys.add(e.code);
      else this.keys.delete(e.code);
      this.refresh();
    } else if (down && !e.repeat && e.code === 'KeyR') {
      this.hooks.onReset();
    }
  }

  private press(e: PointerEvent): void {
    const button = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-drive]');
    const which = button?.dataset.drive as Pad | undefined;
    if (!this.enabled || !button || !which) return;
    e.preventDefault();
    try {
      button.setPointerCapture?.(e.pointerId);
    } catch {
      // A synthetic or already-lifted pointer cannot be captured; the press still counts.
    }
    this.held.set(e.pointerId, which);
    this.refresh();
  }

  private release(e: PointerEvent): void {
    if (!this.held.delete(e.pointerId)) return;
    this.refresh();
  }
}
