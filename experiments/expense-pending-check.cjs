// Exercise the actual validation function without opening a browser.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "..", "web", "expenses.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf("function validPending("), source.indexOf("function savePending(")), context);
const validate = (value) => context.validPending(value);
const id = "c2669a6e-1772-4d77-a4f9-0298422c7a67";
const binding_id = "ed10542d-4d1e-4c54-ad32-81f1554ee991";
const create = { path: "/expenses", binding_id, payload: { id, date: "2026-11-13", description: "ค่าไฟ", amount: "25.00", source: "external" } };

test("create and void allow only supported paths and payloads", () => {
  assert.equal(validate(create), true);
  assert.equal(validate({ path: `/expenses/${id}/void`, binding_id, payload: { reason: "ผิด" } }), true);
  for (const value of [
    { ...create, path: "https://example.invalid/expenses" },
    { ...create, path: "/expenses?other=1" },
    { path: `/expenses/${id}/void`, binding_id, payload: {} },
    { ...create, payload: { ...create.payload, date: "2026-02-30" } },
    { ...create, payload: { ...create.payload, amount: "1e-3" } },
    { ...create, payload: { ...create.payload, source: "unknown" } },
  ]) assert.equal(validate(value), false);
});

test("supported exponent amounts and UTF-8 text remain valid", () => {
  for (const amount of ["1e2", "0.0001e2", ".50", "1000000000"]) {
    assert.equal(validate({ ...create, payload: { ...create.payload, amount } }), true);
  }
});

test("create and void reject absent or invalid store bindings", () => {
  const voidRequest = { path: `/expenses/${id}/void`, binding_id, payload: { reason: "ผิด" } };
  for (const request of [create, voidRequest]) {
    const { binding_id: ignored, ...withoutBinding } = request;
    assert.equal(validate(withoutBinding), false);
    for (const invalid of [null, "", "not-a-uuid", 123, {}, "ed10542d-4d1e-4c54-ad32-81f1554ee99z"]) {
      assert.equal(validate({ ...request, binding_id: invalid }), false);
    }
  }
});
