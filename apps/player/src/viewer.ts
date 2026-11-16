import * as THREE from 'three';
import type { Vec3 } from '@wgif/format';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { parseGlb } from './glb.js';
import type { GameState } from './interactions.js';
import { QualityGovernor } from './quality.js';
import { createRuntime, findNodes, type SceneColliders } from './sceneBridge.js';
import type { AgentBody } from './sim/agents.js';
import { LAYER_SOLID, newRayHit } from './sim/colliders.js';
import { IDLE_INPUT, type Grabbable, type PlayerInput, type RuntimeEvent, type WorldRuntime } from './sim/runtime.js';
import { WorldOpenError, type WorldDocument } from './world.js';

export { parseGlb } from './glb.js';

export type ControlMode = 'orbit' | 'walk';

/** What the viewer needs from the input layer each frame. */
export interface InputSource {
  readonly input: PlayerInput;
  /** Look movement since the last call, in radians: [yaw, pitch]. */
  consumeLook(): [number, number];
}

export interface ViewerHooks {
  onModeChange?(mode: ControlMode): void;
  /** Called once per frame after the simulation advanced, with the events it raised. */
  onFrame?(runtime: WorldRuntime, events: RuntimeEvent[], dt: number): void;
}

interface Dynamic {
  object: Grabbable;
  pivot: THREE.Object3D;
}

interface Flash {
  material: THREE.MeshStandardMaterial;
  base: THREE.Color;
  baseIntensity: number;
  left: number;
}

const ARC_POINTS = 48;
const FLASH_SEC = 0.8;
const ray = newRayHit();

/**
 * Renders a world and drives its simulation: orbit and first-person cameras, lighting and shadows,
 * the moving objects, the aim arc and the edit markers. Game rules live in `sim/`; this class only
 * draws what the runtime says and feeds it input.
 */
export class WorldViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 600);
  readonly quality: QualityGovernor;
  runtime: WorldRuntime | null = null;
  mode: ControlMode = 'orbit';
  hooks: ViewerHooks = {};

  private readonly orbit: OrbitControls;
  private readonly sun = new THREE.DirectionalLight(0xfff1dd, 1.7);
  private readonly dynamicRoot = new THREE.Group();
  private readonly markers = new THREE.Group();
  private readonly ballMarker: THREE.Mesh;
  private readonly spawnMarker: THREE.Mesh;
  private readonly arc: THREE.Points;
  private readonly arcPositions = new Float32Array(ARC_POINTS * 3);
  private readonly timer = new THREE.Timer();
  private world: THREE.Group | null = null;
  private readonly bodies = new Map<string, THREE.Object3D>();
  private dynamics: Dynamic[] = [];
  private flashes: Flash[] = [];
  private overview = { position: new THREE.Vector3(0, 4.7, 14), target: new THREE.Vector3(0, 1, 0) };
  private eyeY = 0;
  private renderFrames = 2;
  private shadowsDirty = true;

  constructor(private readonly host: HTMLElement, private readonly input: InputSource) {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const dpr = window.devicePixelRatio || 1;
    this.quality = new QualityGovernor({ devicePixelRatio: dpr, mobile: coarse });
    // MSAA is expensive on dense phone screens, where it also matters least.
    this.renderer = new THREE.WebGLRenderer({ antialias: !(coarse && dpr >= 2), powerPreference: 'high-performance' });
    // Dee's mobile item 1: never render above 2x. The quality governor may only go lower from here.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral tone mapping keeps the colours a creator authored; filmic curves wash out bright floors.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The world is static: shadows are redrawn only when something that casts one has moved.
    this.renderer.shadowMap.autoUpdate = false;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
    this.renderer.domElement.addEventListener('webglcontextrestored', () => this.invalidate(true));

    this.scene.background = new THREE.Color(0x070912);
    this.scene.add(this.backdrop());
    this.scene.add(new THREE.HemisphereLight(0xcfd9ff, 0x3b2f25, 0.4));
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    // Image-based light from a small procedural room: gives metal and glass something to reflect. No assets.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;
    pmrem.dispose();

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.addEventListener('change', () => this.invalidate());

    const arcGeometry = new THREE.BufferGeometry();
    arcGeometry.setAttribute('position', new THREE.BufferAttribute(this.arcPositions, 3));
    this.arc = new THREE.Points(arcGeometry, new THREE.PointsMaterial({ size: 0.07, color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    this.arc.frustumCulled = false;
    this.arc.visible = false;

    const flat = (geometry: THREE.BufferGeometry, color: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 2;
      return mesh;
    };
    this.ballMarker = flat(new THREE.RingGeometry(0.2, 0.28, 40), 0xffa040);
    this.spawnMarker = flat(new THREE.CircleGeometry(0.3, 3), 0x60d0ff);
    this.markers.add(this.ballMarker, this.spawnMarker);
    this.markers.visible = false;
    this.scene.add(this.dynamicRoot, this.arc, this.markers);

    new ResizeObserver(() => this.resize()).observe(host);
    this.applyQuality();
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Loads a world's scene and starts its simulation from the given state. */
  async load(doc: WorldDocument, state: GameState): Promise<{ runtime: WorldRuntime; built: SceneColliders }> {
    const bytes = doc.world.files[doc.world.manifest.entry.scene];
    if (!bytes) throw new WorldOpenError('Scene file missing');
    let group: THREE.Group;
    try {
      group = await parseGlb(bytes);
    } catch (e) {
      throw new WorldOpenError(`The scene could not be read: ${(e as Error).message ?? e}`);
    }
    this.unload();
    this.world = group;
    this.scene.add(group);
    group.updateWorldMatrix(true, true);
    const made = createRuntime(doc, group, state);
    this.runtime = made.runtime;

    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mesh.castShadow = !materials.some((m) => m.transparent);
      mesh.receiveShadow = true;
    });
    for (const object of made.runtime.objects.values()) this.bind(object, group);

    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    this.sun.position.copy(center).addScaledVector(new THREE.Vector3(0.4, 1, 0.3).normalize(), radius * 1.6);
    this.sun.target.position.copy(center);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 0.1;
    cam.far = radius * 3.6;
    cam.updateProjectionMatrix();
    this.camera.far = Math.max(600, radius * 12);

    // Overview for orbit mode: the whole world in frame, seen from the side the visitor starts on.
    const size = box.getSize(new THREE.Vector3());
    const spawn = made.runtime.playerSpawn.position;
    const side = new THREE.Vector3(spawn[0] - center.x, 0, spawn[2] - center.z);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    side.normalize();
    const width = Math.abs(side.x) * size.z + Math.abs(side.z) * size.x;
    const aspect = Math.max(0.4, this.host.clientWidth / Math.max(1, this.host.clientHeight));
    const reach = Math.max(2, (width / 2 / (Math.tan(THREE.MathUtils.degToRad(35)) * Math.min(aspect, 1.6))) * 1.05);
    const tilt = THREE.MathUtils.degToRad(30);
    this.overview.target.set(center.x, box.min.y + size.y * 0.25, center.z);
    this.overview.position.copy(this.overview.target).addScaledVector(side, Math.cos(tilt) * reach).add(new THREE.Vector3(0, Math.sin(tilt) * reach, 0));
    this.orbit.maxDistance = Math.max(radius * 4, reach * 2);
    made.runtime.playerEnabled = this.mode === 'walk';
    if (this.mode === 'walk') this.eyeY = made.runtime.player.eye[1];
    else this.resetCamera();
    this.resize();
    this.invalidate(true);
    return made;
  }

  resetCamera(): void {
    this.camera.position.copy(this.overview.position);
    this.orbit.target.copy(this.overview.target);
    this.camera.lookAt(this.orbit.target);
    this.orbit.update();
    this.invalidate();
  }

  setMode(mode: ControlMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const rt = this.runtime;
    this.orbit.enabled = mode === 'orbit';
    if (rt) {
      if (mode === 'orbit') rt.drop();
      rt.playerEnabled = mode === 'walk';
      if (mode === 'walk') this.eyeY = rt.player.eye[1];
    }
    if (mode === 'orbit') this.resetCamera();
    this.invalidate();
    this.hooks.onModeChange?.(mode);
  }

  /** Where the first-person view ray meets solid ground or a wall, and which way that surface faces. For placing things in edit mode. */
  aimPoint(maxDistance = 40): { point: Vec3; normal: Vec3 } | null {
    const rt = this.runtime;
    if (!rt) return null;
    const e = rt.player.eye, f = rt.player.forward;
    if (!rt.colliders.raycast(e[0], e[1], e[2], f[0], f[1], f[2], maxDistance, LAYER_SOLID, ray)) return null;
    return { point: [ray.x, ray.y, ray.z], normal: [ray.nx, ray.ny, ray.nz] };
  }

  /** Shows the spawn markers while editing. */
  setMarkers(visible: boolean): void {
    this.markers.visible = visible;
    this.invalidate();
  }

  /** Lights up a node for a moment (a rim after a basket). */
  flash(name: string): void {
    if (!this.world) return;
    for (const node of findNodes(this.world, name)) {
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const material = mesh.isMesh && !Array.isArray(mesh.material) ? (mesh.material as THREE.MeshStandardMaterial) : null;
        if (!material?.emissive) return;
        let flash = this.flashes.find((f) => f.material === material);
        if (!flash) {
          // Give the node its own material so other nodes sharing it do not light up too.
          const own = material.clone();
          mesh.material = own;
          flash = { material: own, base: own.emissive.clone(), baseIntensity: own.emissiveIntensity, left: 0 };
          this.flashes.push(flash);
        }
        flash.left = FLASH_SEC;
      });
    }
  }

  /** Asks for a redraw. Orbit view only renders when something has changed, to save battery. */
  invalidate(shadows = false): void {
    this.renderFrames = Math.max(this.renderFrames, 3);
    if (shadows) this.shadowsDirty = true;
  }

  private unload(): void {
    for (const flash of this.flashes) flash.material.dispose();
    this.flashes = [];
    this.dynamics = [];
    this.bodies.clear();
    for (const root of [this.dynamicRoot, this.world]) {
      root?.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        for (const m of Array.isArray(material) ? material : material ? [material] : []) {
          for (const value of Object.values(m)) if ((value as THREE.Texture | null)?.isTexture) (value as THREE.Texture).dispose();
          m.dispose();
        }
      });
    }
    this.dynamicRoot.clear();
    if (this.world) this.scene.remove(this.world);
    this.world = null;
    this.runtime = null;
    this.arc.visible = false;
  }

  /** Ties a simulated object to the scene node that draws it (or to a stand-in sphere if it has none). */
  private bind(object: Grabbable, world: THREE.Group): void {
    const node = findNodes(world, object.node ?? object.id)[0];
    const pivot = new THREE.Group();
    if (node) {
      // Pivot at the node's visual centre so it can roll about it wherever its origin is.
      new THREE.Box3().setFromObject(node).getCenter(pivot.position);
      this.dynamicRoot.add(pivot);
      pivot.attach(node);
    } else {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(object.params.radius, 24, 16), new THREE.MeshStandardMaterial({ color: 0xe86a1a, roughness: 0.7 }));
      mesh.castShadow = true;
      pivot.add(mesh);
      this.dynamicRoot.add(pivot);
    }
    this.dynamics.push({ object, pivot });
  }

  /** A simple stand-in figure for an agent: a capsule with a visor showing which way it faces. */
  private figure(role: string, body: AgentBody): THREE.Object3D {
    const group = new THREE.Group();
    group.name = role;
    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(body.radius, Math.max(0.1, body.height - body.radius * 2), 6, 16),
      new THREE.MeshStandardMaterial({ color: body.color, roughness: 0.55 }),
    );
    torso.position.y = body.height / 2;
    torso.castShadow = true;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(body.radius * 1.3, 0.1, 0.08), new THREE.MeshStandardMaterial({ color: 0x10121f, roughness: 0.3 }));
    visor.position.set(0, body.height - body.radius * 0.9, -body.radius * 0.93);
    group.add(torso, visor);
    this.dynamicRoot.add(group);
    this.bodies.set(role, group);
    return group;
  }

  /** Renderer statistics for the `?perf=1` overlay (docs/PERF.md). */
  stats(): { calls: number; triangles: number; level: number; pixelRatio: number; shadows: boolean } {
    const { calls, triangles } = this.renderer.info.render;
    const q = this.quality.settings;
    return { calls, triangles, level: this.quality.level, pixelRatio: q.pixelRatio, shadows: q.shadows };
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const rt = this.runtime;
    let active = false;
    if (rt) {
      const walking = this.mode === 'walk';
      if (walking) {
        const [yaw, pitch] = this.input.consumeLook();
        if (yaw !== 0 || pitch !== 0) rt.player.look(yaw, pitch);
      }
      rt.update(dt, walking ? this.input.input : IDLE_INPUT);
      active = this.sync(rt, dt) || walking;
      this.hooks.onFrame?.(rt, rt.drain(), dt);
    }
    if (this.mode === 'orbit' && this.orbit.update()) active = true;
    if (this.animateFlashes(dt)) active = true;
    if (!active && this.renderFrames <= 0) return;
    this.renderFrames--;
    if (this.quality.sample(dt * 1000)) this.applyQuality();
    if (this.shadowsDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowsDirty = false;
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Copies simulation state into the scene. Returns true while something is moving. */
  private sync(rt: WorldRuntime, dt: number): boolean {
    let moving = false;
    for (const { object, pivot } of this.dynamics) {
      const a = rt.alpha, p = object.prev, c = object.body.pos;
      const x = p[0] + (c[0] - p[0]) * a, y = p[1] + (c[1] - p[1]) * a, z = p[2] + (c[2] - p[2]) * a;
      if (pivot.position.x !== x || pivot.position.y !== y || pivot.position.z !== z) {
        moving = true;
        pivot.position.set(x, y, z);
      }
      const vx = object.body.vel[0], vz = object.body.vel[2];
      const speed = Math.hypot(vx, vz);
      if (!object.held && speed > 0.01) pivot.rotateOnWorldAxis(axis.set(vz / speed, 0, -vx / speed), (speed * dt) / object.params.radius);
    }
    for (const { role, body } of rt.bodies) {
      const figure = this.bodies.get(role) ?? this.figure(role, body);
      const [x, y, z] = body.position;
      if (figure.position.x !== x || figure.position.y !== y || figure.position.z !== z || figure.rotation.y !== body.heading) {
        moving = true;
        figure.position.set(x, y, z);
        figure.rotation.y = body.heading;
      }
    }
    if (this.bodies.size > rt.bodies.length) {
      for (const [role, figure] of this.bodies) {
        if (rt.bodies.some((b) => b.role === role)) continue;
        this.dynamicRoot.remove(figure);
        this.bodies.delete(role);
        moving = true;
      }
    }
    if (moving) this.shadowsDirty = true;

    if (this.mode === 'walk') {
      const eye = rt.player.eye;
      // Steps and kerbs move the feet instantly; ease the eye so the view does not jolt.
      const gap = eye[1] - this.eyeY;
      this.eyeY = Math.abs(gap) > 1 ? eye[1] : this.eyeY + gap * Math.min(1, dt * 14);
      this.camera.position.set(eye[0], this.eyeY, eye[2]);
      this.camera.rotation.set(rt.player.pitch, rt.player.yaw, 0, 'YXZ');
    }

    if (rt.charging) {
      const count = rt.aimArc(rt.power, this.arcPositions);
      this.arc.geometry.setDrawRange(0, count);
      (this.arc.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.arc.material as THREE.PointsMaterial).color.setHex(rt.aimLocked ? 0x7dff9a : 0xffffff);
      this.arc.visible = count > 0;
    } else if (this.arc.visible) {
      this.arc.visible = false;
      moving = true;
    }

    if (this.markers.visible) {
      const ball = rt.shootout ? rt.objects.get(rt.shootout.def.ball) : rt.objects.values().next().value;
      this.ballMarker.visible = !!ball;
      if (ball) this.ballMarker.position.set(ball.spawn[0], ball.spawn[1] - ball.params.radius + 0.03, ball.spawn[2]);
      const spawn = rt.playerSpawn;
      this.spawnMarker.position.set(spawn.position[0], spawn.position[1] - rt.player.eyeHeight + 0.04, spawn.position[2]);
      if (spawn.lookAt) this.spawnMarker.rotation.z = Math.atan2(-(spawn.lookAt[0] - spawn.position[0]), -(spawn.lookAt[2] - spawn.position[2])) + Math.PI / 2;
    }
    return moving || rt.charging || !!rt.shootout?.running;
  }

  private animateFlashes(dt: number): boolean {
    let any = false;
    for (const flash of this.flashes) {
      if (flash.left <= 0) continue;
      flash.left = Math.max(0, flash.left - dt);
      const k = flash.left / FLASH_SEC;
      flash.material.emissive.copy(flash.base).lerp(glow, k);
      flash.material.emissiveIntensity = flash.baseIntensity + (1.6 - flash.baseIntensity) * k;
      any = true;
    }
    return any;
  }

  private applyQuality(): void {
    const q = this.quality.settings;
    this.renderer.setPixelRatio(q.pixelRatio);
    this.sun.castShadow = q.shadows;
    if (this.sun.shadow.mapSize.x !== q.shadowMapSize) {
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.resize();
    this.invalidate(true);
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Hold the horizontal field of view on tall phone screens, so a portrait view is not a keyhole.
    this.camera.fov = aspect >= 1 ? 70 : Math.min(100, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(35)) / aspect)));
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /** A dark gradient dome with a few stars: the default sky for worlds that do not bring their own. */
  private backdrop(): THREE.Object3D {
    const group = new THREE.Group();
    const dome = new THREE.SphereGeometry(500, 32, 16);
    const colors: number[] = [];
    const low = new THREE.Color(0x1a2140), high = new THREE.Color(0x05060d), c = new THREE.Color();
    const pos = dome.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      c.copy(low).lerp(high, THREE.MathUtils.clamp(pos.getY(i) / 500 + 0.15, 0, 1) ** 0.6);
      colors.push(c.r, c.g, c.b);
    }
    dome.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    group.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false })));
    // Fixed seed: the same sky every time, on every device.
    let seed = 1234567;
    const random = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const stars: number[] = [];
    for (let i = 0; i < 700; i++) {
      const y = 0.08 + random() * 0.92, a = random() * Math.PI * 2, r = Math.sqrt(1 - y * y);
      stars.push(Math.cos(a) * r * 480, y * 480, Math.sin(a) * r * 480);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
    group.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xcdd6ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false, fog: false })));
    group.renderOrder = -1;
    return group;
  }
}

const axis = new THREE.Vector3();
const glow = new THREE.Color(1, 0.62, 0.12);
