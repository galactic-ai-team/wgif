import type { WgifWorld } from '@wgif/format';
import { WorldViewer } from './viewer.js';
import { attachCourtAi, type CourtAi } from './ai.js';
import { WorldOpenError, cameraHints, formatBytes, openWorld } from './world.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const fileInput = $<HTMLInputElement>('file');
const modeBtn = $<HTMLButtonElement>('mode');
const hint = $('hint');
const toast = $('toast');

let viewer: WorldViewer | null = null;
let courtAi: CourtAi | null = null;
let previewUrl: string | null = null;

function showError(message: string, details: string[] = []): void {
  toast.textContent = [message, ...details.slice(0, 8)].join('\n');
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 9000);
}

function setHint(mode: 'orbit' | 'walk', locked: boolean): void {
  modeBtn.textContent = `Mode: ${mode === 'orbit' ? 'Orbit' : 'Walk'}`;
  hint.hidden = false;
  hint.textContent =
    mode === 'orbit'
      ? 'Orbit: drag to rotate · scroll/pinch to zoom · right-drag to pan'
      : locked
        ? 'Walk: WASD/arrows to move · mouse to look · Shift to run · Esc to release'
        : 'Walk: click the scene to look around (needs a mouse + keyboard for now)';
}

function renderInfo(world: WgifWorld): void {
  const m = world.manifest;
  $('info').hidden = false;
  $('title').textContent = m.title;
  $('creator').textContent = `by ${m.creator.name} · WGIF ${m.wgif}`;
  $('desc').textContent = m.description ?? '';
  const badge = $('badge');
  badge.textContent = m.mode;
  badge.className = `badge ${m.mode}`;
  const sig = $('sig');
  sig.textContent = world.report.signature === 'absent' ? 'unsigned' : `signature ${world.report.signature}`;
  sig.className = `badge ${world.report.signature}`;
  const issues = $('issues');
  issues.replaceChildren(
    ...world.report.warnings.map((w) => Object.assign(document.createElement('li'), { className: 'warning', textContent: w.message })),
  );
  $('files').replaceChildren(
    ...m.files.map((f) => Object.assign(document.createElement('li'), { textContent: `${f.path} — ${formatBytes(f.size)}` })),
  );
  const preview = world.files[m.entry.preview];
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = preview ? URL.createObjectURL(new Blob([preview as Uint8Array<ArrayBuffer>], { type: 'image/png' })) : null;
  const img = $<HTMLImageElement>('preview');
  img.hidden = !previewUrl;
  if (previewUrl) img.src = previewUrl;
}

async function openBytes(bytes: Uint8Array, name: string): Promise<void> {
  try {
    const world = await openWorld(bytes);
    viewer ??= new WorldViewer(stage);
    viewer.onModeChange = setHint;
    const scene = world.files[world.manifest.entry.scene];
    if (!scene) throw new WorldOpenError('Scene file missing');
    courtAi?.dispose();
    courtAi = null;
    await viewer.load(scene, cameraHints(world));
    $('empty').hidden = true;
    modeBtn.disabled = false;
    setHint(viewer.mode, false);
    renderInfo(world);
    document.title = `${world.manifest.title} — WGIF Player`;
    courtAi = await attachCourtAi(world, viewer, cameraHints(world));
    $('ai').textContent = courtAi
      ? `Rebounder NPC: ${courtAi.runtime} model${courtAi.usedFallback ? ' (rules fallback — ONNX could not run)' : ''} · watch the violet rebounder fetch the loose ball`
      : 'No rebounder NPC in this world.';
  } catch (e) {
    const err = e as WorldOpenError;
    showError(`${name}: ${err.message}`, err.details ?? []);
  }
}

async function openFile(file: File): Promise<void> {
  await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

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

modeBtn.addEventListener('click', () => viewer?.setMode(viewer.mode === 'orbit' ? 'walk' : 'orbit'));

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

// Expose a tiny hook for automated smoke tests.
(window as unknown as { wgifOpenBytes: typeof openBytes }).wgifOpenBytes = openBytes;
