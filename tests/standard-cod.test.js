"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { assertCodCoverage, standardCod } = require("../utils/standardCod");
const { shippingWithRecord } = require("./helpers/checkoutShipping.cjs");
const { defaultShippingSettings } = require("../utils/shippingSettings");

test("standard COD requires explicit activation and approved pincode before confirmation", t => {
  const before = { ...process.env };
  t.after(() => {
    for (const key of ["STANDARD_COD_ENABLED", "STANDARD_COD_PINCODES"]) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });
  delete process.env.STANDARD_COD_ENABLED;
  assert.throws(() => assertCodCoverage({}, "673001", true), { code: "COD_DISABLED" });
  process.env.STANDARD_COD_ENABLED = "true";
  process.env.STANDARD_COD_PINCODES = "000000, invalid";
  assert.throws(() => assertCodCoverage({}, "", false), { code: "COD_PINCODE_UNAVAILABLE" });
  process.env.STANDARD_COD_PINCODES = " 673001 , 560001";
  assert.doesNotThrow(() => assertCodCoverage({}, "", false));
  assert.throws(() => assertCodCoverage({}, "", true), { code: "COD_PINCODE_UNAVAILABLE" });
  assert.throws(() => assertCodCoverage({}, "600001", true), { code: "COD_PINCODE_UNAVAILABLE" });
  assert.doesNotThrow(() => assertCodCoverage({}, "560001", true));
  assert.throws(() => assertCodCoverage({ items: [{ kitGroup: null }] }, "560001", true), { code: "COD_KIT_UNAVAILABLE" });
});

test("new zero-advance, legacy partial and prepaid quotes use their own collection schedule", () => {
  const product = { _id: "507f1f77bcf86cd799439011", category: "Clothing" };
  const input = { settings: defaultShippingSettings(), pricing: { subtotal: 100, couponDiscount: 0, totalAfterCoupon: 100 },
    items: [{ product: product._id, quantity: 1 }], products: [product], pincode: "673001" };
  const { priceCheckoutShipping } = shippingWithRecord();
  for (const [method, paidNow] of [["cod", 0], ["cod-partial", 10], ["razorpay", 199]]) {
    const { pricing, payment } = priceCheckoutShipping({ ...input, paymentMethod: method });
    assert.equal(pricing.finalTotal, 199);
    assert.equal(payment.amountToPayNow, paidNow);
    assert.equal(payment.amountDue, 199 - paidNow);
  }
  assert.equal(standardCod({ payment: { method: "cod" } }), false);
  assert.equal(standardCod({ payment: { method: "cod-partial" }, metadata: { version: "cod-1" } }), false);
  assert.equal(standardCod({ payment: { method: "cod" }, metadata: { version: "cod-1" } }), true);
});
