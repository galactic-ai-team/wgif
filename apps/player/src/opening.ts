/**
 * Getting a .wgif into the player from wherever it lives: the file picker (including the iOS Files
 * app), drag and drop, an installed-PWA file launch (`launchQueue`), an Android share (Web Share
 * Target, via the service worker) and a hosted file (`?src=`). Pure helpers so they are testable
 * without a browser. What works on which platform: docs/OPENING.md.
 */

/** The only media type the player itself writes for a .wgif (SPEC §2). */
export const WGIF_MEDIA_TYPE = 'application/vnd.wgif+zip';
/** What the picker filters to on desktop, where browsers match by extension. */
export const DESKTOP_ACCEPT = `.wgif,${WGIF_MEDIA_TYPE},application/zip`;
/** A hosted world fetched with `?src=` is refused above this size, before it is unpacked. */
export const MAX_REMOTE_BYTES = 64 * 1024 * 1024;
/** Where the service worker parks a file shared to the installed app (Web Share Target). */
export const SHARE_CACHE = 'wgif-shared-file';
export const SHARE_KEY = './__shared.wgif';

export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
}

/** iPhone, iPod, and iPads that present themselves as a Mac ("desktop website" is on by default). */
export function isAppleMobile(nav: NavigatorLike): boolean {
  if (/iPhone|iPad|iPod/.test(nav.userAgent)) return true;
  return /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1;
}

export function isAndroid(nav: NavigatorLike): boolean {
  return /Android/i.test(nav.userAgent);
}

/**
 * The `accept` attribute for the "Open .wgif" picker, or null for none.
 *
 * iOS turns `accept` into a list of file types (UTIs) and greys out every file it cannot match.
 * A `.wgif` file has no registered type on iOS, so with any `accept` at all the exported file
 * cannot be tapped in the Files picker. Android's picker filters by media type, and a `.wgif` is
 * usually stored as application/octet-stream, so it can hide it as well. On phones and tablets
 * the picker therefore shows everything, and the player checks what was picked (notAWorld + full
 * validation) instead.
 */
export function pickerAccept(nav: NavigatorLike): string | null {
  return isAppleMobile(nav) || isAndroid(nav) ? null : DESKTOP_ACCEPT;
}

/** A .wgif is a ZIP whose first member is manifest.json (SPEC §2). */
export function looksLikeWgif(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Human words for a picked file that is not a world at all, or null when it might be one. */
export function notAWorld(bytes: Uint8Array, name: string): string | null {
  if (looksLikeWgif(bytes)) return null;
  if (isPng(bytes) || (bytes[0] === 0xff && bytes[1] === 0xd8)) return `${name} is an image, not a .wgif world. Pick the .wgif file itself.`;
  return `${name} is not a .wgif world (a .wgif is a ZIP archive that starts with manifest.json).`;
}

export type SrcResult = { url: URL } | { error: string } | null;

/**
 * Reads `?src=<url>` ("open this hosted .wgif"). Only https URLs are accepted, plus plain http for
 * the player's own origin or localhost, so a link cannot point the player at data:, blob:, file:
 * or javascript: URLs. The visitor chose to open the link; the world itself still never fetches
 * anything (SPEC §4). Cross-origin hosts must allow CORS.
 */
export function readSrcParam(search: string, base: string): SrcResult {
  const raw = new URLSearchParams(search).get('src');
  if (raw === null || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return { error: 'The link to the world is not a valid address.' };
  }
  const own = new URL(base);
  if (url.protocol === 'https:') return { url };
  if (url.protocol === 'http:' && (url.origin === own.origin || url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return { url };
  return { error: `The player only opens worlds from https:// links (got ${url.protocol}).` };
}

/** The last path segment of a URL, as a file name to show. */
export function nameFromUrl(url: URL): string {
  let last = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {
    // keep it encoded
  }
  return last || 'world.wgif';
}

/** `galactic-court-edit.wgif` -> `galactic-court-edit.png`. */
export function imageNameFor(fileName: string): string {
  return `${fileName.replace(/\.wgif$/i, '') || 'world'}.png`;
}

/** Whether these bytes are a PNG (the 8-byte signature). */
export function isPng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length > 8 && sig.every((b, i) => bytes[i] === b);
}

/** Width and height from a PNG's IHDR, or null. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.length < 24) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Preview limits authors SHOULD keep (SPEC §4); the player holds the previews it writes to them. */
export const PREVIEW_MAX_SIDE = 512;
export const PREVIEW_MAX_BYTES = 256 * 1024;

/** Whether a freshly rendered preview may go into an export: a PNG inside the SPEC §4 limits. */
export function previewFits(bytes: Uint8Array): boolean {
  const size = pngSize(bytes);
  return !!size && size.width > 0 && size.height > 0 && Math.max(size.width, size.height) <= PREVIEW_MAX_SIDE && bytes.byteLength <= PREVIEW_MAX_BYTES;
}

/** Fits a view of w x h inside a square of `side`, keeping its shape. */
export function fitWithin(w: number, h: number, side: number): { width: number; height: number } {
  const k = Math.min(1, side / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
