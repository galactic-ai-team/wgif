import * as THREE from 'three';
import type { Vec3 } from '@wgif/format';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { parseGlb } from './glb.js';
import type { GameState, VehicleDef } from './interactions.js';
import { QualityGovernor } from './quality.js';
import { mergeStatic, type MergeStats } from './merge.js';
import { isSky, sceneBounds } from './sky.js';
import { createRuntime, findNodes, nodeName, type SceneColliders } from './sceneBridge.js';
import type { AgentBody } from './sim/agents.js';
import { LAYER_SOLID, newRayHit } from './sim/colliders.js';
import type { DriveInput, Vehicle } from './sim/vehicle.js';
import { IDLE_INPUT, type Grabbable, type PlayerInput, type RuntimeEvent, type WorldRuntime } from './sim/runtime.js';
import { WorldOpenError, type WorldDocument } from './world.js';

export { parseGlb } from './glb.js';

/** `drive` puts the visitor behind the wheel of the world's vehicle with a chase camera. */
export type ControlMode = 'orbit' | 'walk' | 'drive';

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
  /** Soft contact shadow under it. Moving things do not cast into the shadow map, which is drawn once. */
  blob: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
}

/** A vehicle and the nodes that draw it. */
interface Ride {
  vehicle: Vehicle;
  def: VehicleDef;
  node: THREE.Object3D;
  front: THREE.Object3D[];
  rear: THREE.Object3D[];
  blob: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  /** Footprint of the body, for its contact shadow. */
  size: THREE.Vector3;
}

/** Something a world brings that the viewer draws every frame (an audio visual). */
export interface FrameExtra {
  /** Advances it; returns true while it needs frames drawn. */
  update(dt: number): boolean;
  dispose(): void;
}

interface Flash {
  material: THREE.MeshStandardMaterial;
  base: THREE.Color;
  baseIntensity: number;
  left: number;
}

const ARC_POINTS = 48;
const FLASH_SEC = 0.8;
/** A picture is a texture of at most ~1000 px: rendering it above 1.5 device pixels per CSS pixel only costs fill rate. */
const PICTURE_MAX_PIXEL_RATIO = 1.5;
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
  private rides: Ride[] = [];
  /** The vehicle orbit centres on: the last one driven, else the first. */
  private focus: Ride | null = null;
  /** The look point the chase camera eases toward. */
  private readonly chaseLook = new THREE.Vector3();
  /** Driver controls, read every frame in drive mode (see DriveControls). */
  driveSource: { readonly drive: DriveInput } | null = null;
  private flashes: Flash[] = [];
  private extras: FrameExtra[] = [];
  /** An exact camera for snapshots (a photo world's turned view), instead of the overview formula. */
  private snapPose: { position: THREE.Vector3; target: THREE.Vector3; fov: number } | null = null;
  private overview = { position: new THREE.Vector3(0, 4.7, 14), target: new THREE.Vector3(0, 1, 0) };
  /** What the overview frames (side it is seen from, width across), so a snapshot can frame it for its own shape. */
  private framing = { side: new THREE.Vector3(0, 0, 1), width: 10 };
  private eyeY = 0;
  private renderFrames = 2;
  private shadowsDirty = true;
  /** A picture world (see photo/player.ts): flat unlit surfaces, so no shadow pass, a lower resolution cap and damped orbit even on phones. */
  private pictureWorld = false;
  private readonly coarse: boolean;
  /** The camera as last drawn, so a walker standing still costs no frames. */
  private readonly lastView = new Float64Array(16);
  private renderedLastFrame = false;
  private readonly blobGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly blobTexture = blobTexture();
  /** Draw calls saved by merging the static world (PERF.md fix #1), for the perf overlay. */
  merged: MergeStats = { before: 0, after: 0 };

  constructor(private readonly host: HTMLElement, private readonly input: InputSource) {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.coarse = coarse;
    const dpr = window.devicePixelRatio || 1;
    this.quality = new QualityGovernor({ devicePixelRatio: dpr, mobile: coarse });
    // PERF.md fix #5: MSAA is expensive on dense (mostly phone) screens, where it also matters least. Touch devices never get it.
    this.renderer = new THREE.WebGLRenderer({ antialias: dpr < 2 && !coarse, powerPreference: 'high-performance' });
    // Dee's mobile item 1: never render above 2x. The quality governor may only go lower from here.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral tone mapping keeps the colours a creator authored; filmic curves wash out bright floors.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // PERF.md fix #4: the world is static, so its shadow map is drawn once per load. Moving things
    // get soft contact shadows instead (see `blob`), so play never pays for a shadow pass.
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
    // PERF.md fix #8: damping keeps rendering after the finger lifts; phones skip it.
    this.orbit.enableDamping = !coarse;
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

  /**
   * Draws the open world from its overview (the framing "Reset view" uses) at width x height into
   * a new 2D canvas, for the preview image of an export. Aim arc and edit markers are left out.
   * The main view is put back and redrawn in the same task, so nothing flickers on screen.
   */
  snapshot(width: number, height: number): HTMLCanvasElement | null {
    if (!this.world) return null;
    // Framed like the landscape overview (70° vertical field, whole world across), whatever shape the screen is.
    const aspect = width / height;
    const camera = new THREE.PerspectiveCamera(this.snapPose?.fov ?? 70, aspect, this.camera.near, this.camera.far);
    if (this.snapPose) {
      camera.position.copy(this.snapPose.position);
      camera.lookAt(this.snapPose.target);
    } else {
      const reach = Math.max(2, (this.framing.width / 2 / (Math.tan(THREE.MathUtils.degToRad(35)) * Math.min(Math.max(aspect, 0.4), 1.6))) * 1.05);
      const tilt = THREE.MathUtils.degToRad(30);
      camera.position.copy(this.overview.target).addScaledVector(this.framing.side, Math.cos(tilt) * reach).add(new THREE.Vector3(0, Math.sin(tilt) * reach, 0));
      camera.lookAt(this.overview.target);
    }
    camera.updateProjectionMatrix();
    const shown = { markers: this.markers.visible, arc: this.arc.visible };
    const ratio = this.renderer.getPixelRatio();
    const size = this.renderer.getSize(new THREE.Vector2());
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    try {
      this.markers.visible = false;
      this.arc.visible = false;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.renderer.shadowMap.needsUpdate = true;
      this.renderer.render(this.scene, camera);
      // Copied before the frame is presented, so no preserveDrawingBuffer is needed.
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(this.renderer.domElement, 0, 0, width, height);
    } finally {
      this.markers.visible = shown.markers;
      this.arc.visible = shown.arc;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(size.x, size.y, false);
      this.renderer.shadowMap.needsUpdate = true;
      this.renderer.render(this.scene, this.camera);
      this.invalidate(true);
    }
    return out;
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
      const sky = isSky(mesh);
      mesh.castShadow = !sky && !materials.some((m) => m.transparent);
      mesh.receiveShadow = !sky;
    });
    for (const object of made.runtime.objects.values()) this.bind(object, group);
    for (const def of doc.interactions.vehicles) {
      const vehicle = made.runtime.vehicles.get(def.id);
      if (vehicle) this.bindVehicle(vehicle, def, group);
    }
    // PERF.md fix #1: what never moves becomes a few draw calls. Objects and the props that light up keep their own nodes.
    const keep = new Set<string>([...doc.interactions.objects.map((o) => o.node ?? o.id), ...made.built.props, ...doc.interactions.audio.flatMap((a) => a.react.map((r) => r.node)), ...doc.interactions.photos.flatMap((ph) => [ph.node, ...ph.alsoNodes])]);
    // A world's own sky (extras.wgif.role "sky") stays out of the overview framing and the shadow box.
    const box = sceneBounds(group);
    this.merged = mergeStatic(group, (o) => keep.has(nodeName(o)) || isSky(o));

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
    this.framing = { side: side.clone(), width };
    const aspect = Math.max(0.4, this.host.clientWidth / Math.max(1, this.host.clientHeight));
    const reach = Math.max(2, (width / 2 / (Math.tan(THREE.MathUtils.degToRad(35)) * Math.min(aspect, 1.6))) * 1.05);
    const tilt = THREE.MathUtils.degToRad(30);
    this.overview.target.set(center.x, box.min.y + size.y * 0.25, center.z);
    this.overview.position.copy(this.overview.target).addScaledVector(side, Math.cos(tilt) * reach).add(new THREE.Vector3(0, Math.sin(tilt) * reach, 0));
    this.orbit.maxDistance = Math.max(radius * 4, reach * 2);
    this.orbit.minDistance = 0;
    // A world with a vehicle is about the vehicle: orbit and its preview centre on it.
    const ride = (this.focus = this.rides[0] ?? null);
    if (ride) {
      const v = ride.vehicle;
      const carSide = new THREE.Vector3(spawn[0] - v.pos[0], 0, spawn[2] - v.pos[2]);
      if (carSide.lengthSq() < 1e-6) carSide.set(0.6, 0, 1);
      this.framing = { side: carSide.normalize(), width: Math.max(8, ride.size.z * 2.1) };
      this.focusVehicle(ride, carSide);
      this.orbit.minDistance = Math.max(2, ride.size.z * 0.6);
    }
    // A world with a music visualizer (and no vehicle) is about the visualizer: the overview frames it.
    const vis = ride ? null : doc.interactions.audio.find((a) => a.visualizer)?.visualizer;
    if (vis) {
      const w = vis.radius * 2.7, at = new THREE.Vector3(vis.center[0], Math.max(box.min.y + 0.5, vis.center[1] - 0.6), vis.center[2]);
      // From outside the ring: the formula fits its width, the floor keeps the near bars from filling a wide screen.
      const r = Math.max(vis.radius * 2.3, (w / 2 / (Math.tan(THREE.MathUtils.degToRad(35)) * Math.min(aspect, 1.6))) * 0.9);
      this.framing = { side: side.clone(), width: w };
      this.overview.target.copy(at);
      this.overview.position.copy(at).addScaledVector(side, Math.cos(tilt) * r).add(new THREE.Vector3(0, Math.sin(tilt) * r, 0));
    }
    // A picture rebuilt in 3D starts from the eye it was taken from (so it first looks just like
    // the picture) and orbits around its middle distance; its preview is a small turn to one side.
    const photo = ride || vis ? null : doc.interactions.photos[0];
    this.snapPose = null;
    this.setPictureWorld(!!photo);
    if (photo) {
      const focus = new THREE.Vector3(...photo.focus);
      const eye = photo.eye ? new THREE.Vector3(...photo.eye) : focus.clone().addScaledVector(side, 6);
      if (eye.distanceToSquared(focus) < 1e-4) eye.z += 4;
      // A little behind the eye, so the picture's edges show and it reads as an object.
      const back = eye.clone().sub(focus).multiplyScalar(1.12);
      this.overview.target.copy(focus);
      this.overview.position.copy(focus).add(back);
      const flatSide = new THREE.Vector3(back.x, 0, back.z);
      this.framing = { side: flatSide.lengthSq() > 1e-6 ? flatSide.normalize() : side.clone(), width };
      const turn = back.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-22));
      turn.applyAxisAngle(new THREE.Vector3().crossVectors(turn, new THREE.Vector3(0, 1, 0)).normalize(), THREE.MathUtils.degToRad(6));
      this.snapPose = { position: focus.clone().add(turn.multiplyScalar(1.15)), target: focus.clone(), fov: 50 };
      this.orbit.minDistance = Math.max(0.5, back.length() * 0.25);
      this.orbit.maxDistance = Math.max(this.orbit.maxDistance, back.length() * 4);
    }
    if (this.mode === 'drive' && !made.runtime.drive()) this.mode = 'orbit';
    this.orbit.enabled = this.mode === 'orbit';
    made.runtime.playerEnabled = this.mode === 'walk';
    if (this.mode === 'walk') this.eyeY = made.runtime.player.eye[1];
    else if (this.mode === 'orbit') this.resetCamera();
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

  /** The open world's scene graph (null when none is open). */
  get worldRoot(): THREE.Group | null {
    return this.world;
  }

  /** Adds a per-frame extra for the open world; it is disposed when the world closes. */
  attach(extra: FrameExtra): void {
    this.extras.push(extra);
    this.invalidate();
  }

  /**
   * A picture world draws one unlit surface that needs no shadows, so the shadow pass goes and the
   * pixel ratio is capped at PICTURE_MAX_PIXEL_RATIO. Damping stays on for phones too: with the finger
   * lifted the picture keeps turning for a moment instead of stopping dead, which reads as smoother.
   */
  private setPictureWorld(on: boolean): void {
    const changed = on !== this.pictureWorld;
    this.pictureWorld = on;
    this.orbit.enableDamping = on || !this.coarse;
    if (changed) this.applyQuality();
  }

  /** The quality step now (0 best), so per-frame extras can drop optional work on a slow device. */
  get qualityLevel(): number {
    return this.quality.level;
  }

  /** Slow automatic orbit in orbit view (OrbitControls autoRotateSpeed: 2 = one turn in 30 s), 0 = off. */
  setAutoRotate(speed: number): void {
    this.orbit.autoRotate = speed !== 0;
    this.orbit.autoRotateSpeed = speed;
    this.invalidate();
  }

  /** Where orbit view is centred (for tests and the host). */
  get orbitTarget(): Vec3 {
    const t = this.orbit.target;
    return [t.x, t.y, t.z];
  }

  /** True when the open world has something to drive. */
  get canDrive(): boolean {
    return this.rides.length > 0;
  }

  setMode(mode: ControlMode): void {
    if (mode === this.mode) return;
    const rt = this.runtime;
    if (mode === 'drive' && !rt?.drive()) return;
    const from = this.mode;
    this.mode = mode;
    this.orbit.enabled = mode === 'orbit';
    if (rt) {
      if (mode !== 'walk') rt.drop();
      rt.playerEnabled = mode === 'walk';
      if (mode === 'walk') this.eyeY = rt.player.eye[1];
      if (mode !== 'drive') rt.drive(null);
    }
    const ride = this.rides.find((r) => r.vehicle.id === rt?.driving) ?? this.focus;
    if (ride) this.focus = ride;
    if (mode === 'drive' && ride) {
      this.chaseLook.copy(this.lookPoint(ride.vehicle, ride.vehicle.yaw, ride.vehicle.pos));
    } else if (mode === 'orbit' && from === 'drive' && ride) {
      // Out of the car: orbit it where it stopped, starting from the chase view.
      this.focusVehicle(ride, this.camera.position.clone().sub(vecOf(ride.vehicle.pos)).setY(0));
      this.orbit.target.copy(this.overview.target);
      this.orbit.update();
    } else if (mode === 'orbit') this.resetCamera();
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
    for (const extra of this.extras) extra.dispose();
    this.extras = [];
    this.setAutoRotate(0);
    for (const flash of this.flashes) flash.material.dispose();
    this.flashes = [];
    this.dynamics = [];
    this.rides = [];
    this.focus = null;
    this.bodies.clear();
    for (const root of [this.dynamicRoot, this.world]) {
      root?.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry !== this.blobGeometry) mesh.geometry?.dispose();
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
      node.traverse((o) => (o.castShadow = false));
    } else {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(object.params.radius, 24, 16), new THREE.MeshStandardMaterial({ color: 0xe86a1a, roughness: 0.7 }));
      pivot.add(mesh);
      this.dynamicRoot.add(pivot);
    }
    const blob = this.blob();
    this.dynamicRoot.add(blob);
    this.dynamics.push({ object, pivot, blob });
  }

  /**
   * Ties a vehicle to its node. The node moves to the dynamic root (its origin is the ground point
   * under the body, authored facing -Z), so the static merge and the shadow map leave it alone.
   */
  private bindVehicle(vehicle: Vehicle, def: VehicleDef, world: THREE.Group): void {
    const node = findNodes(world, def.node)[0];
    if (!node) return;
    this.dynamicRoot.attach(node);
    node.position.set(0, 0, 0);
    node.rotation.set(0, 0, 0);
    node.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3());
    node.traverse((o) => (o.castShadow = false));
    const wheels = (names: string[]): THREE.Object3D[] =>
      names.flatMap((n) => findNodes(node, n)).map((w) => {
        w.userData.wgifBase = w.quaternion.clone();
        return w;
      });
    const blob = this.blob();
    blob.material.opacity = 0.6;
    this.dynamicRoot.add(blob);
    this.rides.push({ vehicle, def, node, front: wheels(def.wheels.front), rear: wheels(def.wheels.rear), blob, size });
  }

  /** Draws a vehicle where the simulation has it. Returns true when it moved. */
  private syncRide(rt: WorldRuntime, ride: Ride): boolean {
    const v = ride.vehicle, a = rt.alpha, n = ride.node;
    const x = v.prev[0] + (v.pos[0] - v.prev[0]) * a, y = v.prev[1] + (v.pos[1] - v.prev[1]) * a, z = v.prev[2] + (v.pos[2] - v.prev[2]) * a;
    const yaw = v.prevYaw + (v.yaw - v.prevYaw) * a, pitch = v.prevPitch + (v.pitch - v.prevPitch) * a;
    const moved = n.position.x !== x || n.position.y !== y || n.position.z !== z || n.rotation.y !== yaw || n.rotation.x !== pitch || v.moving;
    if (!moved && ride.blob.visible) return false;
    n.position.set(x, y, z);
    // For a body facing -Z, a positive turn about +X lifts the nose: positive pitch is nose up.
    n.rotation.set(pitch, yaw, 0, 'YXZ');
    for (const w of ride.front) w.quaternion.copy(w.userData.wgifBase as THREE.Quaternion).multiply(q1.setFromAxisAngle(Y_AXIS, v.steer)).multiply(q2.setFromAxisAngle(X_AXIS, -v.wheelSpin));
    for (const w of ride.rear) w.quaternion.copy(w.userData.wgifBase as THREE.Quaternion).multiply(q2.setFromAxisAngle(X_AXIS, -v.wheelSpin));
    const b = ride.blob;
    b.visible = true;
    b.position.set(x, y + 0.015, z);
    b.rotation.y = yaw;
    b.scale.set(ride.size.x * 1.35, 1, ride.size.z * 1.2);
    return true;
  }

  /** Where the chase camera looks: a little ahead of the body, above the roof line. */
  private lookPoint(v: Vehicle, yaw: number, pos: ArrayLike<number>): THREE.Vector3 {
    return lookAt.set(pos[0]! - Math.sin(yaw) * 1.5, pos[1]! + 1.1, pos[2]! - Math.cos(yaw) * 1.5);
  }

  /** Chase camera: behind and above the driven vehicle, easing after it, never through a wall. */
  private chase(rt: WorldRuntime, dt: number): void {
    const ride = this.rides.find((r) => r.vehicle.id === rt.driving);
    if (!ride) return;
    const v = ride.vehicle, n = ride.node, cam = ride.def.camera;
    const yaw = n.rotation.y;
    // Reversing swings the view round only a little: the camera stays behind the car.
    const back = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const pivot = new THREE.Vector3(n.position.x, n.position.y + cam.height * 0.5, n.position.z);
    const want = pivot.clone().addScaledVector(back, cam.distance).add(new THREE.Vector3(0, cam.height * 0.5, 0));
    const dir = want.clone().sub(pivot), dist = dir.length();
    dir.divideScalar(dist);
    if (rt.colliders.raycast(pivot.x, pivot.y, pivot.z, dir.x, dir.y, dir.z, dist, LAYER_SOLID, ray)) want.copy(pivot).addScaledVector(dir, Math.max(0.5, ray.t - 0.3));
    const k = 1 - Math.exp(-dt * (v.bumped ? 3 : 5));
    this.camera.position.lerp(want, k);
    if (rt.colliders.raycast(this.camera.position.x, this.camera.position.y + 2, this.camera.position.z, 0, -1, 0, 4, LAYER_SOLID, ray) && this.camera.position.y < ray.y + 0.4) {
      this.camera.position.y = ray.y + 0.4;
    }
    this.chaseLook.lerp(this.lookPoint(v, yaw, [n.position.x, n.position.y, n.position.z]), 1 - Math.exp(-dt * 10));
    this.camera.lookAt(this.chaseLook);
  }

  /** Centres the orbit overview on a vehicle where it stands, seen from `from` (a direction on the ground). */
  private focusVehicle(ride: Ride, from: THREE.Vector3): void {
    const v = ride.vehicle;
    const dir = from.lengthSq() > 1e-6 ? from.clone().normalize() : new THREE.Vector3(0.6, 0, 1).normalize();
    const reach = Math.max(5, ride.size.z * 1.9);
    const tilt = THREE.MathUtils.degToRad(22);
    this.overview.target.set(v.pos[0], v.pos[1] + ride.size.y * 0.45, v.pos[2]);
    this.overview.position.copy(this.overview.target).addScaledVector(dir, Math.cos(tilt) * reach).add(new THREE.Vector3(0, Math.sin(tilt) * reach, 0));
    this.framing.side.copy(dir);
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
    const visor = new THREE.Mesh(new THREE.BoxGeometry(body.radius * 1.3, 0.1, 0.08), new THREE.MeshStandardMaterial({ color: 0x10121f, roughness: 0.3 }));
    visor.position.set(0, body.height - body.radius * 0.9, -body.radius * 0.93);
    const blob = this.blob();
    blob.position.y = 0.012;
    blob.scale.setScalar(body.radius * 3.2);
    blob.material.opacity = 0.42;
    group.add(torso, visor, blob);
    this.dynamicRoot.add(group);
    this.bodies.set(role, group);
    return group;
  }

  /** Renderer statistics for the `?perf=1` overlay (docs/PERF.md). */
  stats(): { calls: number; triangles: number; level: number; pixelRatio: number; shadows: boolean; merged: MergeStats; frames: number } {
    const { calls, triangles, frame } = this.renderer.info.render;
    const q = this.quality.settings;
    return { calls, triangles, level: this.quality.level, pixelRatio: q.pixelRatio, shadows: q.shadows, merged: this.merged, frames: frame };
  }

  /** A soft round shadow on the ground, for things that move. */
  private blob(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
    const mesh = new THREE.Mesh(this.blobGeometry, new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: this.blobTexture, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    mesh.renderOrder = 1;
    mesh.visible = false;
    return mesh;
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
      if (this.mode === 'drive') {
        const d = this.driveSource?.drive;
        rt.driveInput.throttle = d?.throttle ?? 0;
        rt.driveInput.steer = d?.steer ?? 0;
        rt.driveInput.brake = d?.brake ?? false;
      }
      rt.update(dt, walking ? this.input.input : IDLE_INPUT);
      active = this.sync(rt, dt);
      this.hooks.onFrame?.(rt, rt.drain(), dt);
    }
    if (this.mode === 'orbit' && this.orbit.update()) active = true;
    if (this.animateFlashes(dt)) active = true;
    for (const extra of this.extras) if (extra.update(dt)) active = true;
    // Idle render: a walker standing still in a still world costs no frames, just like orbit view.
    this.camera.updateMatrixWorld();
    if (!sameMatrix(this.lastView, this.camera.matrixWorld.elements)) active = true;
    if (!active && this.renderFrames <= 0) {
      this.renderedLastFrame = false;
      return;
    }
    this.renderFrames--;
    this.lastView.set(this.camera.matrixWorld.elements);
    // Only back-to-back frames say anything about speed; the first one after an idle gap does not.
    if (this.renderedLastFrame && this.quality.sample(dt * 1000)) this.applyQuality();
    this.renderedLastFrame = true;
    if (this.shadowsDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowsDirty = false;
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Copies simulation state into the scene. Returns true while something is moving. */
  private sync(rt: WorldRuntime, dt: number): boolean {
    let moving = false;
    for (const { object, pivot, blob } of this.dynamics) {
      const a = rt.alpha, p = object.prev, c = object.body.pos;
      const x = p[0] + (c[0] - p[0]) * a, y = p[1] + (c[1] - p[1]) * a, z = p[2] + (c[2] - p[2]) * a;
      if (pivot.position.x !== x || pivot.position.y !== y || pivot.position.z !== z) {
        moving = true;
        pivot.position.set(x, y, z);
      }
      const vx = object.body.vel[0], vz = object.body.vel[2];
      const speed = Math.hypot(vx, vz);
      if (!object.held && speed > 0.01) pivot.rotateOnWorldAxis(axis.set(vz / speed, 0, -vx / speed), (speed * dt) / object.params.radius);
      this.placeBlob(rt, blob, x, y, z, object.params.radius);
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

    for (const ride of this.rides) {
      const was = this.mode === 'orbit' && ride === this.focus ? ride.node.position.clone() : null;
      if (!this.syncRide(rt, ride)) continue;
      moving = true;
      // Orbit follows the car it centres on while it rolls to a stop after the driver got out.
      if (was) {
        const d = ride.node.position.clone().sub(was);
        this.orbit.target.add(d);
        this.camera.position.add(d);
        this.overview.target.add(d);
        this.overview.position.add(d);
      }
    }
    if (this.mode === 'drive') this.chase(rt, dt);

    if (this.mode === 'walk') {
      const eye = rt.player.eyeInto(eyeAt);
      // Steps and kerbs move the feet instantly; ease the eye so the view does not jolt. Snap the
      // last millimetre, or the camera would creep forever and the frame would never go idle.
      const gap = eye[1] - this.eyeY;
      this.eyeY = Math.abs(gap) > 1 || Math.abs(gap) < 1e-3 ? eye[1] : this.eyeY + gap * Math.min(1, dt * 14);
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

  /** Puts a contact shadow on the ground under a moving thing: larger and fainter the higher it is. */
  private placeBlob(rt: WorldRuntime, blob: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>, x: number, y: number, z: number, radius: number): void {
    if (!rt.colliders.raycast(x, y, z, 0, -1, 0, 25, LAYER_SOLID, ray)) {
      blob.visible = false;
      return;
    }
    const height = Math.max(0, y - radius - ray.y);
    blob.visible = true;
    blob.position.set(x, ray.y + 0.012, z);
    blob.scale.setScalar(radius * 2.6 * (1 + height * 0.35));
    blob.material.opacity = 0.55 * Math.max(0, 1 - height / 4);
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
    this.renderer.setPixelRatio(this.pictureWorld ? Math.min(q.pixelRatio, PICTURE_MAX_PIXEL_RATIO) : q.pixelRatio);
    this.sun.castShadow = q.shadows && !this.pictureWorld;
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
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const lookAt = new THREE.Vector3();
const vecOf = (p: ArrayLike<number>): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);
const eyeAt: Vec3 = [0, 0, 0];
const glow = new THREE.Color(1, 0.62, 0.12);

function sameMatrix(a: Float64Array, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A 64×64 radial falloff, generated here: no image file to ship or cache. */
function blobTexture(): THREE.DataTexture {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, 1 - r) ** 1.6;
      data.set([a * 255, a * 255, a * 255, 255], (y * size + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.needsUpdate = true;
  return texture;
}
