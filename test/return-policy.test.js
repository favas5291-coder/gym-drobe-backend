"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validRequestTypes,
  requestTypes,
  returnPolicyIssue,
} = require("../utils/returnPolicy");

const {
  calculateOrderPricing,
} = require("../utils/orderPricing");

const {
  buildKitCheckoutPricing,
} = require("../utils/kitCheckoutPricing");

const Product = require("../models/Product");

const delivered = Date.parse(
  "2026-10-01T12:00:00Z",
);

const product = {
  _id: "6ad2351ed8f991271e3d1a8b",
  name: "Training shirt",
  category: "Clothing",
  brand: "GymDrobe",
  price: 699,
  discount: 0,
  stock: 5,
  isActive: true,
  sku: "GD-FIXTURE-SHIRT",
  slug: "training-shirt",

  returnsEligible: "yes",
  returnRequestTypes: ["exchange"],
  returnWindowDays: 3,

  returnConditions:
    "Exchange unused items within 72 hours, with original tags.",
};

test(
  "request types reject duplicates and unsupported actions",
  () => {
    const invalidValues = [
      null,
      {},
      [],
      ["refund"],
      ["return", "return"],
      ["return", "exchange", "return"],
    ];

    for (const value of invalidValues) {
      assert.equal(
        validRequestTypes(value),
        false,
      );
    }

    assert.equal(
      validRequestTypes([
        "return",
        "exchange",
      ]),
      true,
    );
  },
);

test(
  "72-hour exchange deadline is enforced to the millisecond",
  () => {
    assert.equal(
      returnPolicyIssue(
        product,
        "exchange",
        delivered,
        delivered + 3 * 86400000,
      ),
      null,
    );

    assert.equal(
      returnPolicyIssue(
        product,
        "exchange",
        delivered,
        delivered + 3 * 86400000 + 1,
      ).code,
      "RETURN_WINDOW_ENDED",
    );

    assert.equal(
      returnPolicyIssue(
        product,
        "return",
        delivered,
        delivered + 86400000,
      ).code,
      "RETURN_TYPE_NOT_ALLOWED",
    );
  },
);

test(
  "seven-day return uses its purchase snapshot, not the edited catalogue",
  () => {
    const snapshot = {
      ...product,
      returnWindowDays: 7,
      returnRequestTypes: [
        "return",
        "exchange",
      ],
    };

    const currentProduct = {
      ...snapshot,
      returnWindowDays: 1,
      returnRequestTypes: ["exchange"],
    };

    assert.equal(
      returnPolicyIssue(
        snapshot,
        "return",
        delivered,
        delivered + 6 * 86400000,
      ),
      null,
    );

    assert.equal(
      returnPolicyIssue(
        currentProduct,
        "return",
        delivered,
        delivered + 6 * 86400000,
      ).code,
      "RETURN_TYPE_NOT_ALLOWED",
    );
  },
);

test(
  "historical purchases without the field keep their original supported actions",
  () => {
    const legacy = {
      ...product,
    };

    delete legacy.returnRequestTypes;

    assert.deepEqual(
      requestTypes(legacy),
      ["return", "exchange"],
    );

    assert.equal(
      returnPolicyIssue(
        legacy,
        "return",
        delivered,
        delivered + 86400000,
      ),
      null,
    );

    assert.deepEqual(
      requestTypes({
        returnRequestTypes: [],
      }),
      [],
    );
  },
);

test(
  "ineligible items and malformed or future delivery dates remain blocked",
  () => {
    assert.equal(
      returnPolicyIssue(
        {
          ...product,
          returnsEligible: "no",
        },
        "exchange",
        delivered,
        delivered + 1,
      ).code,
      "ITEM_NOT_RETURNABLE",
    );

    const invalidDates = [
      [NaN, delivered],
      [delivered + 1, delivered],
      [delivered, Infinity],
    ];

    for (const [date, now] of invalidDates) {
      assert.equal(
        returnPolicyIssue(
          product,
          "exchange",
          date,
          now,
        ).code,
        "RETURN_POLICY_UNCONFIRMED",
      );
    }
  },
);

test(
  "server pricing uses 500/99 after discounts and preserves express",
  () => {
    const cases = [
      [499, 99],
      [500, 0],
      [699, 0],
    ];

    for (const [price, shipping] of cases) {
      const pricing = calculateOrderPricing({
        cart: [
          {
            price,
            quantity: 1,
          },
        ],
      });

      assert.equal(
        pricing.shipping,
        shipping,
      );
    }

    const express = calculateOrderPricing({
      cart: [
        {
          price: 500,
          quantity: 1,
        },
      ],
      deliveryMethod: "express",
    });

    assert.equal(
      express.shipping,
      199,
    );
  },
);

test(
  "checkout snapshots policy from server products and ignores customer policy and price",
  () => {
    const quote = buildKitCheckoutPricing({
      items: [
        {
          id: product._id,
          quantity: 1,
          price: 1,
          returnRequestTypes: ["return"],
          returnWindowDays: 7,
        },
      ],

      products: [product],
      kits: [],
      paymentMethod: "cod-partial",
    });

    assert.deepEqual(
      quote.items[0].returnRequestTypes,
      ["exchange"],
    );

    assert.equal(
      quote.items[0].returnWindowDays,
      3,
    );

    assert.equal(
      quote.items[0].price,
      699,
    );

    product.returnRequestTypes.push("return");

    assert.deepEqual(
      quote.items[0].returnRequestTypes,
      ["exchange"],
    );

    product.returnRequestTypes.pop();
  },
);

test(
  "new confirmed products require explicit supported actions",
  async () => {
    const doc = new Product({
      ...product,
      isActive: false,
      returnRequestTypes: [],
    });

    const error = await doc.validate().then(
      () => null,
      (error) => error,
    );

    assert.ok(
      error?.errors?.returnRequestTypes,
    );
  },
);

test(
  "new products with a recorded three-day exchange policy validate",
  async () => {
    const doc = new Product({
      ...product,
      isActive: false,
    });

    await doc.validate();

    assert.deepEqual(
      [...doc.returnRequestTypes],
      ["exchange"],
    );

    assert.equal(
      doc.returnWindowDays,
      3,
    );
  },
);

test(
  "stock-only updates to legacy products do not require a policy rewrite",
  async () => {
    const legacy = {
      ...product,
      isActive: false,
    };

    delete legacy.returnRequestTypes;

    const doc = Product.hydrate(legacy);

    doc.stock = 4;

    await doc.validate();

    assert.equal(
      doc.returnRequestTypes,
      undefined,
    );

    assert.equal(
      doc.returnWindowDays,
      3,
    );
  },
);