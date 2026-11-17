import { createRebounder, reboundSpot, type RebounderAgent } from './ai.js';
import { Sfx } from './audio.js';
import { PlayerControls } from './controls.js';
import { DriveControls } from './driveControls.js';
import { EditSession, isLayerOp } from './edit.js';
import { exportWorld, slug, type ExportResult } from './exporter.js';
import { Hud } from './hud.js';
import { mergeState, sanitizeRules, type GameState } from './interactions.js';
import {
  MAX_REMOTE_BYTES, SHARE_CACHE, SHARE_KEY, WGIF_MEDIA_TYPE, imageNameFor, isAppleMobile, isAndroid, nameFromUrl, notAWorld, pickerAccept, previewFits, readSrcParam,
} from './opening.js';
import { WorldSaver, draftFits, openStateStore } from './save.js';
import { BallReturnAgent } from './sim/agents.js';
import type { RuntimeEvent, WorldRuntime } from './sim/runtime.js';
import type { Vec3 } from './sim/vec.js';
import type { WorldMusic } from './audio/music.js';
import { WorldViewer, type ControlMode } from './viewer.js';
import { WorldOpenError, describeMode, describeTrust, formatBytes, loadDocument, openWorld, withEdits, type WorldDocument } from './world.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const li = (text: string, className = ''): HTMLLIElement => Object.assign(document.createElement('li'), { textContent: text, className });
const stage = $('stage');
const fileInput = $<HTMLInputElement>('file');
const modeBtn = $<HTMLButtonElement>('mode');
const driveBtn = $<HTMLButtonElement>('drive');
const playBtn = $<HTMLButtonElement>('play');
const editBtn = $<HTMLButtonElement>('edit');
const muteBtn = $<HTMLButtonElement>('mute');
const hint = $('hint');
const toast = $('toast');
const byInput = $<HTMLInputElement>('by');
const perfBox = new URLSearchParams(location.search).has('perf') ? $('perf') : null;
/** `?npc=onnx` opts into the ONNX clone driving the rebounder (JS MLP, no WASM); the default is the rules model, and the rules twin stays the fallback on any load or evaluation failure. */
const npcOnnx = new URLSearchParams(location.search).get('npc') === 'onnx';
/** `?e2e` exposes the open world's runtime to the headless play test (e2e/shootout.e2e.mjs). Read-only use. */
if (new URLSearchParams(location.search).has('e2e')) Object.assign(window, { __wgif: { get rt() { return viewer?.runtime ?? null; } } });

/** Everything that belongs to the world that is open right now. */
interface Session {
  doc: WorldDocument;
  saver: WorldSaver;
  edits: EditSession;
  npc: RebounderAgent | null;
  /** Names of thin props (rims), for the sound of a bounce. */
  props: Set<string>;
  warnings: string[];
  lastExport: ExportResult | null;
}

// iOS greys out a .wgif in the Files picker whenever `accept` is set (it has no file type for it),
// so phones get an unfiltered picker and the player checks what was picked.
const accept = pickerAccept(navigator);
if (accept) fileInput.accept = accept;
else fileInput.removeAttribute('accept');
const appleMobile = isAppleMobile(navigator);

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
const store = openStateStore();
let viewer: WorldViewer | null = null;
let session: Session | null = null;
let editing = false;
let previewUrl: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** The open world's music track and visual, if it has one (loaded on demand). */
let music: WorldMusic | null = null;

const controls = new PlayerControls(stage, { stick: $('stick'), knob: $('knob'), action: $('action') }, {
  onPrimary: () => {
    sfx.unlock();
    const rt = viewer?.runtime;
    if (rt && !rt.held && !editing) rt.grab();
  },
  onUse: () => {
    const rt = viewer?.runtime;
    if (rt && !(rt.held ? rt.drop() : rt.grab())) notify('The ball is out of reach. Walk up to it, or press R to bring it back.');
  },
  onReset: () => resetBall(),
  onLockChange: () => setHint(),
});

const driveControls = new DriveControls($('drive-pad'), {
  onReset: () => viewer?.runtime?.driven?.reset(),
});

/** Turns on the input layer the current mode reads: walking or driving (orbit has its own). */
function applyControls(): void {
  controls.setEnabled(viewer?.mode === 'walk');
  driveControls.setEnabled(viewer?.mode === 'drive');
}

/** Gets into the world's vehicle, or back out to orbit around it. */
function toggleDrive(): void {
  if (!viewer?.canDrive) return;
  sfx.unlock();
  setMode(viewer.mode === 'drive' ? 'orbit' : 'drive');
}

function notify(message: string, kind: 'error' | 'ok' = 'ok', details: string[] = [], ms = 6000): void {
  toast.textContent = [message, ...details.slice(0, 8)].join('\n');
  toast.className = kind === 'ok' ? 'ok' : '';
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

const showError = (message: string, details: string[] = []): void => notify(message, 'error', details, 9000);

let hintTimer: ReturnType<typeof setTimeout> | null = null;

/** Body classes the phone layout keys on: `touch` once a finger is seen, `playing` while walking (not editing). */
function setLayout(): void {
  document.body.classList.toggle('touch', controls.touch);
  document.body.classList.toggle('playing', (viewer?.mode === 'walk' || viewer?.mode === 'drive') && !editing);
  document.body.classList.toggle('driving', viewer?.mode === 'drive');
}

function setHint(): void {
  const mode: ControlMode = viewer?.mode ?? 'orbit';
  setLayout();
  modeBtn.textContent = `Mode: ${mode === 'orbit' ? 'Orbit' : mode === 'walk' ? 'Walk' : 'Drive'}`;
  hint.hidden = !viewer?.runtime;
  hint.textContent =
    mode === 'orbit'
      ? `Orbit: drag to rotate · scroll/pinch to zoom · right-drag to pan${viewer?.canDrive ? (controls.touch ? ' · 🚗 Drive to take the wheel' : ' · F or Enter to drive') : ''}`
      : mode === 'drive'
        ? controls.touch
          ? 'Drive: ◀ ▶ steer · hold Gas · hold Brake to stop, then reverse · Exit car to orbit'
          : 'Drive: W/↑ gas · S/↓ brake, then reverse · A/D or ←/→ steer · Space brakes · R resets the car · F or Enter gets out'
        : controls.touch
        ? 'Walk: left thumb moves · drag anywhere else to look'
        : controls.locked
          ? 'WASD/arrows move · Shift runs · click or Space shoots · E picks up/drops · R resets the ball · Esc frees the mouse'
          : 'Walk: click the scene to look around · WASD/arrows to move';
  // On a phone the hint sits over the play area: show it for a moment, then get out of the way.
  if (hintTimer) clearTimeout(hintTimer);
  if (controls.touch && mode !== 'orbit') hintTimer = setTimeout(() => (hint.hidden = true), 5000);
}

function setMode(mode: ControlMode): void {
  if (!viewer) return;
  if (mode === 'orbit') {
    viewer.runtime?.stopShootout();
    if (editing) setEditing(false);
  }
  viewer.setMode(mode);
  applyControls();
  setHint();
  syncButtons();
}

function syncButtons(): void {
  const rt = viewer?.runtime ?? null;
  const doc = session?.doc;
  modeBtn.disabled = !rt;
  driveBtn.hidden = !viewer?.canDrive;
  driveBtn.textContent = viewer?.mode === 'drive' ? '■ Exit car' : '🚗 Drive';
  driveBtn.setAttribute('aria-pressed', String(viewer?.mode === 'drive'));
  playBtn.hidden = !rt?.shootout;
  playBtn.textContent = rt?.shootout?.running ? '■ Stop' : '▶ Shootout';
  editBtn.hidden = !doc?.policy.canEdit;
  editBtn.setAttribute('aria-pressed', String(editing));
  $('editor').hidden = !editing;
  if (!doc || !session) return;
  const base = doc.policy.via === 'base';
  $('ed-block').hidden = doc.policy.via !== 'layer';
  $('ed-spawn').hidden = !base;
  $('ed-rules').hidden = !base || !rt?.shootout;
  $('ed-ball').hidden = !rt || rt.objects.size === 0;
  const count = session.edits.ops.length;
  $('ed-count').textContent = count ? `${count} unsaved` : '';
  $<HTMLButtonElement>('ed-undo').disabled = !session.edits.canUndo;
  $<HTMLButtonElement>('ed-discard').disabled = !session.edits.dirty;
  $<HTMLButtonElement>('export').disabled = doc.policy.via === 'layer' && count === 0;
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
  const trust = describeTrust(doc.world);
  const sig = $('sig');
  sig.textContent = trust.label;
  sig.className = `badge ${trust.tone === 'absent' ? '' : trust.tone}`;
  $('trust').textContent = trust.detail;
  $('mode-note').textContent = describeMode(doc);

  $('export-box').hidden = !doc.policy.canEdit;
  $('save-note').textContent = !doc.policy.canEdit
    ? 'High scores and where the ball lies are saved on this device. A locked world cannot be exported.'
    : doc.policy.via === 'layer'
      ? 'Scores are saved on this device. Export adds your edits as a new layer; the original stays as it is.'
      : 'Scores and where the ball lies are saved on this device. Export writes them, and your edits, into a new file.';
  $<HTMLButtonElement>('reopen').hidden = !session.lastExport;
  $<HTMLButtonElement>('share-wgif').hidden = !session.lastExport || !canShareFile(exportFile(session.lastExport));
  const note = $('open-note');
  note.hidden = !appleMobile && !isAndroid(navigator);
  note.textContent = appleMobile
    ? 'On iPhone the export lands in Files › Downloads. To play it again, tap “Open .wgif” here and pick it. Tapping a .wgif in the Files app cannot start the player: iOS does not let a website open its own file types.'
    : 'To play an exported .wgif again, tap “Open .wgif” and pick it, or share it to the installed WGIF app.';

  $('layers-box').hidden = doc.layers.length === 0;
  $('layers').replaceChildren(
    ...doc.layers.map((l) => {
      const changes = l.file.add.length + l.file.move.length + l.file.remove.length;
      return li(`${l.id} by ${l.author}${l.created ? ` · ${l.created.slice(0, 10)}` : ''} · ${l.ok ? `${changes} change${changes === 1 ? '' : 's'}` : 'unreadable'}`);
    }),
  );
  // History and layer authors are what the file says about itself; no signature covers them (SPEC §8).
  const history = m.provenance?.history ?? [];
  const parent = m.provenance?.parent;
  $('history-box').hidden = history.length === 0 && !parent;
  $('history').replaceChildren(
    ...(parent ? [li(`Changed from ${parent.id} (signed version ${parent.signingHash.slice(0, 10)}…)`)] : []),
    ...history.map((h) => li(`${h.at.slice(0, 16).replace('T', ' ')} · ${h.action}${h.by ? ` by ${h.by}` : ''}${h.note ? `: ${h.note}` : ''}`)),
    li('As recorded in the file; not covered by a signature.', 'muted'),
  );
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

/** Loads a document into the viewer, attaches the NPC and (optionally) puts the player back where they stood. */
async function mount(view: WorldDocument, state: GameState, keepPose = false): Promise<void> {
  if (!viewer || !session) return;
  const old = viewer.runtime?.player;
  const pose = keepPose && old ? { feet: [...old.feet] as Vec3, yaw: old.yaw, pitch: old.pitch } : null;
  const { runtime, built } = await viewer.load(view, state);
  if (session.npc) {
    runtime.setAgent(session.npc);
    // The built-in ball return stays on as a safety net: a dead ball the NPC leaves alone comes back
    // after 2 s, and any ball is back in the shooter's hands at most 4 s after a shot (play test
    // 2026-11-16: returns took up to ~11 s, which ate the 60 s clock).
    if (runtime.shootout) runtime.setAgent(new BallReturnAgent(2, 4));
  }
  if (pose) {
    runtime.player.feet[0] = pose.feet[0]; runtime.player.feet[1] = pose.feet[1]; runtime.player.feet[2] = pose.feet[2];
    runtime.player.yaw = pose.yaw;
    runtime.player.pitch = pose.pitch;
  }
  runtime.agentsEnabled = !editing;
  session.props = new Set(built.props);
  session.warnings = [...view.warnings, ...built.warnings, ...(session.npc?.info.warnings ?? [])];
  const rules = runtime.shootout?.rules;
  if (rules) {
    $<HTMLInputElement>('ed-duration').value = String(rules.durationSec);
    $<HTMLInputElement>('ed-points').value = String(rules.pointsPerBasket);
  }
  await setupMusic(view);
}

/**
 * A world with a music track (interactions[] type "audio") gets its player, visual and controls.
 * The code for it is a separate chunk, loaded only for such worlds. Reloading the world (after an
 * edit) starts the track again from the play button.
 */
async function setupMusic(view: WorldDocument): Promise<void> {
  music = null; // the viewer disposed the previous one with its world
  const def = view.interactions.audio[0];
  if (!viewer || !session || !def) return;
  const bytes = view.world.files[def.file];
  if (!bytes) {
    session.warnings.push(`audio "${def.id}": ${def.file} is not in the world, so there is no music`);
    return;
  }
  if (view.interactions.audio.length > 1) session.warnings.push('audio: only the first track plays in this player');
  try {
    const { mountMusic } = await import('./audio/music.js');
    music = mountMusic(viewer, def, bytes, {
      tap: $<HTMLButtonElement>('music-tap'),
      bar: $('music-bar'),
      toggle: $<HTMLButtonElement>('music-toggle'),
      title: $('music-title'),
      volume: $<HTMLInputElement>('music-volume'),
    });
  } catch (e) {
    session.warnings.push(`audio: the music player could not load (${(e as Error).message ?? e})`);
  }
}

async function openBytes(bytes: Uint8Array, name: string): Promise<void> {
  const bad = notAWorld(bytes, name);
  if (bad) {
    showError(bad);
    return;
  }
  try {
    const world = await openWorld(bytes);
    const doc = await loadDocument(world);
    await session?.saver.flush();
    const saver = new WorldSaver(await store, doc.saveKey, { worldId: world.manifest.id, signingHash: doc.signingHash, title: world.manifest.title });
    const saved = await saver.load();
    try {
      viewer ??= new WorldViewer(stage, controls);
      viewer.driveSource = driveControls;
    } catch {
      throw new WorldOpenError('This browser could not start WebGL, which the player needs to draw the world.');
    }
    viewer.hooks.onFrame = onFrame;
    if (editing) setEditing(false);
    hud.hideResult();
    session = { doc, saver, edits: new EditSession(), npc: await createRebounder(world, { preferOnnx: npcOnnx }), props: new Set(), warnings: [], lastExport: null };
    // Unsaved edits from last time come back, but only on the exact version they were made on.
    const draft = doc.policy.canEdit && draftFits(saved?.draft, layerIds(doc)) ? saved?.draft : undefined;
    if (draft) session.edits.restore(draft.ops);
    await mount(draft ? withEdits(doc, session.edits.ops) : doc, mergeState(doc.initialState, saved?.state));
    $('empty').hidden = true;
    $('refused').hidden = true;
    applyControls();
    setHint();
    syncButtons();
    renderInfo();
    document.title = `${world.manifest.title} — WGIF Player`;
    if (session.edits.dirty) notify(`Your ${session.edits.ops.length} unsaved edit${session.edits.ops.length === 1 ? ' is' : 's are'} back. Export to keep them in a file.`);
  } catch (e) {
    const err = e as WorldOpenError;
    showError(`${name}: ${err.message}`, err.details ?? []);
    if (err.preview) showRefused(name, err);
  }
}

/** A world this player cannot run still shows its preview, and says what is missing. */
function showRefused(name: string, err: WorldOpenError): void {
  // Shown even when another world is already open: the refused world's own preview and what it
  // is missing are what the visitor asked to see. The open world stays loaded underneath.
  if (!err.preview) return;
  const underneath = !!viewer?.runtime;
  if (underneath) {
    if (document.pointerLockElement) document.exitPointerLock();
    controls.setEnabled(false);
    driveControls.setEnabled(false);
  }
  $('refused-back').hidden = !underneath;
  const img = $<HTMLImageElement>('refused-preview');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(new Blob([err.preview.bytes as Uint8Array<ArrayBuffer>], { type: err.preview.mediaType }));
  img.src = previewUrl;
  img.hidden = false;
  $('refused-title').textContent = `${name} needs a newer player`;
  $('refused-detail').textContent = `${err.message}: ${err.details.map((d) => d.replace(/^requires: /, '')).join(', ')}. This is its preview.`;
  $('empty').hidden = true;
  $('refused').hidden = false;
}

$('refused-back').addEventListener('click', () => {
  $('refused').hidden = true;
  if (viewer?.runtime) applyControls();
});

async function openFile(file: File): Promise<void> {
  await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

// ---- playing ----------------------------------------------------------------------------------

function startShootout(): void {
  const rt = viewer?.runtime;
  if (!rt?.shootout) return;
  sfx.unlock();
  hud.hideResult();
  if (editing) setEditing(false);
  setMode('walk');
  rt.startShootout();
  // The rebounder waits under the hoop the shooter now faces: in view, and close to the misses.
  if (rt.shootoutTarget && session?.npc) session.npc.standBy(reboundSpot(rt.shootoutTarget, rt.player.feet));
  // Space must reach the game, not re-press the focused ▶ Shootout / ■ Stop button.
  playBtn.blur();
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
  hud.frame(rt, viewer?.mode ?? 'orbit', { touch: controls.touch, editing });
  for (const e of events) onEvent(rt, e);
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
      perfBox.textContent = [
        `draw calls ${s.calls} · triangles ${s.triangles}`,
        `static meshes ${s.merged.before} → ${s.merged.after} (merged)`,
        `frame p50 ${sorted[Math.floor(sorted.length * 0.5)]?.toFixed(1)} ms · p95 ${sorted[Math.floor(sorted.length * 0.95)]?.toFixed(1)} ms`,
        `frames drawn ${s.frames} (none while nothing changes)`,
        `quality ${s.level} · ${s.pixelRatio.toFixed(2)}x · shadows ${s.shadows ? 'on' : 'off'}`,
      ].join('\n');
    }
  }
}

function onEvent(rt: WorldRuntime, e: RuntimeEvent): void {
  if (e.type === 'bounce') sfx.bounce(e.speed, session?.props.has(e.surface) ?? false);
  else if (e.type === 'grab') sfx.grab();
  else if (e.type === 'score') {
    const node = session?.doc.interactions.objects.find((o) => o.id === e.trigger)?.node;
    if (node) viewer?.flash(node);
    if (e.swish) sfx.swish();
    sfx.score();
    hud.banner(e.counted ? `+${e.points}${e.swish ? ' Swish!' : e.three ? ' From downtown!' : ''}` : e.swish ? 'Swish!' : 'Bucket!');
  } else if (e.type === 'state') {
    session?.saver.schedule(rt.snapshot());
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

// ---- editing and export -----------------------------------------------------------------------

const layerIds = (doc: WorldDocument): string[] => doc.layers.map((l) => l.id);
/** Edits are stored to the millimetre, so exported files stay readable. */
const mm = (v: Vec3): Vec3 => [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000];

/** Keeps the unsaved edits on the device, next to the high score, until they are exported. */
function saveDraft(): void {
  const rt = viewer?.runtime;
  if (session && rt) session.saver.setDraft(rt.snapshot(), layerIds(session.doc), session.edits.ops);
}

function setEditing(on: boolean): void {
  const rt = viewer?.runtime;
  if (!viewer || !rt || !session?.doc.policy.canEdit) return;
  editing = on;
  if (on) {
    rt.stopShootout();
    hud.hideResult();
    if (viewer.mode !== 'walk') setMode('walk');
    $('ed-note').textContent = session.doc.policy.via === 'layer' ? 'Look at a spot and choose. Your changes are saved as a layer; the original stays untouched.' : 'Look at a spot and choose. Your changes go into the copy you export.';
  }
  rt.agentsEnabled = !on;
  viewer.setMarkers(on);
  setLayout();
  syncButtons();
}

/** Where an edit lands: the surface the player is looking at, or just ahead of their feet. */
function editTarget(lift: number): Vec3 | null {
  const rt = viewer?.runtime;
  if (!viewer || !rt) return null;
  const hit = viewer.aimPoint();
  if (hit) return mm([hit.point[0] + hit.normal[0] * lift, hit.point[1] + hit.normal[1] * lift, hit.point[2] + hit.normal[2] * lift]);
  const f = rt.player.forward, feet = rt.player.feet;
  const flat = Math.hypot(f[0], f[2]) || 1;
  return mm([feet[0] + (f[0] / flat) * 1.5, feet[1] + lift, feet[2] + (f[2] / flat) * 1.5]);
}

/** Rebuilds the scene from the document plus the unsaved edits. Needed when things are added or taken away. */
async function rebuild(): Promise<void> {
  const rt = viewer?.runtime;
  if (!session || !rt) return;
  await mount(withEdits(session.doc, session.edits.ops), rt.snapshot(), true);
  viewer?.setMarkers(editing);
  syncButtons();
  renderGame();
}

$('ed-ball').addEventListener('click', () => {
  const rt = viewer?.runtime;
  const id = rt?.shootout?.def.ball ?? rt?.objects.keys().next().value;
  const ball = id ? rt?.objects.get(id) : undefined;
  const at = ball ? editTarget(ball.params.radius + 0.005) : null;
  if (!rt || !session || !id || !at) return;
  session.edits.push({ op: 'move', id, position: at });
  rt.setObjectSpawn(id, at);
  saveDraft();
  syncButtons();
});

$('ed-block').addEventListener('click', () => {
  const at = editTarget(0.3);
  if (!session || !at) return;
  session.edits.push({ op: 'add', id: session.edits.nextId(session.doc.ids), primitive: 'box', position: at, size: [0.6, 0.6, 0.6], color: '#8b5cf6' });
  void rebuild().then(saveDraft);
});

$('ed-spawn').addEventListener('click', () => {
  const rt = viewer?.runtime;
  if (!rt || !session) return;
  const e = rt.player.eye, f = rt.player.forward;
  const eye = mm(e), lookAt = mm([e[0] + f[0] * 5, e[1] + f[1] * 5, e[2] + f[2] * 5]);
  session.edits.push({ op: 'spawn', position: eye, lookAt });
  rt.setPlayerSpawn(eye, lookAt);
  saveDraft();
  syncButtons();
  notify('Visitors will start here, looking this way.');
});

for (const id of ['ed-duration', 'ed-points']) {
  $(id).addEventListener('change', () => {
    const rt = viewer?.runtime;
    const game = rt?.shootout;
    if (!rt || !game || !session) return;
    const rules = sanitizeRules({ durationSec: Number($<HTMLInputElement>('ed-duration').value), pointsPerBasket: Number($<HTMLInputElement>('ed-points').value) }, game.rules);
    // Only what actually changed, so the history note says what was edited.
    const changed: Partial<typeof rules> = {};
    if (rules.durationSec !== game.rules.durationSec) changed.durationSec = rules.durationSec;
    if (rules.pointsPerBasket !== game.rules.pointsPerBasket) changed.pointsPerBasket = rules.pointsPerBasket;
    if (Object.keys(changed).length === 0) return;
    session.edits.push({ op: 'rules', minigame: game.id, rules: changed });
    rt.setRules(rules);
    saveDraft();
    $<HTMLInputElement>('ed-duration').value = String(rules.durationSec);
    $<HTMLInputElement>('ed-points').value = String(rules.pointsPerBasket);
    syncButtons();
    renderGame();
  });
}

$('ed-undo').addEventListener('click', () => {
  if (!session?.edits.canUndo) return;
  session.edits.undo();
  void rebuild().then(saveDraft);
});

$('ed-discard').addEventListener('click', () => {
  if (!session?.edits.dirty || !confirm('Throw away all edits that have not been exported?')) return;
  session.edits.clear();
  void rebuild().then(saveDraft);
});

$('export').addEventListener('click', async () => {
  const rt = viewer?.runtime;
  if (!session || !rt) return;
  try {
    const by = byInput.value.trim();
    try {
      localStorage.setItem('wgif.author', by);
    } catch {
      // private mode
    }
    const state = session.doc.policy.via === 'base' ? rt.snapshot() : null;
    const ops = session.doc.policy.via === 'layer' ? session.edits.ops.filter(isLayerOp) : session.edits.ops;
    const result = await exportWorld(session.doc, { ops, state, by, preview: session.doc.policy.via === 'base' ? renderPreview() : null });
    download(result.bytes, result.fileName, WGIF_MEDIA_TYPE);
    session.lastExport = result;
    renderInfo();
    const shown = result.preview === 'refreshed' ? ' Its preview image shows your edit.' : '';
    notify(`Exported ${result.fileName} (${formatBytes(result.bytes.byteLength)}). ${result.kind === 'layer' ? 'Your changes are a new layer; the original world inside is untouched.' : 'It carries your changes and the history of this edit.'}${shown}`);
  } catch (e) {
    showError((e as Error).message);
  }
});

$('share-wgif').addEventListener('click', () => {
  const last = session?.lastExport;
  if (last) void shareOrDownload(exportFile(last), last.bytes, WGIF_MEDIA_TYPE);
});

$('save-image').addEventListener('click', () => {
  if (!session) return;
  const png = snapshotPng(1024, 614);
  if (!png) {
    showError('Could not draw a picture of this world.');
    return;
  }
  const name = imageNameFor(session.lastExport?.fileName ?? `${slug(session.doc.world.manifest.title)}.wgif`);
  void shareOrDownload(new File([png as Uint8Array<ArrayBuffer>], name, { type: 'image/png' }), png, 'image/png');
});

$('reopen').addEventListener('click', () => {
  const last = session?.lastExport;
  if (last) void openBytes(last.bytes, last.fileName);
});

$('forget').addEventListener('click', async () => {
  if (!session || !confirm('Erase the high score and saved ball position for this world on this device?')) return;
  await session.saver.clear();
  session.edits.clear();
  viewer?.runtime?.stopShootout();
  await mount(session.doc, session.doc.initialState);
  syncButtons();
  renderGame();
  notify('Progress for this world was reset.');
});

// ---- files in and out ----------------------------------------------------------------------------

function download(bytes: Uint8Array, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  Object.assign(document.createElement('a'), { href: url, download: fileName }).click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const exportFile = (r: ExportResult): File => new File([r.bytes as Uint8Array<ArrayBuffer>], r.fileName, { type: WGIF_MEDIA_TYPE });

function canShareFile(file: File): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** The share sheet (iPhone: Save to Files / Save Image / AirDrop) when the browser has one for this file; otherwise a download. */
async function shareOrDownload(file: File, bytes: Uint8Array, type: string): Promise<void> {
  if (canShareFile(file)) {
    try {
      // Called straight from the click (no await before it), so the browser still sees the tap.
      await navigator.share({ files: [file], title: file.name });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  download(bytes, file.name, type);
}

/** The open world drawn from its overview, as PNG bytes. Synchronous, so a share can follow inside the tap. */
function snapshotPng(width: number, height: number): Uint8Array | null {
  const canvas = viewer?.snapshot(width, height);
  if (!canvas) return null;
  const url = canvas.toDataURL('image/png');
  const comma = url.indexOf(',');
  if (!url.startsWith('data:image/png') || comma < 0) return null;
  const bin = atob(url.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A preview for an export: the biggest of a few sizes that keeps the SPEC §4 limits (≤ 512 px, ≤ 256 KiB). */
function renderPreview(): Uint8Array | null {
  for (const [w, h] of [[480, 288], [400, 240], [320, 192]] as const) {
    const png = snapshotPng(w, h);
    if (!png) return null;
    if (previewFits(png)) return png;
  }
  return null;
}

/** `?src=<https url>`: open a hosted .wgif, so a plain link can open a world in the player. */
async function openRemote(url: URL): Promise<void> {
  const name = nameFromUrl(url);
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_REMOTE_BYTES) throw new Error(`it is ${formatBytes(length)}, more than the ${formatBytes(MAX_REMOTE_BYTES)} this player fetches`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_BYTES) throw new Error(`it is more than the ${formatBytes(MAX_REMOTE_BYTES)} this player fetches`);
    await openBytes(bytes, name);
  } catch (e) {
    showError(`Could not fetch ${name}: ${(e as Error).message}. The host must allow downloads from other sites (CORS).`);
  }
}

/** A .wgif shared to the installed app (Android share sheet) was parked by the service worker. */
async function openShared(): Promise<void> {
  try {
    const cache = await caches.open(SHARE_CACHE);
    const key = new URL(SHARE_KEY, document.baseURI).href;
    const hit = await cache.match(key);
    if (!hit) {
      showError('The shared file did not arrive. Try “Open .wgif” instead.');
      return;
    }
    const name = decodeURIComponent(hit.headers.get('X-WGIF-Name') ?? 'shared.wgif');
    const bytes = new Uint8Array(await hit.arrayBuffer());
    await cache.delete(key); // the player's own hand-off copy, not the person's file
    await openBytes(bytes, name);
  } catch (e) {
    showError(`Could not open the shared file: ${(e as Error).message}`);
  }
}

// ---- wiring -----------------------------------------------------------------------------------

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void openFile(f);
  fileInput.value = '';
});

modeBtn.addEventListener('click', () => setMode(viewer?.mode === 'orbit' ? 'walk' : 'orbit'));
driveBtn.addEventListener('click', () => {
  toggleDrive();
  // Keys drive the car, not the button: Space or Enter on a focused button would click it again.
  driveBtn.blur();
});
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
editBtn.addEventListener('click', () => setEditing(!editing));
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
  const typingInto = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || !!el?.isContentEditable;
  if (e.repeat || typingInto || e.ctrlKey || e.metaKey || e.altKey) return;
  // F (or Enter, in a world with no Shootout) gets into the car and back out.
  if (viewer?.canDrive && !editing && (e.code === 'KeyF' || (e.code === 'Enter' && el?.tagName !== 'BUTTON' && !viewer.runtime?.shootout))) {
    e.preventDefault();
    toggleDrive();
    return;
  }
  if (e.code === 'Enter' && el?.tagName !== 'BUTTON' && viewer?.runtime?.shootout && !viewer.runtime.shootout.running) startShootout();
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

// Saves are written a moment after a change; make sure the last one lands before the page goes away.
const flush = (): void => void session?.saver.flush();
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

try {
  byInput.value = localStorage.getItem('wgif.author') ?? '';
} catch {
  // private mode
}

// A .wgif opened with the installed app (desktop Chrome/Edge "Open with", via manifest file_handlers).
interface LaunchParams { files?: { getFile(): Promise<File> }[] }
const launchQueue = (window as unknown as { launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void } }).launchQueue;
launchQueue?.setConsumer((params) => {
  const handle = params.files?.[0];
  if (handle) void handle.getFile().then(openFile, (e: unknown) => showError(`Could not read the file: ${(e as Error).message}`));
});

{
  const params = new URLSearchParams(location.search);
  const src = readSrcParam(location.search, location.href);
  if (src && 'error' in src) showError(src.error);
  else if (src) void openRemote(src.url);
  else if (params.get('shared') === '1' && 'caches' in window) void openShared();
  else if (params.get('shared') === 'none') showError('Nothing that looks like a .wgif was shared. Try “Open .wgif” instead.');
}

// Hooks for automated smoke tests.
Object.assign(window as unknown as Record<string, unknown>, {
  wgifOpenBytes: openBytes,
  wgifPlayer: {
    get viewer() { return viewer; },
    get runtime() { return viewer?.runtime ?? null; },
    get session() { return session; },
    get music() { return music; },
    setMode,
    setEditing,
    toggleDrive,
    startShootout,
  },
});
