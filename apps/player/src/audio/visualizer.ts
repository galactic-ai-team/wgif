import * as THREE from 'three';
import type { AudioDef, AudioReact } from '../interactions.js';
import { findNodes } from '../sceneBridge.js';
import type { SpectrumAnalysis } from './analysis.js';

/**
 * The player's built-in audio-reactive visual, drawn around `visualizer.center`:
 * - a crown of frequency bars (a ring on the floor and its mirror hanging above), one instanced draw,
 * - a core sphere whose surface is pushed out by the spectrum and the bass,
 * - two halo rings that spin with the mids,
 * - particle bursts thrown off the core on every beat,
 * - colours that drift and brighten with the energy.
 * Plus `react[]`: scene nodes that scale or glow with a band.
 * Everything is a few draw calls and a CPU-side sphere of 2.5k vertices, cheap enough for phones.
 */
const PARTICLES = 900;
const FLIP = new THREE.Matrix4().makeRotationX(Math.PI);
const size = new THREE.Vector3();
const BURST = 140;
const PARTICLE_LIFE = 1.8;

interface Reactor {
  def: AudioReact;
  node: THREE.Object3D;
  base: THREE.Vector3;
  materials: { m: THREE.MeshStandardMaterial; base: number }[];
}

export interface VisualStats {
  /** Mean radius of the core relative to its rest size (1 = at rest). */
  coreScale: number;
  /** Tallest bar, metres. */
  barMax: number;
  particles: number;
  hue: number;
}

export class Visualizer {
  readonly group = new THREE.Group();
  private readonly bars: THREE.InstancedMesh | null = null;
  private readonly core: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private readonly restPos: Float32Array | null = null;
  private readonly lat: Float32Array | null = null;
  private readonly halos: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly glow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null;
  private readonly points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private readonly pPos = new Float32Array(PARTICLES * 3);
  private readonly pVel = new Float32Array(PARTICLES * 3);
  private readonly pCol = new Float32Array(PARTICLES * 3);
  private readonly pLife = new Float32Array(PARTICLES);
  private nextParticle = 0;
  private time = 0;
  private hueShift = 0;
  private reactors: Reactor[] = [];
  private seed = 7;
  readonly stats: VisualStats = { coreScale: 1, barMax: 0, particles: 0, hue: 0 };
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(private readonly def: AudioDef, world: THREE.Object3D | null) {
    const v = def.visualizer;
    if (v) {
      this.group.position.set(...v.center);
      const n = v.bars;
      const bar = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.1 });
      this.bars = new THREE.InstancedMesh(bar, mat, n * 2);
      this.bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 2 * 3), 3);
      this.bars.frustumCulled = false;
      // Bars and emissive colour share the instance colour: MeshStandardMaterial multiplies both by it.
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vColor.rgb;');
      };
      this.group.add(this.bars);

      const coreR = v.radius * 0.17;
      const geo = new THREE.IcosahedronGeometry(coreR, 4);
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      this.restPos = new Float32Array(pos.array as Float32Array);
      this.lat = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) this.lat[i] = Math.acos(Math.max(-1, Math.min(1, pos.getY(i) / coreR))) / Math.PI;
      this.core = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x223355, emissive: 0x8040ff, emissiveIntensity: 0.8, roughness: 0.25, metalness: 0.55, flatShading: true }));
      this.core.position.y = v.radius * 0.12;
      this.group.add(this.core);

      for (const [r, tube, tilt] of [[coreR * 1.7, 0.05, 0.35], [coreR * 2.2, 0.035, -0.6]] as const) {
        const halo = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 96), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.rotation.x = Math.PI / 2 + tilt;
        halo.position.y = this.core.position.y;
        this.halos.push(halo);
        this.group.add(halo);
      }

      this.glow = new THREE.Mesh(new THREE.CircleGeometry(v.radius * 1.25, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, alphaMap: radialTexture(), transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
      this.glow.position.y = -v.center[1] + 0.03;
      this.group.add(this.glow);

      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
      pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
      this.points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.22, map: radialTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      this.points.frustumCulled = false;
      this.points.position.y = this.core.position.y;
      this.group.add(this.points);
      this.pLife.fill(0);
      this.pPos.fill(1e6); // parked far away until used
    }
    if (world) this.bindReactors(world);
    this.update(null, 0, false);
  }

  /** Advances the visual. `a` is null when there is no analysis yet (draws the rest pose). */
  update(a: SpectrumAnalysis | null, dt: number, playing: boolean): void {
    this.time += dt;
    const v = this.def.visualizer;
    const energy = a?.energy ?? 0, bass = a?.bass ?? 0, mid = a?.mid ?? 0, treble = a?.treble ?? 0;
    this.hueShift = (this.hueShift + dt * (0.015 + energy * 0.08)) % 1;
    const hue = ((v?.hue ?? 0.75) + this.hueShift) % 1;
    this.stats.hue = hue;

    if (v && this.bars) {
      const n = v.bars, levels = a?.bars;
      let barMax = 0;
      for (let i = 0; i < n; i++) {
        // Mirror the spectrum round the ring so bass sits at front and back.
        const k = i < n / 2 ? i * 2 : (n - 1 - i) * 2 + 1;
        const level = levels ? (levels[Math.min(levels.length - 1, Math.floor((k / n) * levels.length))] ?? 0) : 0.18 + 0.12 * Math.sin(i * 0.4);
        const h = 0.15 + level * v.radius * 0.75;
        barMax = Math.max(barMax, h);
        const ang = (i / n) * Math.PI * 2, x = Math.sin(ang) * v.radius, z = Math.cos(ang) * v.radius;
        const w = ((Math.PI * 2 * v.radius) / n) * 0.62;
        this.color.setHSL((hue + (i / n) * 0.35) % 1, 0.85, 0.42 + level * 0.25);
        const y0 = -v.center[1];
        this.matrix.makeRotationY(ang).scale(size.set(w, h, w * 0.8)).setPosition(x, y0, z);
        this.bars.setMatrixAt(i, this.matrix);
        this.bars.setColorAt(i, this.color);
        // The hanging mirror, a little shorter.
        this.matrix.makeRotationY(ang).multiply(FLIP).scale(size.set(w, h * 0.7, w * 0.8)).setPosition(x, y0 + v.radius * 1.35, z);
        this.bars.setMatrixAt(i + n, this.matrix);
        this.bars.setColorAt(i + n, this.color);
      }
      this.bars.instanceMatrix.needsUpdate = true;
      this.bars.instanceColor!.needsUpdate = true;
      this.stats.barMax = barMax;
    }

    if (v && this.core && this.restPos && this.lat) {
      const pos = this.core.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array, rest = this.restPos, levels = a?.bars, t = this.time;
      let sum = 0;
      for (let i = 0; i < pos.count; i++) {
        const x = rest[i * 3]!, y = rest[i * 3 + 1]!, z = rest[i * 3 + 2]!;
        const band = levels ? (levels[Math.floor(this.lat[i]! * (levels.length - 1))] ?? 0) : 0;
        const wobble = Math.sin(x * 2.1 + t * 1.7) * Math.sin(y * 2.3 + t * 1.3) * Math.sin(z * 1.9 + t * 1.1);
        const s = 1 + bass * 0.15 + band * 0.5 * (0.5 + 0.5 * wobble) + wobble * (0.05 + mid * 0.1);
        arr[i * 3] = x * s; arr[i * 3 + 1] = y * s; arr[i * 3 + 2] = z * s;
        sum += s;
      }
      pos.needsUpdate = true;
      this.core.geometry.computeBoundingSphere();
      this.stats.coreScale = sum / pos.count;
      this.core.rotation.y += dt * (0.2 + energy * 0.8);
      this.core.material.emissive.setHSL((hue + 0.5) % 1, 0.85, 0.28 + bass * 0.2);
      this.core.material.emissiveIntensity = 0.45 + energy * 0.9;
      this.halos.forEach((h, k) => {
        h.rotation.z += dt * (k ? -1 : 1) * (0.3 + mid * 2.5);
        h.scale.setScalar(1 + (k ? treble : bass) * 0.25);
        h.material.color.setHSL((hue + 0.15 * (k + 1)) % 1, 0.9, 0.55);
        h.material.opacity = 0.35 + (k ? treble : mid) * 0.6;
      });
      if (this.glow) {
        this.glow.material.color.setHSL(hue, 0.9, 0.5);
        this.glow.material.opacity = 0.12 + bass * 0.5;
      }
    }

    if (this.points) this.updateParticles(dt, playing && !!a?.beat, hue, bass);
    for (const r of this.reactors) this.react(r, a);
  }

  /** True while something is still moving after the music stopped (particles flying, bars falling). */
  get settling(): boolean {
    return this.stats.particles > 0;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat) {
        for (const value of Object.values(mat)) if ((value as THREE.Texture | null)?.isTexture) (value as THREE.Texture).dispose();
        mat.dispose();
      }
    });
    for (const r of this.reactors) {
      r.node.scale.copy(r.base);
      for (const { m, base } of r.materials) m.emissiveIntensity = base;
    }
    this.reactors = [];
  }

  private updateParticles(dt: number, beat: boolean, hue: number, bass: number): void {
    const p = this.pPos, vel = this.pVel, life = this.pLife, col = this.pCol;
    const r0 = (this.def.visualizer?.radius ?? 7) * 0.17;
    if (beat) {
      for (let k = 0; k < BURST; k++) {
        const i = this.nextParticle;
        this.nextParticle = (i + 1) % PARTICLES;
        const u = this.rand() * 2 - 1, th = this.rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        const dx = s * Math.cos(th), dy = u, dz = s * Math.sin(th);
        const speed = 3 + this.rand() * 5 + bass * 4;
        p[i * 3] = dx * r0; p[i * 3 + 1] = dy * r0; p[i * 3 + 2] = dz * r0;
        vel[i * 3] = dx * speed; vel[i * 3 + 1] = dy * speed; vel[i * 3 + 2] = dz * speed;
        life[i] = PARTICLE_LIFE;
        this.color.setHSL((hue + 0.5 + this.rand() * 0.2) % 1, 1, 0.6);
        col[i * 3] = this.color.r; col[i * 3 + 1] = this.color.g; col[i * 3 + 2] = this.color.b;
      }
    }
    let alive = 0;
    const drag = Math.exp(-dt * 1.4);
    for (let i = 0; i < PARTICLES; i++) {
      if (life[i]! <= 0) continue;
      life[i] = life[i]! - dt;
      if (life[i]! <= 0) {
        p[i * 3] = p[i * 3 + 1] = p[i * 3 + 2] = 1e6;
        continue;
      }
      alive++;
      vel[i * 3] = vel[i * 3]! * drag; vel[i * 3 + 1] = vel[i * 3 + 1]! * drag - dt * 0.8; vel[i * 3 + 2] = vel[i * 3 + 2]! * drag;
      p[i * 3] = p[i * 3]! + vel[i * 3]! * dt; p[i * 3 + 1] = p[i * 3 + 1]! + vel[i * 3 + 1]! * dt; p[i * 3 + 2] = p[i * 3 + 2]! + vel[i * 3 + 2]! * dt;
      const fade = life[i]! / PARTICLE_LIFE;
      col[i * 3] = col[i * 3]! * (0.985 + 0.015 * fade); col[i * 3 + 1] = col[i * 3 + 1]! * (0.985 + 0.015 * fade); col[i * 3 + 2] = col[i * 3 + 2]! * (0.985 + 0.015 * fade);
    }
    this.stats.particles = alive;
    const g = this.points!.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  private bindReactors(world: THREE.Object3D): void {
    for (const def of this.def.react) {
      for (const node of findNodes(world, def.node)) {
        const materials: Reactor['materials'] = [];
        if (def.glow > 0) {
          node.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh || Array.isArray(mesh.material)) return;
            const own = (mesh.material as THREE.MeshStandardMaterial).clone();
            if (!own.emissive) return;
            mesh.material = own;
            materials.push({ m: own, base: own.emissiveIntensity });
          });
        }
        this.reactors.push({ def, node, base: node.scale.clone(), materials });
      }
    }
  }

  private react(r: Reactor, a: SpectrumAnalysis | null): void {
    const level = a ? a.level(r.def.band) : 0;
    if (r.def.scale) {
      const s = r.def.scale[0] + (r.def.scale[1] - r.def.scale[0]) * level;
      if (r.def.axis === 'all') r.node.scale.copy(r.base).multiplyScalar(s);
      else {
        r.node.scale.copy(r.base);
        r.node.scale[r.def.axis] *= s;
      }
    }
    for (const { m, base } of r.materials) m.emissiveIntensity = base + r.def.glow * level;
  }

  /** Deterministic burst directions. */
  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}

/** A soft round dot / falloff, generated here so there is no image file. */
function radialTexture(): THREE.DataTexture {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, 1 - r) ** 1.8 * 255;
      data.set([a, a, a, a], (y * size + x) * 4);
    }
  }
  const t = new THREE.DataTexture(data, size, size);
  t.needsUpdate = true;
  return t;
}
