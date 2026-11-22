/**
 * "Create from image": a picture or GIF in, a .wgif out. A separate chunk, loaded when the creator
 * is first opened; the depth model behind it is fetched only when a 3D scene is first made.
 */
import { decodeGif, isGif } from './gif.js';
import { estimateDepth, type Backend, type DepthResult } from './depth.js';
import { buildPhotoWorld, fit, medianFrame, withPreview, MAX_FRAMES, type Encoded, type ImageCodec, type Picture, type PhotoMode, type PhotoWorld } from './world.js';

export interface CreatorDeps {
  /** Opens built .wgif bytes in the player. */
  open(bytes: Uint8Array, name: string): Promise<void>;
  /** The open world's preview render (PNG), or null. */
  preview(): Uint8Array | null;
  save(bytes: Uint8Array, fileName: string): void;
  notify(message: string, kind?: 'error' | 'ok'): void;
}

interface Source {
  name: string;
  frames: Picture[];
  delaysMs: number[];
  sourceFrames: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Canvas JPEG/PNG. */
const canvasCodec: ImageCodec = {
  async encode(p, type, quality): Promise<Encoded> {
    const c = document.createElement('canvas');
    c.width = p.width;
    c.height = p.height;
    c.getContext('2d')!.putImageData(new ImageData(p.rgba as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality));
    if (!blob) throw new Error('this browser could not encode an image');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type === 'image/png' ? 'image/png' : 'image/jpeg' };
  },
};

/** Longest side kept from the source (more would not survive the size budget anyway). */
const MAX_SOURCE = 2048;
const MAX_GIF_SIDE = 768;

async function readPicture(file: Blob): Promise<Picture> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('this browser cannot read that picture (try PNG, JPEG, WebP or GIF)');
  }
  const s = Math.min(1, MAX_SOURCE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { width: w, height: h, rgba: ctx.getImageData(0, 0, w, h).data };
}

export async function readSource(file: File): Promise<Source> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isGif(bytes)) {
    const gif = decodeGif(bytes, { maxFrames: MAX_FRAMES });
    const frames = gif.frames.map((f) => fit({ width: gif.width, height: gif.height, rgba: f.rgba }, MAX_GIF_SIDE));
    return { name: file.name, frames: frames.length > 1 ? frames : [frames[0]!], delaysMs: gif.frames.map((f) => f.delayMs), sourceFrames: gif.sourceFrames };
  }
  return { name: file.name, frames: [await readPicture(file)], delaysMs: [], sourceFrames: 1 };
}

const backendParam = (): Backend | 'auto' => {
  const v = new URLSearchParams(location.search).get('depth');
  return v === 'mock' || v === 'wasm' || v === 'webgpu' ? v : 'auto';
};

export interface Creator {
  show(file?: File): void;
  hide(): void;
  /** The last world made (tests read it). */
  readonly world: PhotoWorld | null;
  readonly depth: DepthResult | null;
}

export function createCreator(deps: CreatorDeps): Creator {
  const panel = $('img-creator');
  const fileInput = $<HTMLInputElement>('cr-file');
  const nameEl = $('cr-name');
  const make = $<HTMLButtonElement>('cr-make');
  const save = $<HTMLButtonElement>('cr-save');
  const status = $('cr-status');
  const bar = $('cr-progress');
  const fill = bar.firstElementChild as HTMLElement;
  const strength = $<HTMLInputElement>('cr-strength');
  const cut = $<HTMLInputElement>('cr-cut');
  const note = $('cr-note');
  let source: Source | null = null;
  let depth: DepthResult | null = null;
  let world: PhotoWorld | null = null;
  let busy = false;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  const mode = (): PhotoMode => ((document.querySelector('input[name="cr-mode"]:checked') as HTMLInputElement | null)?.value === 'flat' ? 'flat' : '3d');
  const setStatus = (text: string, fraction: number | null = null): void => {
    status.textContent = text;
    bar.hidden = fraction === null;
    if (fraction !== null) fill.style.width = `${Math.round(fraction * 100)}%`;
  };
  const sync = (): void => {
    make.disabled = busy || !source;
    make.textContent = world ? 'Rebuild' : mode() === '3d' ? 'Make 3D' : 'Make scene';
    save.hidden = !world;
    save.disabled = busy;
    panel.classList.toggle('made', !!world);
    const is3d = mode() === '3d';
    strength.disabled = cut.disabled = !is3d;
    note.textContent = is3d
      ? 'AI depth runs on this device. The model (Depth Anything V2 Small, ~27 MB) downloads once, then works offline.'
      : 'The picture hangs as a screen in a small room. No download.';
  };

  async function build(): Promise<void> {
    if (!source || busy) return;
    busy = true;
    sync();
    try {
      let m = mode();
      if (m === '3d' && !depth) {
        try {
          depth = await estimateDepth(medianFrame(source.frames), backendParam(), (p) => setStatus(p.stage, p.fraction));
        } catch (e) {
          deps.notify(`3D needs the depth model, which could not run here (${(e as Error).message}). Made a flat screen instead.`, 'error');
          m = 'flat';
          (document.querySelector('input[name="cr-mode"][value="flat"]') as HTMLInputElement).checked = true;
        }
      }
      setStatus('Building the scene…');
      const base = source.name.replace(/\.[a-z0-9]+$/i, '') || 'picture';
      const made = await buildPhotoWorld({
        frames: source.frames,
        delaysMs: source.delaysMs,
        depth: m === '3d' ? depth?.depth ?? null : null,
        depthInfo: depth?.info ?? null,
        mode: m,
        strength: Number(strength.value) / 100,
        edge: cut.checked ? 'cut' : 'smooth',
        sourceName: source.name,
        title: base,
      }, canvasCodec);
      const fileName = `${base.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'picture'}.wgif`;
      await deps.open(made.bytes, fileName);
      // A real render as its preview, now that the player has drawn it.
      const png = deps.preview();
      world = png ? await withPreview(made, png) : made;
      Object.assign(world, { fileName });
      const frames = source.frames.length > 1 ? ` · ${source.frames.length} frames${source.sourceFrames > source.frames.length ? ` (of ${source.sourceFrames})` : ''}` : '';
      const how = m === '3d' && depth ? (depth.info.backend === 'mock' ? 'test depth' : `depth in ${(depth.info.ms / 1000).toFixed(1)} s on ${depth.info.backend === 'webgpu' ? 'the GPU' : 'the CPU'}`) : 'flat';
      setStatus(`Ready: ${(world.bytes.length / 1024).toFixed(0)} KB${frames} · ${how}. Drag to orbit.`);
    } catch (e) {
      setStatus('');
      deps.notify(`Could not make a scene: ${(e as Error).message}`, 'error');
    } finally {
      busy = false;
      sync();
    }
  }

  async function take(file: File): Promise<void> {
    if (busy) return;
    setStatus('Reading the picture…');
    try {
      source = await readSource(file);
      depth = null;
      world = null;
      const f = source.frames[0]!;
      nameEl.textContent = `${file.name} · ${f.width}×${f.height}${source.frames.length > 1 ? ` · ${source.frames.length} frames` : ''}`;
      setStatus('');
      sync();
      await build();
    } catch (e) {
      source = null;
      setStatus('');
      deps.notify(`${file.name}: ${(e as Error).message}`, 'error');
      sync();
    }
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void take(f);
  });
  make.addEventListener('click', () => void build());
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="cr-mode"]')) r.addEventListener('change', () => { sync(); if (world) void build(); });
  const later = (): void => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { if (world && mode() === '3d') void build(); }, 300);
  };
  strength.addEventListener('change', later);
  cut.addEventListener('change', later);
  save.addEventListener('click', () => {
    if (world) deps.save(world.bytes, (world as PhotoWorld & { fileName?: string }).fileName ?? 'picture.wgif');
  });
  $('cr-close').addEventListener('click', () => (panel.hidden = true));
  sync();

  return {
    show(file) {
      panel.hidden = false;
      if (file) void take(file);
    },
    hide() {
      panel.hidden = true;
    },
    get world() {
      return world;
    },
    get depth() {
      return depth;
    },
  };
}
