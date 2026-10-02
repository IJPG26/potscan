// Offline app shell (CHARTER §6.7).
// BUMP CACHE ON EVERY DEPLOY, or phones keep running the old files. The pre-commit hook checks this.
const CACHE = 'potscan-v6';
const FILES = [
  './', 'index.html', 'app.js', 'style.css', 'qrcode.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
];

// Download a fresh copy of every file (skipping the 10-minute HTTP cache). The new version then waits
// until the page asks it to take over, so nothing reloads in the middle of editing.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

// Cache first; the network only for anything not in the cache. "?v=…" style queries are ignored.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
