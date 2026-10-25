"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shippingWithRecord,
} = require("./helpers/checkoutShipping.cjs");

const {
  defaultShippingSettings,
} = require("../utils/shippingSettings");

test(
  "absent settings use defaults, but database failures and malformed settings block checkout",
  async () => {
    assert.deepEqual(
      await shippingWithRecord().loadShippingSettings(),
      defaultShippingSettings(),
    );

    await assert.rejects(
      shippingWithRecord(
        null,
        new Error("Database unavailable"),
      ).loadShippingSettings(),
      {
        code: "SHIPPING_SETTINGS_UNAVAILABLE",
      },
    );

    await assert.rejects(
      shippingWithRecord({
        version: "invalid",
      }).loadShippingSettings(),
      {
        code: "SHIPPING_SETTINGS_UNAVAILABLE",
      },
    );
  },
);

test(
  "saved shipping thresholds affect real ordinary checkout pricing and preserve COD totals",
  async () => {
    const settings = defaultShippingSettings();

    settings.version = 2;
    settings.freeShipping.minimumSubtotalPaise = 150000;

    const shipping = shippingWithRecord(settings);

    const product = {
      _id: "507f1f77bcf86cd799439011",
      category: "Clothing",
    };

    const result = shipping.priceCheckoutShipping({
      settings: await shipping.loadShippingSettings(),

      pricing: {
        subtotal: 1000,
        couponDiscount: 0,
        totalAfterCoupon: 1000,
      },

      items: [
        {
          product: product._id,
          quantity: 1,
        },
      ],

      products: [product],
      paymentMethod: "cod-partial",
      pincode: "673001",
    });

    assert.equal(
      result.pricing.shipping,
      99,
    );

    assert.equal(
      result.payment.amountToPayNow,
      100,
    );

    assert.equal(
      result.payment.amountDue,
      999,
    );

    assert.equal(
      result.freeShipping.version,
      2,
    );

    assert.equal(
      result.freeShipping.qualified,
      false,
    );
  },
);