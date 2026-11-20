// Exercise the actual stored correction validator without a browser.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "..", "web", "bills.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf("function validPending("), source.indexOf("function setPending(")), context);
const valid = (value) => context.validPending(value);
const id = "c2669a6e-1772-4d77-a4f9-0298422c7a67", other = "6e67d2a7-a06f-4149-bb6b-9a17a530b5ec";
const correction = { binding_id: id, saleId: id, payload: { id: other, reason: "แก้รายการ" } };
const replacement = { id, items: [{ product_id: id, unit_id: other, quantity: "1.5", expected_unit_price: "2.005" }],
  payments: { cash: "3.01", credit: "0", qr: "0" }, customer_id: null, qr_confirmed: false };

test("bound void and a replacement with line rounding remain valid", () => {
  assert.equal(valid(correction), true);
  assert.equal(valid({ ...correction, payload: { ...correction.payload, replacement } }), true);
});

test("incomplete requests, invalid payment and malformed amounts are held", () => {
  for (const value of [
    { saleId: id, payload: { id: other } },
    { ...correction, payload: { ...correction.payload, expected_excess: "0.001" } },
    { ...correction, payload: { ...correction.payload, replacement: { ...replacement, items: [] } } },
    { ...correction, payload: { ...correction.payload, replacement: { ...replacement, payments: { ...replacement.payments, cash: "3.00" } } } },
    { ...correction, payload: { ...correction.payload, replacement: { ...replacement, payments: { cash: "0", credit: "0", qr: "3.01" } } } },
  ]) assert.equal(valid(value), false);
});


test("legacy and invalid bindings are retained without being replayable", () => {
  const { binding_id, ...legacy } = correction;
  assert.equal(valid(legacy), false);
  for (const value of [null, "", "not-a-uuid", 1]) {
    assert.equal(valid({ ...correction, binding_id: value }), false);
  }
});
