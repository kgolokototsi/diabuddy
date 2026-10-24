// Offline support. Bump VERSION when shipping changes to the app shell.
const VERSION = 'diabuddy-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'dose.js', 'foods.js', 'admin.js', 'spring.js', 'config.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'data/foods.json',
];
// Shared files the admin can change: always try the network first.
const LIVE = ['settings.json', 'data/foods-custom.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  const key = new Request(url.origin + url.pathname); // ignore cache-busting query strings

  if (LIVE.includes(path)) {
    e.respondWith(
      fetch(e.request)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); return res; })
        .catch(() => caches.match(key)),
    );
    return;
  }

  // Stale-while-revalidate: instant from cache, refreshed in the background.
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(key);
      const network = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
