/**
 * WGIF Player service worker — hand-written, zero runtime dependencies.
 *
 * Built by the offlinePrecache Vite plugin (apps/player/vite-offline.ts),
 * which replaces the two __WGIF_*__ placeholders below with the versioned
 * cache name and this build's precache list (the app shell, the web
 * manifest, the icons and the sample court). The built file lives at
 * dist/sw.js and is registered from src/main.ts in production builds only.
 *
 * Behaviour: precached URLs are served cache-first, so a reload with the
 * network off makes zero network requests. Any other same-origin GET is
 * network-first with a cache fallback, and is cached for next time.
 * Cross-origin requests are never intercepted. Old caches are deleted on
 * activate, so a new version takes over cleanly.
 *
 * Why hand-written: vite-plugin-pwa would pull workbox-window into the
 * player bundle at runtime; the offline lane allows no new runtime
 * dependencies, so the worker is plain code the plugin only injects
 * constants into.
 */

// The service-worker globals, typed locally: the player's tsconfig uses the
// DOM lib, so the webworker lib is not available here. `self` is the DOM
// Window type in this file; cast it to the worker shape actually used.
interface ServiceWorkerSelf {
  readonly location: { readonly origin: string; readonly href: string };
  addEventListener(type: 'install' | 'activate', listener: (event: SwExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: SwFetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
}
interface SwExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface SwFetchEvent extends Event {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

const sw = self as unknown as ServiceWorkerSelf;

const CACHE_NAME = '__WGIF_CACHE_NAME__';
// Resolved against the worker's own URL, so the precache works whatever
// subpath the player is served from.
const PRECACHE: ReadonlySet<string> = new Set(
  (JSON.parse('__WGIF_PRECACHE_URLS__') as string[]).map((url) => new URL(url, sw.location.href).href),
);

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...PRECACHE])).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('wgif-player-') && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => sw.clients.claim()),
  );
});

// Web Share Target (manifest share_target, Android): a .wgif shared to the installed app arrives
// as a POST to ./share-target. Park it in its own cache and hand the page ./?shared=1, which
// opens it (src/main.ts). These names match SHARE_CACHE / SHARE_KEY in src/opening.ts.
const SHARE_CACHE = 'wgif-shared-file';
const SHARE_KEY = './__shared.wgif';
const SHARE_PATH = new URL('./share-target', sw.location.href).pathname;

async function receiveShare(request: Request): Promise<Response> {
  const back = (query: string): Response => Response.redirect(new URL(`./?${query}`, sw.location.href).href, 303);
  try {
    const form = await request.formData();
    const file = form.getAll('world').find((v): v is File => typeof v !== 'string');
    if (!file) return back('shared=none');
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(new URL(SHARE_KEY, sw.location.href).href, new Response(file, {
      headers: { 'Content-Type': 'application/vnd.wgif+zip', 'X-WGIF-Name': encodeURIComponent(file.name || 'shared.wgif') },
    }));
    return back('shared=1');
  } catch {
    return back('shared=none');
  }
}

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method === 'POST' && new URL(request.url).pathname === SHARE_PATH) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only same-origin requests are ever served from cache; anything else
  // (none in Phase One) goes to the network untouched.
  if (url.origin !== sw.location.origin) return;
  url.search = '';
  if (request.mode === 'navigate') {
    // A navigation to the shell root ('/') is precached as './', but a
    // navigation to any other path is not — serve the cached shell instead
    // of failing offline.
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request, { ignoreSearch: true }).then(
          (hit) =>
            hit ??
            cache.match(new URL('./index.html', sw.location.href), { ignoreSearch: true }).then(
              (shell) => shell ?? fetch(request),
            ),
        ),
      ),
    );
    return;
  }
  if (PRECACHE.has(url.href)) {
    // Cache-first for precached assets (the app shell + the sample court).
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request, { ignoreSearch: true }).then(
          (hit) =>
            hit ??
            fetch(request).then((response) => {
              // Clone before handing the response to the page, which consumes its body.
              if (response.ok) void cache.put(request, response.clone()).catch(() => undefined);
              return response;
            }),
        ),
      ),
    );
    return;
  }
  // Anything else same-origin: network first, cache fallback, and cache the
  // response so one online visit keeps it working offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          // Clone now, synchronously. Cloning later, inside caches.open().then(), raced the page
          // reading the body: "Failed to execute 'clone' on 'Response': Response body is already used".
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request, { ignoreSearch: true })
          .then((hit) => hit ?? Promise.reject(new Error(`offline and not cached: ${request.url}`))),
      ),
  );
});
