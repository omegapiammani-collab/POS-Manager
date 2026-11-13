const SHELL_PREFIX = "pos-checkout-shell-";
const SHELL_CACHE = SHELL_PREFIX + "9";
const CHECKOUT = "/checkout";
const BACKUP = "/checkout/backup";
const ASSETS = new Set(["/checkout.js", "/offline-store.js", "/inventory.css", "/backup.js"]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll([CHECKOUT, BACKUP, ...ASSETS].map((path) =>
      new Request(path, { cache: "reload", redirect: "error" })
    ));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function fetchShell(request, path) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(path);
    if (cached) return cached;
    throw error;
  }

  if (response.ok && !response.redirected && response.type !== "opaque") {
    try {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(path, response.clone());
    } catch {
      // The online page remains available if storage is full or disabled.
    }
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const allowed = request.mode === "navigate"
    ? url.pathname === CHECKOUT || url.pathname === BACKUP
    : !url.search && ASSETS.has(url.pathname);
  if (allowed) event.respondWith(fetchShell(request, url.pathname));
});
