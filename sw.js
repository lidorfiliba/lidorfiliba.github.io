/* Bump CACHE on every deploy that changes a precached file.

   v9 -> v10: v9 served /app.js cache-first out of a cache whose name never
   changed, so once a visitor had the bundle it was pinned forever. Shipping a
   new app.js changed nothing for anyone who had already loaded the site — they
   kept running the old bundle indefinitely. That is what silently swallowed the
   thank-you page redirect in production: the HTML was fresh (network-first) but
   the behaviour lives in app.js, which was not.

   The version bump alone fixes it once. The strategy change below is what stops
   it recurring: app.js is now network-first, so a missed version bump costs a
   cache refresh, not a permanently stale deploy. */
const CACHE = 'sl-home-v17';
const PRECACHE = [
  './',
  '/index.html',
  '/privacy.html',
  '/thank-you.html',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  /* HTML / navigation: network-first so users get updates, falling back to
     cache for offline. `cache: 'no-cache'` for the same reason as the script
     branch below — GitHub Pages' max-age=600 would otherwise let a ten-minute-
     old document win over a fresh deploy. */
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
        .catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  /* Scripts: network-first, cache as offline fallback only.
     app.js carries the purchase flow and the conversion tracking, so a stale
     copy is not a cosmetic problem — it silently reverts behaviour the rest of
     the site assumes is live. Correctness wins over the few ms cache-first
     would save, and the page already blocks on React from unpkg anyway.

     `cache: 'no-cache'` is the load-bearing part. A plain fetch() here still
     reads the browser's own HTTP cache, and GitHub Pages serves assets with
     Cache-Control: max-age=600 — so "network-first" quietly meant
     "HTTP-cache-first for ten minutes after every deploy". That window is what
     served a pre-logOrder app.js to a browser whose service worker had already
     updated, and orders went unrecorded with no visible error.

     no-cache (not no-store) still sends the conditional request, so an
     unchanged bundle costs a 304 rather than a full re-download. */
  if (req.destination === 'script' || url.pathname.endsWith('.js')) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Icons and manifest: cache-first for instant repeat loads; refill on miss.
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
