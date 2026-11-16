import type { PlayerInput } from './sim/runtime.js';
import type { InputSource } from './viewer.js';

/**
 * First-person input for desktop and touch, turned into one `PlayerInput`.
 *
 * Desktop: click the scene to capture the mouse, WASD or arrows to move, Shift to run, hold the
 * left button (or Space) to charge a shot. If the browser refuses pointer lock, dragging looks around.
 * Touch: the left part of the scene is a virtual stick that appears under the thumb, dragging
 * anywhere else looks around, and the on-screen button is the primary action.
 */
export interface ControlHooks {
  /** The primary action started: left click while captured, Space, or the touch button. */
  onPrimary(): void;
  /** E: pick up or drop. */
  onUse(): void;
  /** R: put the ball back on its spawn. */
  onReset(): void;
  onLockChange(locked: boolean): void;
}

export interface TouchElements {
  /** Stick base and knob, positioned under the thumb while it is down. */
  stick: HTMLElement;
  knob: HTMLElement;
  /** The primary action button (grab / hold to shoot). */
  action: HTMLElement;
}

const MOUSE_LOOK = 0.0022;
const TOUCH_LOOK = 0.0055;
const STICK_RADIUS = 56;
/** Share of the scene's width, from the left, where a touch starts the stick. */
const STICK_ZONE = 0.45;
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space']);

/**
 * Only a press that starts on the 3D view itself looks around, moves or captures the mouse.
 * Buttons and panels drawn over the view (Grab/Shoot, the result panel, the edit panel) keep their
 * own clicks: a press on them must not capture the pointer, or the next click goes to the scene.
 */
export const startsOnScene = (target: EventTarget | null): boolean => (target as { tagName?: string } | null)?.tagName === 'CANVAS';

const typing = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export class PlayerControls implements InputSource {
  readonly input: PlayerInput = { forward: 0, right: 0, run: false, charging: false };
  /** True once the pointer is captured (desktop). */
  locked = false;
  /** True once a touch has been seen, so the UI can show touch hints and buttons. */
  touch = false;
  private enabled = false;
  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private mouseDown = false;
  private actionDown = false;
  private stick: { id: number; x0: number; y0: number; x: number; y: number } | null = null;
  private look: { id: number; x: number; y: number } | null = null;
  private readonly abort = new AbortController();

  constructor(private readonly canvas: HTMLElement, private readonly ui: TouchElements, private readonly hooks: ControlHooks) {
    const on = { signal: this.abort.signal };
    window.addEventListener('keydown', (e) => this.key(e, true), on);
    window.addEventListener('keyup', (e) => this.key(e, false), on);
    window.addEventListener('blur', () => this.release(), on);
    document.addEventListener('visibilitychange', () => this.release(), on);
    document.addEventListener('pointerlockchange', () => this.lockChanged(), on);
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e), on);
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e), on);
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e), on);
    canvas.addEventListener('pointercancel', (e) => this.pointerUp(e), on);
    document.addEventListener('mousemove', (e) => {
      if (this.locked) this.turn(e.movementX * MOUSE_LOOK, e.movementY * MOUSE_LOOK);
    }, on);
    document.addEventListener('mouseup', () => {
      this.mouseDown = false;
      this.refresh();
    }, on);
    ui.action.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!this.enabled) return;
      this.actionDown = true;
      this.refresh();
      this.hooks.onPrimary();
    }, on);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      ui.action.addEventListener(type, () => {
        this.actionDown = false;
        this.refresh();
      }, on);
    }
    ui.action.addEventListener('contextmenu', (e) => e.preventDefault(), on);
  }

  /** Look movement since the last call: [yaw, pitch] in radians. */
  consumeLook(): [number, number] {
    const out: [number, number] = [this.yaw, this.pitch];
    this.yaw = this.pitch = 0;
    return out;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.release();
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    }
  }

  dispose(): void {
    this.abort.abort();
  }

  /** Lets go of everything: used when the window loses focus so no key stays stuck down. */
  private release(): void {
    this.keys.clear();
    this.mouseDown = this.actionDown = false;
    this.stick = this.look = null;
    this.ui.stick.hidden = true;
    this.refresh();
  }

  private refresh(): void {
    const k = this.keys;
    let forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let run = k.has('ShiftLeft') || k.has('ShiftRight');
    if (this.stick) {
      const dx = (this.stick.x - this.stick.x0) / STICK_RADIUS, dy = (this.stick.y - this.stick.y0) / STICK_RADIUS;
      const m = Math.hypot(dx, dy), s = m > 1 ? 1 / m : 1;
      right += dx * s;
      forward -= dy * s;
      // Pushing the stick to its edge runs.
      run ||= m > 1.25;
      this.ui.knob.style.transform = `translate(${dx * s * STICK_RADIUS}px, ${dy * s * STICK_RADIUS}px)`;
    }
    this.input.forward = this.enabled ? Math.max(-1, Math.min(1, forward)) : 0;
    this.input.right = this.enabled ? Math.max(-1, Math.min(1, right)) : 0;
    this.input.run = run;
    this.input.charging = this.enabled && (this.mouseDown || this.actionDown || k.has('Space'));
  }

  private turn(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.yaw -= dx;
    this.pitch -= dy;
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (!this.enabled || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (MOVE_KEYS.has(e.code)) {
      e.preventDefault();
      const fresh = down && !this.keys.has(e.code);
      if (down) this.keys.add(e.code);
      else this.keys.delete(e.code);
      this.refresh();
      if (fresh && e.code === 'Space') this.hooks.onPrimary();
    } else if (down && !e.repeat && e.code === 'KeyE') {
      this.hooks.onUse();
    } else if (down && !e.repeat && e.code === 'KeyR') {
      this.hooks.onReset();
    }
  }

  private lockChanged(): void {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) {
      this.mouseDown = false;
      this.refresh();
    }
    this.hooks.onLockChange(this.locked);
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.enabled || !startsOnScene(e.target)) return;
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      if (this.locked) {
        this.mouseDown = true;
        this.refresh();
        this.hooks.onPrimary();
      } else if (typeof this.canvas.requestPointerLock === 'function') {
        // Some browsers return a promise that rejects when the lock is refused; dragging still looks around.
        void Promise.resolve(this.canvas.requestPointerLock()).catch(() => undefined);
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
      } else {
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
      return;
    }
    e.preventDefault();
    if (!this.touch) {
      this.touch = true;
      this.hooks.onLockChange(this.locked);
    }
    this.canvas.setPointerCapture?.(e.pointerId);
    const rect = this.canvas.getBoundingClientRect();
    if (!this.stick && e.clientX - rect.left < rect.width * STICK_ZONE) {
      this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
      this.ui.stick.hidden = false;
      this.ui.stick.style.left = `${e.clientX - rect.left}px`;
      this.ui.stick.style.top = `${e.clientY - rect.top}px`;
      this.refresh();
    } else if (!this.look) {
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  }

  private pointerMove(e: PointerEvent): void {
    if (this.stick?.id === e.pointerId) {
      this.stick.x = e.clientX;
      this.stick.y = e.clientY;
      this.refresh();
    } else if (this.look?.id === e.pointerId && !this.locked) {
      const k = e.pointerType === 'mouse' ? MOUSE_LOOK : TOUCH_LOOK;
      this.turn((e.clientX - this.look.x) * k, (e.clientY - this.look.y) * k);
      this.look.x = e.clientX;
      this.look.y = e.clientY;
    }
  }

  private pointerUp(e: PointerEvent): void {
    if (this.stick?.id === e.pointerId) {
      this.stick = null;
      this.ui.stick.hidden = true;
      this.refresh();
    }
    if (this.look?.id === e.pointerId) this.look = null;
  }
}
