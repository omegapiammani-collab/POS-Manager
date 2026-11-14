const SHELL_PREFIX = "pos-checkout-snapshot-";
const SHELL_REVISION = "__SHELL_REVISION__";
const SHELL_HASHES = __SHELL_HASHES__;
const SHELL_CACHE = SHELL_PREFIX + SHELL_REVISION;
const CHECKOUT = "/checkout";
const BACKUP = "/checkout/backup";
const ASSETS = new Set(["/checkout.js", "/offline-store.js", "/inventory.css", "/backup.js"]);
const snapshotUrl = (path) => path + "?shell=" + SHELL_REVISION;

async function verified(response, path) {
  if (!response || response.status !== 200 || response.redirected || response.type === "opaque") return false;
  try {
    const bytes = await response.clone().arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return hash === SHELL_HASHES[path];
  } catch {
    return false;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const paths = [CHECKOUT, BACKUP, ...ASSETS];
      await cache.addAll(paths.map((path) => new Request(snapshotUrl(path), { cache: "reload", redirect: "error" })));
      for (const path of paths) {
        if (!(await verified(await cache.match(snapshotUrl(path)), path))) throw new Error("Invalid checkout snapshot");
      }
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

async function snapshot(path) {
  let cache;
  try { cache = await caches.open(SHELL_CACHE); } catch { /* Try verified network without storing. */ }
  if (cache) {
    try {
      const cached = await cache.match(snapshotUrl(path));
      if (await verified(cached, path)) return cached;
    } catch { /* Try verified network if cache storage cannot be read. */ }
  }
  try {
    const response = await fetch(new Request(snapshotUrl(path), { cache: "reload", redirect: "error" }));
    if (!(await verified(response, path))) return null;
    if (cache) {
      try { await cache.put(snapshotUrl(path), response.clone()); } catch { /* Quota does not invalidate verified bytes. */ }
    }
    return response;
  } catch {
    return null;
  }
}

async function fetchNavigation(request, path) {
  let response;
  try {
    response = await fetch(request);
    if (response.status === 200) {
      if (await verified(response, path)) return response;
      response = null;
    } else if (response.status < 500 || response.status > 599) return response;
  } catch {
    response = null;
  }
  const cached = await snapshot(path);
  if (cached) return cached;
  if (response) return response;
  throw new Error("Checkout snapshot unavailable");
}

async function fetchAsset(request, path) {
  return (await snapshot(path)) ?? Response.error();
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
