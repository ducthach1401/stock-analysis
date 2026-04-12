/* global self, caches, fetch */
const VERSION = 'stock-analysis-sw-v1';
const PRECACHE = ['/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(PRECACHE).catch(() => {})),
  );
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
      fetch(request).catch(() => caches.match('/index.html')),
    );
    return;
  }

  event.respondWith(fetch(request));
});
