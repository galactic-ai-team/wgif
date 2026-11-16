import { createRebounder, type RebounderAgent } from './ai.js';
import { Sfx } from './audio.js';
import { PlayerControls } from './controls.js';
import { EditSession, isLayerOp } from './edit.js';
import { exportWorld, type ExportResult } from './exporter.js';
import { Hud } from './hud.js';
import { mergeState, sanitizeRules, type GameState } from './interactions.js';
import { WorldSaver, draftFits, openStateStore } from './save.js';
import { BallReturnAgent } from './sim/agents.js';
import type { RuntimeEvent, WorldRuntime } from './sim/runtime.js';
import type { Vec3 } from './sim/vec.js';
import { WorldViewer, type ControlMode } from './viewer.js';
import { WorldOpenError, describeMode, describeTrust, formatBytes, loadDocument, openWorld, withEdits, type WorldDocument } from './world.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const li = (text: string, className = ''): HTMLLIElement => Object.assign(document.createElement('li'), { textContent: text, className });
const stage = $('stage');
const fileInput = $<HTMLInputElement>('file');
const modeBtn = $<HTMLButtonElement>('mode');
const playBtn = $<HTMLButtonElement>('play');
const editBtn = $<HTMLButtonElement>('edit');
const muteBtn = $<HTMLButtonElement>('mute');
const hint = $('hint');
const toast = $('toast');
const byInput = $<HTMLInputElement>('by');
const perfBox = new URLSearchParams(location.search).has('perf') ? $('perf') : null;

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
  if (mode === 'orbit') {
    viewer.runtime?.stopShootout();
    if (editing) setEditing(false);
  }
  viewer.setMode(mode);
  controls.setEnabled(mode === 'walk');
  setHint();
  syncButtons();
}

function syncButtons(): void {
  const rt = viewer?.runtime ?? null;
  const doc = session?.doc;
  modeBtn.disabled = !rt;
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
    // The built-in ball return stays on as a safety net for balls the NPC cannot get to.
    if (runtime.shootout) runtime.setAgent(new BallReturnAgent(7));
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
}

async function openBytes(bytes: Uint8Array, name: string): Promise<void> {
  try {
    const world = await openWorld(bytes);
    const doc = await loadDocument(world);
    await session?.saver.flush();
    const saver = new WorldSaver(await store, doc.saveKey, { worldId: world.manifest.id, signingHash: doc.signingHash, title: world.manifest.title });
    const saved = await saver.load();
    try {
      viewer ??= new WorldViewer(stage, controls);
    } catch {
      throw new WorldOpenError('This browser could not start WebGL, which the player needs to draw the world.');
    }
    viewer.hooks.onFrame = onFrame;
    if (editing) setEditing(false);
    hud.hideResult();
    session = { doc, saver, edits: new EditSession(), npc: await createRebounder(world), props: new Set(), warnings: [], lastExport: null };
    // Unsaved edits from last time come back, but only on the exact version they were made on.
    const draft = doc.policy.canEdit && draftFits(saved?.draft, layerIds(doc)) ? saved?.draft : undefined;
    if (draft) session.edits.restore(draft.ops);
    await mount(draft ? withEdits(doc, session.edits.ops) : doc, mergeState(doc.initialState, saved?.state));
    $('empty').hidden = true;
    $('refused').hidden = true;
    controls.setEnabled(viewer.mode === 'walk');
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
  if (!err.preview || viewer?.runtime) return;
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
      perfBox.textContent = `draw calls ${s.calls}\ntriangles ${s.triangles}\nframe p50 ${sorted[Math.floor(sorted.length * 0.5)]?.toFixed(1)} ms\nframe p95 ${sorted[Math.floor(sorted.length * 0.95)]?.toFixed(1)} ms\nquality ${s.level} · ${s.pixelRatio.toFixed(2)}x · shadows ${s.shadows ? 'on' : 'off'}`;
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
    const result = await exportWorld(session.doc, { ops, state, by });
    const url = URL.createObjectURL(new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: 'application/vnd.wgif+zip' }));
    Object.assign(document.createElement('a'), { href: url, download: result.fileName }).click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    session.lastExport = result;
    $<HTMLButtonElement>('reopen').hidden = false;
    notify(`Exported ${result.fileName} (${formatBytes(result.bytes.byteLength)}). ${result.kind === 'layer' ? 'Your changes are a new layer; the original world inside is untouched.' : 'It carries your changes and the history of this edit.'}`);
  } catch (e) {
    showError((e as Error).message);
  }
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

// Hooks for automated smoke tests.
Object.assign(window as unknown as Record<string, unknown>, {
  wgifOpenBytes: openBytes,
  wgifPlayer: {
    get viewer() { return viewer; },
    get runtime() { return viewer?.runtime ?? null; },
    get session() { return session; },
    setMode,
    setEditing,
    startShootout,
  },
});
