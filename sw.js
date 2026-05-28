// sw.js — rebuild-safe service worker.
// Clears old Chaturanga/Arctic caches and unregisters itself so Vercel updates show immediately.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister())
  );
});

self.addEventListener("fetch", () => {
  // Intentionally no caching during rebuild.
});
