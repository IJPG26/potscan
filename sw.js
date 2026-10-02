// M5 replaces this with offline caching. For now it only passes requests through,
// which is enough for Chrome to offer a full install (needed for the Lens test).
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
