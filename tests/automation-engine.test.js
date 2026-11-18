"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { discrepancy } = require("../utils/automation/engine");

const a = "a".repeat(24);
const b = "b".repeat(24);
const order = { items: [{ name: "legacy" }, { marketplace: { accountId: a, supplierPayablePaise: 50000 } }, { marketplace: { accountId: b, supplierPayablePaise: 8400 } }] };
const shipments = [{ supplier: a, itemIndices: [1] }, { supplier: b, itemIndices: [2] }];
const rows = order.items.slice(1).map((item, n) => ({ itemIndex: n + 1, supplier: item.marketplace.accountId, snapshot: item.marketplace }));
test("mixed first-party and multi-supplier lines reconcile to immutable supplier snapshots", () => {
  assert.equal(discrepancy(order, shipments, rows), "");
  assert.equal(discrepancy(null, shipments, rows), "ORDER_MISSING");
  assert.equal(discrepancy({items:[{marketplace:{accountId:a}}]}, [], []), "SUPPLIER_SNAPSHOT_INVALID");
});
test("missing or duplicated shipment lines and mismatched suppliers need review", () => {
  for (const invalid of [shipments.slice(1), [...shipments, shipments[0]], [{ supplier: a, itemIndices: [1,2] }]]) {
    assert.equal(discrepancy(order, invalid, rows), "FULFILMENT_MISMATCH");
  }
});
test("wrong supplier amounts or extra entitlement rows need review", () => {
  assert.equal(discrepancy(order, shipments, [rows[0], rows[0]]), "ENTITLEMENT_MISMATCH");
  assert.equal(discrepancy(order, shipments, [rows[0], {...rows[1], snapshot:{supplierPayablePaise:55000}}]), "ENTITLEMENT_MISMATCH");
});
