// Exercise the actual service worker logic with deterministic network and cache.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

function harness(initial, network) {
  const entries = initial instanceof Map ? initial : new Map(Object.entries(initial));
  const cache = { match: async (path) => entries.get(path) };
  const context = vm.createContext({
    self: { addEventListener() {} }, caches: { open: async () => cache }, fetch: network,
    Response: { error: () => ({ type: "error", status: 0 }) },
  });
  const source = readFileSync(join(__dirname, "..", "web", "sw.js"), "utf8")
    .replaceAll("__SHELL_REVISION__", "v1");
  vm.runInContext(source, context);
  return { navigation: (path) => context.fetchNavigation({ url: path }, path),
    asset: (path) => context.fetchAsset({ url: path + "?shell=v1" }, path), entries };
}
function response(body, status = 200) { return { body, status }; }

test("503 and network failure return the same versioned HTML and assets", async () => {
  for (const failure of [async () => response("error", 503), async () => { throw Error("offline"); }]) {
    const h = harness({ "/checkout?shell=v1": response("html-v1"),
      "/checkout.js?shell=v1": response("js-v1") }, failure);
    assert.equal((await h.navigation("/checkout")).body, "html-v1");
    assert.equal((await h.asset("/checkout.js")).body, "js-v1");
    assert.equal(h.entries.size, 2);
  }
});

test("non-5xx navigation and 5xx with no cached HTML are returned unchanged", async () => {
  for (const status of [200, 301, 404, 503]) {
    const h = harness({}, async () => response("network", status));
    assert.equal((await h.navigation("/checkout")).status, status);
  }
  const h = harness({}, async () => { throw Error("offline"); });
  await assert.rejects(h.navigation("/checkout"), /snapshot unavailable/);
});

test("a missing asset never fetches from a server that ignores the revision", async () => {
  let requests = 0;
  const h = harness({}, async () => { requests++; return response("wrong-release", 200); });
  assert.equal((await h.asset("/checkout.js")).type, "error");
  assert.equal(requests, 0);
});

test("worker restart preserves fail-closed behavior and cached backup assets", async () => {
  const entries = new Map([["/checkout/backup?shell=v1", response("backup-v1")],
    ["/backup.js?shell=v1", response("backup-js-v1")]]);
  let requests = 0;
  const network = async () => { requests++; return response("wrong-release", 200); };
  const restarted = harness(entries, network);
  assert.equal((await restarted.asset("/backup.js")).body, "backup-js-v1");
  entries.delete("/backup.js?shell=v1");
  assert.equal((await harness(entries, network).asset("/backup.js")).type, "error");
  assert.equal(requests, 0);
});
