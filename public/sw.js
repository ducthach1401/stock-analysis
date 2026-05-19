/* global self, caches, fetch */
const VERSION = 'stock-analysis-sw-v33';
const PRECACHE = [
  '/index.html',
  '/css/app.css',
  '/vendor/tailwindcss-3.4.17.js',
  '/vendor/alpinejs-3.x.x.min.js',
  '/vendor/lightweight-charts-4.2.0.standalone.production.js',
  '/js/config.js',
  '/js/app.js',
  '/js/ticker-picker.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function isApiPath(pathname) {
  return (
    pathname.startsWith('/auth') ||
    pathname.startsWith('/signals') ||
    pathname.startsWith('/positions') ||
    pathname.startsWith('/scanner') ||
    pathname.startsWith('/watchlist') ||
    pathname.startsWith('/stock') ||
    pathname.startsWith('/queue') ||
    pathname.startsWith('/api')
  );
}

function isAppShellAsset(request) {
  return ['style', 'script', 'worker', 'manifest', 'image', 'font'].includes(
    request.destination,
  );
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('Network unavailable and no cached response');
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isApiPath(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }

  if (url.pathname === '/sw.js') {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      networkFirst(request).catch(() => caches.match('/index.html')),
    );
    return;
  }

  if (isAppShellAsset(request)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});
