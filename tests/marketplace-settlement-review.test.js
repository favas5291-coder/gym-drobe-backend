"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { supplierTarget } = require("../utils/marketplace/settlement");
const { compareOrder, reviewOrder } = require("../utils/marketplace/settlementReview");

const deliveredAt = new Date("2026-07-01");
const now = new Date("2026-07-09");
const purchase = { accountId: "A", quantity: 1, supplierPayablePaise: 50000, terms: { settlementHoldHours: 24 } };
const order = {
  _id: "ORDER", status: "delivered", delivery: { deliveredAt }, items: [{ marketplace: purchase, quantity: 1 }],
  pricing: { finalTotal: 550 }, payment: { status: "paid", grossCollected: 550, amountsReconciled: true, amountDue: 0 },
};
const earning = { supplier: "A", itemIndex: 0, snapshot: purchase, pendingAmount: 50000, targetAmount: 0, reversedAmount: 0, paidAmount: 0, reservedAmount: 0 };
const shipment = { supplier: "A", itemIndices: [0], status: "delivered", deliveredAt };

test("a delivered order cannot release an undelivered supplier parcel or a parcel without its delivery timestamp", () => {
  for (const group of [null, { ...shipment, status: "shipped" }, { ...shipment, deliveredAt: null }]) {
    assert.equal(supplierTarget(order, earning, group, now).pending, 50000);
  }
  assert.equal(supplierTarget({ ...order, status: "shipped" }, earning, shipment, now).amount, 50000);
});

test("a missing historical return window uses the purchased order policy default", () => {
  assert.equal(supplierTarget(order, earning, shipment, new Date("2026-07-08")).amount, 0);
  assert.equal(supplierTarget(order, earning, shipment, now).amount, 50000);
});

test("owner review compares independent supplier shipments, exposes stale balances, and leaves its inputs untouched", () => {
  const second = { ...purchase, accountId: "B" };
  const mixedOrder = { ...order, items: [...order.items, { marketplace: second, quantity: 1 }, { quantity: 1 }] };
  const earnings = [earning, { ...earning, supplier: "B", itemIndex: 1, snapshot: second }];
  const shipments = [shipment, { supplier: "B", status: "pending", itemIndices: [1] }];
  const before = JSON.stringify([mixedOrder, earnings, shipments]);
  const review = compareOrder(mixedOrder, earnings, shipments, now);
  assert.deepEqual(review.exceptions, [{ itemIndex: 0, code: "BALANCE_RECONCILIATION_REQUIRED" }]);
  assert.deepEqual(review.lines.map(line => line.calculated.eligiblePaise), [50000, 0]);
  assert.equal(JSON.stringify([mixedOrder, earnings, shipments]), before);
  assert.deepEqual(compareOrder(mixedOrder, earnings, shipments, now), review);
});

test("orphan earnings, missing commercial records and inconsistent amounts are explicit", () => {
  const exceptions = (rows, shipments = [shipment]) => compareOrder(order, rows, shipments, now).exceptions.map(x => x.code);
  assert.deepEqual(exceptions([{ ...earning, itemIndex: 2 }]), ["MISSING_ENTITLEMENT", "UNMATCHED_ENTITLEMENT"]);
  assert.deepEqual(exceptions([{ ...earning, snapshot: { ...purchase, supplierPayablePaise: 1 } }]), ["ENTITLEMENT_MISMATCH"]);
  assert.deepEqual(exceptions([earning], [{ ...shipment, itemIndices: [] }]), ["SHIPMENT_MEMBERSHIP_MISSING"]);
});

test("review rejects guests and supplier identities before opening a database session", async () => {
  await assert.rejects(reviewOrder(null, order._id), { status: 401 });
  await assert.rejects(reviewOrder({ _id: "A", role: "supplier" }, order._id), { status: 403 });
});
