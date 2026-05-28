const CACHE_NAME = "arctic-dominion-static-v1";

const CORE_ASSETS = [
  "/",
  "/index.html",

  "/assets/screens/cover.png",
  "/assets/screens/main-menu.png",
  "/assets/screens/mode-offline-selected.png",
  "/assets/screens/mode-online-selected.png",
  "/assets/screens/player-count.png",
  "/assets/screens/team-select.png",
  "/assets/screens/arctic-dominion-game-base.png",

  "/assets/arctic/pieces/green-frost-king.png",
  "/assets/arctic/pieces/green-war-mammoth.png",
  "/assets/arctic/pieces/green-aurora-unicorn.png",
  "/assets/arctic/pieces/green-icebreaker.png",
  "/assets/arctic/pieces/green-snow-guard.png",

  "/assets/arctic/pieces/red-frost-king.png",
  "/assets/arctic/pieces/red-war-mammoth.png",
  "/assets/arctic/pieces/red-aurora-unicorn.png",
  "/assets/arctic/pieces/red-icebreaker.png",
  "/assets/arctic/pieces/red-snow-guard.png",

  "/assets/arctic/pieces/blue-frost-king.png",
  "/assets/arctic/pieces/blue-war-mammoth.png",
  "/assets/arctic/pieces/blue-aurora-unicorn.png",
  "/assets/arctic/pieces/blue-icebreaker.png",
  "/assets/arctic/pieces/blue-snow-guard.png",

  "/assets/arctic/pieces/pink-frost-king.png",
  "/assets/arctic/pieces/pink-war-mammoth.png",
  "/assets/arctic/pieces/pink-aurora-unicorn.png",
  "/assets/arctic/pieces/pink-icebreaker.png",
  "/assets/arctic/pieces/pink-snow-guard.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Network-first for HTML so index.html updates quickly.
  if (event.request.mode === "navigate" || url.pathname.endsWith(".html")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Cache-first for images/assets.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        });
      })
    );
  }
});
