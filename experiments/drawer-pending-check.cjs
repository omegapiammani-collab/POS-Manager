// Exercise the real stored-request validator with isolated action names.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "..", "web", "drawer.js"), "utf8");
const context = vm.createContext({ actionForms: { open: {}, movements: {}, close: {} } });
vm.runInContext(source.slice(source.indexOf("function validPending("), source.indexOf("function setPending(")), context);
const id = "c2669a6e-1772-4d77-a4f9-0298422c7a67", date = "2026-11-13";
const valid = (value) => context.validPending({ ...value, binding_id: id });

test("legacy drawer requests without binding cannot be sent automatically", () => {
  assert.equal(context.validPending({ action: "open", payload: { id, date, opening_cash: "100" } }), false);
});

test("all supported drawer actions accept the original payload", () => {
  for (const value of [
    { action: "open", payload: { id, date, opening_cash: "100.00" } },
    { action: "movements", payload: { id, date, direction: "out", amount: "1e2", reason: "ถอน" } },
    { action: "close", payload: { id, date, actual_cash: "0", expected_cash: "-25.00" } },
    { action: "open", payload: { id, date, opening_cash: 0 } },
    { action: "open", payload: { id, date, opening_cash: "-0" } },
  ]) assert.equal(valid(value), true);
});

test("invalid dates, payloads, actions and unsafe amounts fail closed", () => {
  for (const value of [
    { action: "open", payload: { id, date: "2026-02-30", opening_cash: "1" } },
    { action: "unrecognized", payload: { id, date, opening_cash: "1" } },
    { action: "movements", payload: { id, date, direction: "in", amount: "0", reason: "x" } },
    { action: "movements", payload: { id, date, direction: "in", amount: "1", reason: " " } },
    { action: "close", payload: { id, date, actual_cash: "1", expected_cash: "1.001" } },
    { action: "close", payload: { id, date, actual_cash: "1", expected_cash: "10000000000000000000000000.01" } },
    { action: "open", payload: { id, date, opening_cash: "1000000000.01" } },
  ]) assert.equal(valid(value), false);
});
