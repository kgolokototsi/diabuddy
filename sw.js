// Offline support for the app shell only. Bump VERSION when shipping changes.
//
// The API (readings, log, settings, phones) shares this origin, and those responses
// hold his personal data, so they are never cached here: only the files below are.
const VERSION = 'diabuddy-v32';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'dose.js', 'foods.js', 'spring.js', 'config.js', 'cgm.js', 'alerts.js', 'forecast.js', 'fonts/inter-latin.woff2',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'data/foods.json',
];
// App files that may be cached: the shell, food data, fonts and icons.
const STATIC = /^(?:|index\.html|styles\.css|[a-z]+\.js|manifest\.webmanifest|fonts\/[\w.-]+|icons\/[\w.-]+|data\/[\w-]+\.json)$/;
// Food data the family can add to: try the network first.
const LIVE = ['data/foods-custom.json'];

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

// High-glucose alerts from the relay (see worker/push.js). Shown as plain text only.
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data?.json() || {}; } catch {}
  e.waitUntil(self.registration.showNotification(String(msg.title || 'Alert').slice(0, 80), {
    body: String(msg.body || '').slice(0, 240),
    icon: 'icons/icon-192.png',
    tag: String(msg.tag || 'diabuddy').slice(0, 32),
    renotify: true,
  }));
});

// Tapping the alert opens DiaBuddy (or brings it to the front).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((list) => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (!STATIC.test(path)) return; // API and anything else: straight to the network, never stored
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
