import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { CameraHints } from './world.js';

export type ControlMode = 'orbit' | 'walk';

/** Parses GLB bytes into a three.js scene graph (no network access). */
export function parseGlb(bytes: Uint8Array): Promise<THREE.Group> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buf, '', (gltf) => resolve(gltf.scene), (err) => reject(err));
  });
}

/**
 * Phase One proof viewer: renders a world's GLB with orbit and first-person (pointer-lock + WASD)
 * controls. Physics, interaction, minigames and touch controls are the World Player lane's job.
 */
export class WorldViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
  private orbit: OrbitControls;
  private walk: PointerLockControls;
  private world: THREE.Group | null = null;
  private hints: CameraHints | null = null;
  private keys = new Set<string>();
  private timer = new THREE.Timer();
  mode: ControlMode = 'orbit';
  onModeChange?: (mode: ControlMode, locked: boolean) => void;
  /** Called every frame with the frame delta (seconds), after camera updates. Set by world-specific AI wiring; the viewer itself never reads it. */
  onTick?: (dt: number) => void;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0b0d17);
    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x3a2a1a, 0.9));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
    sun.position.set(6, 14, 8);
    this.scene.add(sun);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.walk = new PointerLockControls(this.camera, this.renderer.domElement);
    this.walk.addEventListener('lock', () => this.onModeChange?.(this.mode, true));
    this.walk.addEventListener('unlock', () => this.onModeChange?.(this.mode, false));
    this.renderer.domElement.addEventListener('click', () => {
      if (this.mode === 'walk' && !this.walk.isLocked) this.walk.lock();
    });

    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  async load(glb: Uint8Array, hints: CameraHints): Promise<void> {
    const group = await parseGlb(glb);
    if (this.world) {
      this.scene.remove(this.world);
      this.world.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((m) => m.dispose());
      });
    }
    this.world = group;
    this.hints = hints;
    this.scene.add(group);
    this.resetCamera();
  }

  resetCamera(): void {
    if (!this.hints) return;
    const [x, y, z] = this.hints.position;
    this.camera.position.set(x, y + 3, z + 6);
    this.orbit.target.set(...this.hints.lookAt);
    this.camera.lookAt(this.orbit.target);
    this.orbit.update();
  }

  setMode(mode: ControlMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'walk') {
      this.orbit.enabled = false;
      const eye = this.hints?.eyeHeight ?? 1.7;
      if (this.hints) this.camera.position.set(this.hints.position[0], eye, this.hints.position[2]);
      this.camera.lookAt(this.hints ? new THREE.Vector3(...this.hints.lookAt) : new THREE.Vector3());
      this.walk.lock();
    } else {
      this.walk.unlock();
      this.orbit.enabled = true;
      this.resetCamera();
    }
    this.onModeChange?.(mode, this.walk.isLocked);
  }

  private tick(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.mode === 'walk' && this.walk.isLocked) {
      const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 2 : 1;
      const speed = 4 * run * dt;
      const fwd = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
      const side = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
      if (fwd) this.walk.moveForward(fwd * speed);
      if (side) this.walk.moveRight(side * speed);
      const b = this.hints?.bounds;
      if (b) {
        this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, b.min[0], b.max[0]);
        this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, b.min[2], b.max[2]);
      }
      this.camera.position.y = this.hints?.eyeHeight ?? 1.7;
    } else if (this.mode === 'orbit') {
      this.orbit.update();
    }
    this.onTick?.(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
