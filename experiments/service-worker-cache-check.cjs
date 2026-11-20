const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash, webcrypto } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const bodies = { "/checkout": "html-v1", "/checkout/backup": "backup-v1", "/checkout.js": "js-v1", "/backup.js": "backup-js-v1" };
const hashes = Object.fromEntries(Object.entries(bodies).map(([path, body]) => [path, createHash("sha256").update(body).digest("hex")]));
const result = (body, status = 200, type = body.startsWith("html-") || body === "backup-v1" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8") =>
  new Response(body, { status, headers: { "Content-Type": type } });

function harness(initial, network, { quota = false } = {}) {
  const entries = initial instanceof Map ? initial : new Map(Object.entries(initial));
  const cache = { match: async (path) => entries.get(path), put: async (path, value) => {
    if (quota) throw Error("quota"); entries.set(path, value);
  } };
  const context = vm.createContext({ self: { addEventListener() {} }, caches: { open: async () => cache },
    fetch: network, Response, Request: class { constructor(url) { this.url = url; } }, crypto: webcrypto, Uint8Array });
  const source = readFileSync(join(__dirname, "..", "web", "sw.js"), "utf8")
    .replaceAll("__SHELL_REVISION__", "v1").replace("__SHELL_HASHES__", JSON.stringify(hashes));
  vm.runInContext(source, context);
  return { navigation: (path) => context.fetchNavigation({ url: path }, path),
    asset: (path) => context.fetchAsset({ url: path + "?shell=v1" }, path), entries };
}

test("503 and offline use verified cached HTML and matching asset", async () => {
  for (const failure of [async () => result("error", 503), async () => { throw Error("offline"); }]) {
    const h = harness({ "/checkout?shell=v1": result("html-v1"), "/checkout.js?shell=v1": result("js-v1") }, failure);
    assert.equal(await (await h.navigation("/checkout")).text(), "html-v1");
    assert.equal(await (await h.asset("/checkout.js")).text(), "js-v1");
  }
});

test("non-5xx errors pass through; unavailable missing snapshot fails", async () => {
  for (const status of [301, 404, 503]) {
    const h = harness({}, async () => result("network", status));
    assert.equal((await h.navigation("/checkout")).status, status);
  }
  const h = harness({}, async () => { throw Error("offline"); });
  await assert.rejects(h.navigation("/checkout"), /snapshot unavailable/);
});

test("missing or corrupt cache accepts only matching bytes, never wrong release", async () => {
  const entries = new Map([["/checkout.js?shell=v1", result("corrupt")]]);
  const wrong = harness(entries, async () => result("wrong-release"));
  assert.equal((await wrong.asset("/checkout.js")).type, "error");
  assert.equal(await entries.get("/checkout.js?shell=v1").clone().text(), "corrupt");
  const correct = harness(entries, async () => result("js-v1"));
  assert.equal(await (await correct.asset("/checkout.js")).text(), "js-v1");
  assert.equal(await entries.get("/checkout.js?shell=v1").clone().text(), "js-v1");
});

test("worker restart, concurrent requests and storage quota preserve verified recovery", async () => {
  const entries = new Map();
  const h = harness(entries, async () => result("backup-js-v1"), { quota: true });
  const values = await Promise.all([h.asset("/backup.js"), h.asset("/backup.js")]);
  assert.deepEqual(await Promise.all(values.map((value) => value.text())), ["backup-js-v1", "backup-js-v1"]);
  assert.equal(entries.size, 0);
  const restarted = harness(entries, async () => result("backup-js-v1"));
  assert.equal(await (await restarted.asset("/backup.js")).text(), "backup-js-v1");
  assert.equal(entries.size, 1);
});

test("unmatched online HTML cannot replace a cached older shell", async () => {
  const h = harness({ "/checkout?shell=v1": result("html-v1") }, async () => result("html-v2"));
  assert.equal(await (await h.navigation("/checkout")).text(), "html-v1");
});

test("wrong MIME and charset are not used or cached, even when bytes match", async () => {
  for (const type of ["text/plain; charset=utf-8", "text/javascript; charset=windows-1252", "text/javascript; charset=utf-8; charset=windows-1252"]) {
    const entries = new Map([["/checkout.js?shell=v1", result("js-v1", 200, type)]]);
    const h = harness(entries, async () => result("js-v1", 200, type));
    assert.equal((await h.asset("/checkout.js")).type, "error");
    assert.equal(entries.get("/checkout.js?shell=v1").headers.get("content-type"), type);
    const healed = harness(entries, async () => result("js-v1", 200, 'text/javascript; foo=bar; charset="UTF-8"'));
    assert.equal(await (await healed.asset("/checkout.js")).text(), "js-v1");
    assert.equal(entries.get("/checkout.js?shell=v1").headers.get("content-type"), 'text/javascript; foo=bar; charset="UTF-8"');
  }
});

test("invalid HTML content type falls back to the valid snapshot, never the bad headers", async () => {
  for (const type of ["text/plain; charset=utf-8", "text/html; charset=iso-8859-1"]) {
    const h = harness({ "/checkout?shell=v1": result("html-v1") }, async () => result("html-v1", 200, type));
    const response = await h.navigation("/checkout");
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await response.text(), "html-v1");
  }
});

test("installation rejects a 200 response with mismatched bytes", async () => {
  let install, deleted = false, outcome;
  const cache = { addAll: async () => {}, match: async () => result("wrong-release") };
  const context = vm.createContext({
    self: { addEventListener(type, listener) { if (type === "install") install = listener; } },
    caches: { open: async () => cache, delete: async () => { deleted = true; } },
    Request: class { constructor(url) { this.url = url; } }, crypto: webcrypto, Uint8Array,
  });
  const source = readFileSync(join(__dirname, "..", "web", "sw.js"), "utf8")
    .replaceAll("__SHELL_REVISION__", "v1").replace("__SHELL_HASHES__", JSON.stringify(hashes));
  vm.runInContext(source, context);
  install({ waitUntil(promise) { outcome = promise; } });
  await assert.rejects(outcome, /Invalid checkout snapshot/);
  assert.equal(deleted, true);
});
