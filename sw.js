// M5 replaces this with offline caching. For now: always fetch the latest files
// (GitHub Pages lets browsers keep stale copies for 10 minutes), and take over
// right away when a new version of this file is deployed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(url, { cache: 'no-cache' }));
});
