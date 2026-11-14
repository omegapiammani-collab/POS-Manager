const SHELL_PREFIX = "pos-checkout-snapshot-";
const SHELL_REVISION = "__SHELL_REVISION__";
const SHELL_CACHE = SHELL_PREFIX + SHELL_REVISION;
const CHECKOUT = "/checkout";
const BACKUP = "/checkout/backup";
const ASSETS = new Set(["/checkout.js", "/offline-store.js", "/inventory.css", "/backup.js"]);
const snapshotUrl = (path) => path + "?shell=" + SHELL_REVISION;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      await cache.addAll([CHECKOUT, BACKUP, ...ASSETS].map((path) =>
        new Request(snapshotUrl(path), { cache: "reload", redirect: "error" })
      ));
    } catch (error) {
      await caches.delete(SHELL_CACHE);
      throw error;
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => (name.startsWith(SHELL_PREFIX) || name.startsWith("pos-checkout-shell-")) && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function fetchNavigation(request, path) {
  let response;
  try {
    response = await fetch(request);
    if (response.status < 500 || response.status > 599) return response;
  } catch (error) {
    response = null;
  }
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(snapshotUrl(path));
  if (cached) return cached;
  if (response) return response;
  throw new Error("Checkout snapshot unavailable");
}

async function fetchAsset(request, path) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(snapshotUrl(path));
  if (cached) return cached;
  // A downgraded server or intermediary may ignore the revision query.
  // Refuse to mix that response with the cached document.
  return Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && (url.pathname === CHECKOUT || url.pathname === BACKUP)) {
    event.respondWith(fetchNavigation(request, url.pathname));
  } else if (ASSETS.has(url.pathname) && url.search === "?shell=" + SHELL_REVISION) {
    event.respondWith(fetchAsset(request, url.pathname));
  }
});
