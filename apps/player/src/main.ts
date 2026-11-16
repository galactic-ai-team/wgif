import { createRebounder, type RebounderAgent } from './ai.js';
import { Sfx } from './audio.js';
import { PlayerControls } from './controls.js';
import { Hud } from './hud.js';
import { BallReturnAgent } from './sim/agents.js';
import type { RuntimeEvent, WorldRuntime } from './sim/runtime.js';
import { WorldViewer, type ControlMode } from './viewer.js';
import { WorldOpenError, formatBytes, loadDocument, openWorld, type WorldDocument } from './world.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const li = (text: string, className = ''): HTMLLIElement => Object.assign(document.createElement('li'), { textContent: text, className });
const stage = $('stage');
const fileInput = $<HTMLInputElement>('file');
const modeBtn = $<HTMLButtonElement>('mode');
const playBtn = $<HTMLButtonElement>('play');
const muteBtn = $<HTMLButtonElement>('mute');
const hint = $('hint');
const toast = $('toast');
const perfBox = new URLSearchParams(location.search).has('perf') ? $('perf') : null;

/** Everything that belongs to the world that is open right now. */
interface Session {
  doc: WorldDocument;
  npc: RebounderAgent | null;
  /** Names of thin props (rims), for the sound of a bounce. */
  props: Set<string>;
  warnings: string[];
}

// Offline PWA (Phase One item 6): register the hand-written service worker
// in production builds only, so `vite dev` never caches dev assets. The
// worker precaches the app shell + the sample court, cache-first, under a
// versioned cache name; a failed registration never breaks the player.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((error: unknown) => {
    console.warn('WGIF Player: service worker registration failed, continuing online-only', error);
  });
}

const hud = new Hud();
const sfx = new Sfx();
let viewer: WorldViewer | null = null;
let session: Session | null = null;
let previewUrl: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

const controls = new PlayerControls(stage, { stick: $('stick'), knob: $('knob'), action: $('action') }, {
  onPrimary: () => {
    sfx.unlock();
    const rt = viewer?.runtime;
    if (rt && !rt.held) rt.grab();
  },
  onUse: () => {
    const rt = viewer?.runtime;
    if (rt && !(rt.held ? rt.drop() : rt.grab())) notify('The ball is out of reach. Walk up to it, or press R to bring it back.');
  },
  onReset: () => resetBall(),
  onLockChange: () => setHint(),
});

function notify(message: string, kind: 'error' | 'ok' = 'ok', details: string[] = [], ms = 6000): void {
  toast.textContent = [message, ...details.slice(0, 8)].join('\n');
  toast.className = kind === 'ok' ? 'ok' : '';
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

const showError = (message: string, details: string[] = []): void => notify(message, 'error', details, 9000);

function setHint(): void {
  const mode: ControlMode = viewer?.mode ?? 'orbit';
  modeBtn.textContent = `Mode: ${mode === 'orbit' ? 'Orbit' : 'Walk'}`;
  hint.hidden = !viewer?.runtime;
  hint.textContent =
    mode === 'orbit'
      ? 'Orbit: drag to rotate · scroll/pinch to zoom · right-drag to pan'
      : controls.touch
        ? 'Walk: left thumb moves · drag anywhere else to look'
        : controls.locked
          ? 'WASD/arrows move · Shift runs · click or Space shoots · E picks up/drops · R resets the ball · Esc frees the mouse'
          : 'Walk: click the scene to look around · WASD/arrows to move';
}

function setMode(mode: ControlMode): void {
  if (!viewer) return;
  if (mode === 'orbit') viewer.runtime?.stopShootout();
  viewer.setMode(mode);
  controls.setEnabled(mode === 'walk');
  setHint();
  syncButtons();
}

function syncButtons(): void {
  const rt = viewer?.runtime ?? null;
  modeBtn.disabled = !rt;
  playBtn.hidden = !rt?.shootout;
  playBtn.textContent = rt?.shootout?.running ? '■ Stop' : '▶ Shootout';
}

function renderInfo(): void {
  if (!session) return;
  const { doc } = session;
  const { manifest: m, report } = doc.world;
  $('info').hidden = false;
  $('title').textContent = m.title;
  $('creator').textContent = `by ${m.creator.name} · WGIF ${m.wgif}`;
  $('desc').textContent = m.description ?? '';
  const badge = $('badge');
  badge.textContent = m.mode;
  badge.className = `badge ${m.mode}`;
  const sig = $('sig');
  sig.textContent = report.signature === 'absent' ? 'unsigned' : `signature ${report.signature}`;
  sig.className = `badge ${report.signature}`;
  $('issues').replaceChildren(...report.warnings.map((w) => li(w.message, 'warning')), ...session.warnings.map((w) => li(w, 'warning')));
  $('files').replaceChildren(...m.files.map((f) => li(`${f.path} — ${formatBytes(f.size)}`)));

  const preview = doc.world.files[m.entry.preview];
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = preview ? URL.createObjectURL(new Blob([preview as Uint8Array<ArrayBuffer>], { type: 'image/png' })) : null;
  const img = $<HTMLImageElement>('preview');
  img.hidden = !previewUrl;
  if (previewUrl) img.src = previewUrl;
  renderGame();
}

function renderGame(): void {
  const game = viewer?.runtime?.shootout;
  $('game').hidden = !game;
  if (game) $('game-stats').textContent = `High score ${game.highScore} · played ${game.plays} time${game.plays === 1 ? '' : 's'} · ${game.rules.durationSec} s, ${game.rules.pointsPerBasket} points a basket`;
  const npc = session?.npc;
  $('ai').textContent = npc
    ? `Rebounder NPC: ${npc.info.runtime} model at ${npc.info.tickHz} Hz${npc.info.usedFallback ? ' (rules fallback: the ONNX model could not run)' : ''}. It fetches the loose ball and passes it back.`
    : '';
}

/** Loads a document into the viewer and attaches the NPC. */
async function mount(view: WorldDocument): Promise<void> {
  if (!viewer || !session) return;
  const { runtime, built } = await viewer.load(view, view.initialState);
  if (session.npc) {
    runtime.setAgent(session.npc);
    // The built-in ball return stays on as a safety net for balls the NPC cannot get to.
    if (runtime.shootout) runtime.setAgent(new BallReturnAgent(7));
  }
  session.props = new Set(built.props);
  session.warnings = [...view.warnings, ...built.warnings, ...(session.npc?.info.warnings ?? [])];
}

async function openBytes(bytes: Uint8Array, name: string): Promise<void> {
  try {
    const world = await openWorld(bytes);
    const doc = await loadDocument(world);
    try {
      viewer ??= new WorldViewer(stage, controls);
    } catch {
      throw new WorldOpenError('This browser could not start WebGL, which the player needs to draw the world.');
    }
    viewer.hooks.onFrame = onFrame;
    hud.hideResult();
    session = { doc, npc: await createRebounder(world), props: new Set(), warnings: [] };
    await mount(doc);
    $('empty').hidden = true;
    controls.setEnabled(viewer.mode === 'walk');
    setHint();
    syncButtons();
    renderInfo();
    document.title = `${world.manifest.title} — WGIF Player`;
  } catch (e) {
    const err = e as WorldOpenError;
    showError(`${name}: ${err.message}`, err.details ?? []);
  }
}

async function openFile(file: File): Promise<void> {
  await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

// ---- playing ----------------------------------------------------------------------------------

function startShootout(): void {
  const rt = viewer?.runtime;
  if (!rt?.shootout) return;
  sfx.unlock();
  hud.hideResult();
  setMode('walk');
  rt.startShootout();
  syncButtons();
}

function resetBall(): void {
  const rt = viewer?.runtime;
  const ball = rt?.shootout?.def.ball ?? rt?.objects.keys().next().value;
  if (rt && ball && !rt.shootout?.running) rt.resetObject(ball);
}

const frameTimes: number[] = [];
let frames = 0;
let lastPhase = '';

function onFrame(rt: WorldRuntime, events: RuntimeEvent[], dt: number): void {
  hud.frame(rt, viewer?.mode ?? 'orbit', { touch: controls.touch, editing: false });
  for (const e of events) onEvent(e);
  const phase = rt.shootout?.phase ?? '';
  if (phase !== lastPhase) {
    lastPhase = phase;
    syncButtons();
  }
  if (perfBox && viewer) {
    frameTimes.push(dt * 1000);
    if (frameTimes.length > 120) frameTimes.shift();
    if (++frames % 30 === 0) {
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const s = viewer.stats();
      perfBox.hidden = false;
      perfBox.textContent = `draw calls ${s.calls}\ntriangles ${s.triangles}\nframe p50 ${sorted[Math.floor(sorted.length * 0.5)]?.toFixed(1)} ms\nframe p95 ${sorted[Math.floor(sorted.length * 0.95)]?.toFixed(1)} ms\nquality ${s.level} · ${s.pixelRatio.toFixed(2)}x · shadows ${s.shadows ? 'on' : 'off'}`;
    }
  }
}

function onEvent(e: RuntimeEvent): void {
  if (e.type === 'bounce') sfx.bounce(e.speed, session?.props.has(e.surface) ?? false);
  else if (e.type === 'grab') sfx.grab();
  else if (e.type === 'score') {
    const node = session?.doc.interactions.objects.find((o) => o.id === e.trigger)?.node;
    if (node) viewer?.flash(node);
    if (e.swish) sfx.swish();
    sfx.score();
    hud.banner(e.counted ? `+${e.points}${e.swish ? ' Swish!' : e.three ? ' From downtown!' : ''}` : e.swish ? 'Swish!' : 'Bucket!');
  } else if (e.type === 'state') {
    renderGame();
  } else if (e.type === 'shootout') {
    const s = e.signal;
    if (s.kind === 'countdown') {
      hud.banner(String(s.seconds), 800);
      sfx.beep();
    } else if (s.kind === 'go') {
      hud.banner('GO!', 700);
      sfx.beep(true);
    } else if (s.kind === 'second' && s.timeLeft <= 5) {
      sfx.beep();
    } else if (s.kind === 'buzzer') {
      hud.banner('TIME!', 1200);
      sfx.buzzer();
    } else if (s.kind === 'over') {
      hud.showResult(s.result);
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }
}

// ---- wiring -----------------------------------------------------------------------------------

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void openFile(f);
  fileInput.value = '';
});

$('sample').addEventListener('click', async () => {
  try {
    const res = await fetch(new URL('samples/court.wgif', document.baseURI));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await openBytes(new Uint8Array(await res.arrayBuffer()), 'court.wgif');
  } catch (e) {
    showError(`Sample not available: ${(e as Error).message}. Run "npm run pack:court" first.`);
  }
});

modeBtn.addEventListener('click', () => setMode(viewer?.mode === 'orbit' ? 'walk' : 'orbit'));
playBtn.addEventListener('click', () => {
  const rt = viewer?.runtime;
  if (rt?.shootout?.running) {
    rt.stopShootout();
    syncButtons();
  } else {
    startShootout();
  }
});
$('again').addEventListener('click', startShootout);
$('result-close').addEventListener('click', () => hud.hideResult());
$('ballreset').addEventListener('click', resetBall);

const paintMute = (): void => {
  muteBtn.textContent = sfx.muted ? '🔇' : '🔊';
  muteBtn.setAttribute('aria-pressed', String(sfx.muted));
};
muteBtn.addEventListener('click', () => {
  sfx.setMuted(!sfx.muted);
  paintMute();
});
paintMute();

window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement | null;
  if (e.code === 'Enter' && !e.repeat && el?.tagName !== 'INPUT' && el?.tagName !== 'BUTTON' && viewer?.runtime?.shootout && !viewer.runtime.shootout.running) startShootout();
});

let dragDepth = 0;
const drop = $('drop');
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  drop.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) drop.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) void openFile(f);
});

// Hooks for automated smoke tests.
Object.assign(window as unknown as Record<string, unknown>, {
  wgifOpenBytes: openBytes,
  wgifPlayer: {
    get viewer() { return viewer; },
    get runtime() { return viewer?.runtime ?? null; },
    get session() { return session; },
    setMode,
    startShootout,
  },
});
