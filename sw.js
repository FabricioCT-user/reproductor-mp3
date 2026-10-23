// Cachea la aplicación para que funcione sin conexión.
// Sube VERSION al cambiar la lista de archivos (los archivos en sí se revalidan siempre con la red).
const VERSION = "v2";
const FILES = [
  "./",
  "index.html",
  "style.css",
  "src/util.js",
  "src/lyrics.js",
  "src/playlist-io.js",
  "src/id3.js",
  "src/tags.js",
  "src/tag-writer.js",
  "src/storage.js",
  "src/app/core.js",
  "src/app/library.js",
  "src/app/playlists.js",
  "src/app/lyrics-ui.js",
  "src/app/player.js",
  "src/app/eq.js",
  "src/app/fades.js",
  "src/app/editor.js",
  "src/app/theme.js",
  "src/app/main.js",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  // «reload» salta la caché HTTP del navegador: se precachea siempre la versión actual.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Red primero, revalidando siempre (así una versión nueva se ve al recargar aunque el servidor permita cachear);
// si no hay conexión, se sirve la copia guardada.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {}); // p. ej. las respuestas parciales (206) no se pueden cachear
        }
        return res;
      })
      .catch(async () => (await caches.match(e.request, { ignoreSearch: true })) || (e.request.mode === "navigate" ? caches.match("./") : undefined))
  );
});
