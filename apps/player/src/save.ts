import { sanitizeOp, type EditOp } from './edit.js';
import { isJson, parseGameState, type GameState } from './interactions.js';

/**
 * Local saves: high scores, where the ball lies, and unsaved edits stay on the device, in
 * IndexedDB, keyed by world id + signing hash. They only go into a file when the person exports.
 * Private windows and browsers without IndexedDB fall back to memory, so the player keeps working
 * and simply forgets on reload.
 */
export interface SavedState {
  v: 1;
  worldId: string;
  signingHash: string;
  title: string;
  savedAt: string;
  state: GameState;
  /** Edits not exported yet, and the layers the world had when they were made. */
  draft?: Draft;
}

/**
 * A draft only re-applies to the exact world version it was made on. Opening the exported copy
 * of a layered world (same signing hash, one more layer) must not apply the same edits twice.
 */
export interface Draft {
  layers: string[];
  ops: EditOp[];
}

const MAX_DRAFT_OPS = 1000;

export function parseDraft(raw: unknown): Draft | undefined {
  if (!isJson(raw) || !Array.isArray(raw.layers) || !Array.isArray(raw.ops)) return undefined;
  const ops = raw.ops.slice(0, MAX_DRAFT_OPS).map(sanitizeOp).filter((op): op is EditOp => op !== null);
  return ops.length > 0 ? { layers: raw.layers.filter((l): l is string => typeof l === 'string'), ops } : undefined;
}

export const draftFits = (draft: Draft | undefined, layers: readonly string[]): draft is Draft =>
  !!draft && draft.layers.length === layers.length && draft.layers.every((l, i) => l === layers[i]);

export interface StateStore {
  readonly kind: 'indexeddb' | 'memory';
  get(key: string): Promise<SavedState | null>;
  put(key: string, value: SavedState): Promise<void>;
  delete(key: string): Promise<void>;
}

const DB_NAME = 'wgif-player';
const STORE = 'state';

/** Checks a record read back from storage. Anything unexpected is treated as "no save". */
export function parseSaved(raw: unknown): SavedState | null {
  if (!isJson(raw) || raw.v !== 1 || typeof raw.worldId !== 'string' || typeof raw.signingHash !== 'string' || !isJson(raw.state)) return null;
  return {
    v: 1,
    worldId: raw.worldId,
    signingHash: raw.signingHash,
    title: typeof raw.title === 'string' ? raw.title : '',
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
    state: parseGameState(raw.state),
    ...((draft) => (draft ? { draft } : {}))(parseDraft(raw.draft)),
  };
}

export function memoryStore(): StateStore {
  const map = new Map<string, string>();
  return {
    kind: 'memory',
    get: async (key) => {
      const raw = map.get(key);
      return raw === undefined ? null : parseSaved(JSON.parse(raw));
    },
    put: async (key, value) => void map.set(key, JSON.stringify(value)),
    delete: async (key) => void map.delete(key),
  };
}

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

export async function indexedDbStore(factory: IDBFactory): Promise<StateStore> {
  const db = await openDb(factory);
  const store = (mode: IDBTransactionMode): IDBObjectStore => db.transaction(STORE, mode).objectStore(STORE);
  return {
    kind: 'indexeddb',
    get: async (key) => parseSaved(await request(store('readonly').get(key))),
    put: async (key, value) => void (await request(store('readwrite').put(value, key))),
    delete: async (key) => void (await request(store('readwrite').delete(key))),
  };
}

/** IndexedDB when it works, memory when it does not. Never rejects. */
export async function openStateStore(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<StateStore> {
  if (!factory) return memoryStore();
  try {
    return await indexedDbStore(factory);
  } catch {
    return memoryStore();
  }
}

/**
 * Saves one world's state. Writes are coalesced: many changes in a burst become one write, and
 * `flush()` forces the pending one out (on export, when the page is hidden, before another world opens).
 */
export class WorldSaver {
  private pending: GameState | null = null;
  private draft: Draft | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly store: StateStore, private readonly key: string, private readonly meta: { worldId: string; signingHash: string; title: string }, private readonly delayMs = 400) {}

  async load(): Promise<SavedState | null> {
    const saved = await this.store.get(this.key).catch(() => null);
    this.draft = saved?.draft;
    return saved;
  }

  /** Saves the state soon. Bursts of changes become one write. */
  schedule(state: GameState): void {
    this.pending = state;
    if (this.timer === null) this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Keeps the unsaved edits (or forgets them, with an empty list) along with the state. */
  setDraft(state: GameState, layers: readonly string[], ops: EditOp[]): void {
    this.draft = ops.length > 0 ? { layers: [...layers], ops: [...ops] } : undefined;
    this.schedule(state);
  }

  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const state = this.pending;
    this.pending = null;
    if (state) {
      const record: SavedState = { v: 1, ...this.meta, savedAt: new Date().toISOString(), state, ...(this.draft ? { draft: this.draft } : {}) };
      this.chain = this.chain.then(() => this.store.put(this.key, record)).catch(() => undefined);
    }
    return this.chain;
  }

  /** Forgets this world's save (the "Reset progress" button). */
  async clear(): Promise<void> {
    this.pending = null;
    this.draft = undefined;
    await this.flush();
    await this.store.delete(this.key).catch(() => undefined);
  }
}
