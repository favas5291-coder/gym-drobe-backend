const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const Order = require("../models/Order");

const {
  calculateItemRefundPaise,
} = require("../utils/orderRefundAllocation");

const {
  snapshotPurchasedShipping,
  validatePurchasedShipping,
} = require("../utils/purchasedShipping");

const {
  publicKitItemFields,
  publicKitOrderFields,
} = require("../utils/publicKitOrder");

const id = "507f1f77bcf86cd799439011";
const other = "507f1f77bcf86cd799439012";
const user = "507f1f77bcf86cd799439013";

function purchase(cod = true) {
  return {
    orderNumber: "GD-KIT-TEST",
    user,
    checkoutToken: "test-only",
    status: "payment-pending",

    customer: {
      name: "Test Customer",
      email: "test@example.test",
      phone: "9000000000",
    },

    shippingAddress: {
      fullName: "Test Customer",
      name: "Test Customer",
      email: "test@example.test",
      phone: "9000000000",
      addressLine: "Test street 123",
      city: "Kochi",
      state: "Kerala",
      pincode: "682001",
    },

    items: [
      {
        product: id,
        name: "Shirt",
        originalPrice: 100,
        price: 100,
        quantity: 3,
        selectedSize: "M",
        selectedColor: "Black",

        kit: {
          groupId: "kit-group-1",
          slotKey: "clothing",
          role: "clothing",
        },

        priceAllocation: {
          quantity: 3,
          lineSubtotalPaise: 30000,
          kitDiscountPaise: 3000,
          couponDiscountPaise: 1,
          linePaidPaise: 26999,
          unitBasePaise: 8999,
          extraPaiseUnits: 2,
        },
      },

      {
        product: other,
        name: "Shaker",
        originalPrice: 200,
        price: 200,
        quantity: 1,
        selectedSize: null,
        selectedColor: null,

        priceAllocation: {
          quantity: 1,
          lineSubtotalPaise: 20000,
          kitDiscountPaise: 0,
          couponDiscountPaise: 3,
          linePaidPaise: 19997,
          unitBasePaise: 19997,
          extraPaiseUnits: 0,
        },
      },
    ],

    kitSnapshots: [
      {
        groupId: "kit-group-1",
        template: id,
        templateVersion: 0,
        name: "Beginner kit",
        level: "beginner",
        fulfillmentMode: "packed-together",
        subtotalPaise: 30000,
        kitDiscountPaise: 3000,
        couponDiscountPaise: 1,
        linePaidPaise: 26999,
      },
    ],

    pricing: {
      subtotal: 500,
      kitDiscount: 30,
      couponDiscount: 0.04,
      totalAfterCoupon: 469.96,
      shipping: 99.10,
      finalTotal: 569.06,
      currency: "INR",
    },

    payment: {
      method: cod ? "cod-partial" : "razorpay",
    },

    paymentMethod: cod ? "cod-partial" : "razorpay",
    deliveryMethod: "standard",
  };
}

function review(cod = true) {
  const order = purchase(cod);

  return {
    ...order,

    shippingIsEstimate: false,

    payment: {
      ...order.payment,
      amountToPayNow: cod ? 47 : 569.06,
      amountDue: cod ? 522.06 : 0,
    },

    shippingReview: {
      ready: true,
      packageCount: 2,
      shippingPaise: 9910,

      validUntil: new Date(
        Date.now() + 86400000,
      ).toISOString(),

      shipments: [
        {
          key: "package-1",
          groupId: "kit-group-1",
          label: "Your kit",
          carrier: "Verified courier",
          service: "Standard",

          contents: [
            {
              itemIndex: 0,
              quantity: 3,
            },
          ],

          preparationDays: {
            minimum: 1,
            maximum: 2,
          },

          transitDays: {
            minimum: 2,
            maximum: 4,
          },

          estimatedDays: {
            minimum: 3,
            maximum: 6,
          },

          shipping: 50,
          amountDueOnDelivery: cod ? 292.99 : 0,
        },

        {
          key: "package-2",
          groupId: null,
          label: "Shaker",
          carrier: "Verified courier",
          service: "Standard",

          contents: [
            {
              itemIndex: 1,
              quantity: 1,
            },
          ],

          preparationDays: {
            minimum: 1,
            maximum: 2,
          },

          transitDays: {
            minimum: 2,
            maximum: 4,
          },

          estimatedDays: {
            minimum: 3,
            maximum: 6,
          },

          shipping: 49.10,
          amountDueOnDelivery: cod ? 229.07 : 0,
        },
      ],
    },
  };
}

function withShipping(cod = true) {
  const order = purchase(cod);

  order.shippingSnapshot = snapshotPurchasedShipping(
    review(cod),
    "682001",
  );

  return order;
}

function internals(filename, names, overrides = {}) {
  const absolute = path.resolve(
    __dirname,
    "../middleware/controllers",
    filename,
  );

  const base = createRequire(absolute);

  const module = {
    exports: {},
  };

  vm.runInNewContext(
    fs.readFileSync(absolute, "utf8") +
      `\nmodule.exports.__test = {${names}};`,

    {
      module,
      exports: module.exports,

      require: (name) => overrides[name] || base(name),

      console,
      Buffer,
      process,
      Date,
      URL,
      setTimeout,
      clearTimeout,
    },
  );

  return module.exports.__test;
}

test(
  "kit component refunds include kit and coupon savings and exclude shipping",
  () => {
    const order = purchase();

    assert.equal(
      calculateItemRefundPaise(
        order,
        [{ index: 0, quantity: 1 }],
      ),
      9000,
    );

    assert.equal(
      calculateItemRefundPaise(
        order,
        [{ index: 0, quantity: 2 }],
      ),
      18000,
    );

    assert.equal(
      calculateItemRefundPaise(
        order,
        [{ index: 0, quantity: 3 }],
      ),
      26999,
    );

    assert.equal(
      calculateItemRefundPaise(order, [
        { index: 0, quantity: 3 },
        { index: 1, quantity: 1 },
      ]),
      46996,
    );
  },
);

test(
  "rounding paise are refunded exactly once across disjoint units",
  () => {
    const order = purchase();

    const values = [0, 1, 2].map(
      (refundedUnitsBefore) =>
        calculateItemRefundPaise(order, [
          {
            index: 0,
            quantity: 1,
            refundedUnitsBefore,
          },
        ]),
    );

    assert.deepEqual(
      values,
      [9000, 9000, 8999],
    );

    assert.equal(
      values.reduce((a, b) => a + b, 0),
      26999,
    );
  },
);

test(
  "legacy ordinary coupon allocation retains cheaper-unit-first rounding",
  () => {
    const order = purchase();

    order.kitSnapshots = [];

    order.items.forEach((item) => {
      delete item.kit;
      delete item.priceAllocation;
    });

    order.pricing.kitDiscount = 0;
    order.pricing.couponDiscount = 0.01;
    order.pricing.totalAfterCoupon = 499.99;

    assert.equal(
      calculateItemRefundPaise(
        order,
        [{ index: 0, quantity: 1 }],
      ),
      9999,
    );

    assert.equal(
      calculateItemRefundPaise(order, [
        { index: 0, quantity: 3 },
        { index: 1, quantity: 1 },
      ]),
      49999,
    );
  },
);

test(
  "missing, forged and inconsistent purchase allocations are blocked",
  () => {
    const changes = [
      (order) => {
        delete order.items[0].priceAllocation;
      },

      (order) => {
        order.items[0].priceAllocation.unitBasePaise++;
      },

      (order) => {
        order.items[0].priceAllocation.extraPaiseUnits = 3;
      },

      (order) => {
        order.items[0].priceAllocation.quantity = 2;
      },

      (order) => {
        order.pricing.kitDiscount = 31;
      },

      (order) => {
        order.items[1].priceAllocation.kitDiscountPaise = 1;
      },
    ];

    for (const change of changes) {
      const order = purchase();

      change(order);

      assert.throws(
        () =>
          calculateItemRefundPaise(
            order,
            [{ index: 0, quantity: 1 }],
          ),
        (error) => error.code === "REFUND_AMOUNT_INVALID",
      );
    }
  },
);

test(
  "duplicate lines, invalid indexes and excessive return quantities are rejected",
  () => {
    const cases = [
      [{ index: 0, quantity: 4 }],
      [{ index: -1, quantity: 1 }],
      [{ index: 3, quantity: 1 }],
      [{ index: 0, quantity: 1.5 }],

      [
        { index: 0, quantity: 1 },
        { index: 0, quantity: 1 },
      ],

      [
        {
          index: 0,
          quantity: 2,
          refundedUnitsBefore: 2,
        },
      ],
    ];

    for (const rows of cases) {
      assert.throws(() =>
        calculateItemRefundPaise(purchase(), rows),
      );
    }
  },
);

test(
  "request and inspected completion controllers calculate the same purchased kit refund",
  () => {
    const request = internals(
      "orderController.js",
      "returnRefundCents",
    );

    const completion = internals(
      "returnCompletionController.js",
      "refundAmount",
    );

    assert.equal(
      request.returnRefundCents(
        purchase(),
        [{ index: 0, quantity: 2 }],
      ),
      18000,
    );

    assert.equal(
      completion.refundAmount(
        purchase(),
        [{ index: 0, returnedQuantity: 2 }],
      ),
      18000,
    );

    assert.equal(
      completion.refundAmount(
        purchase(),
        [{ index: 0, returnedQuantity: 0 }],
      ),
      0,
    );

    assert.equal(
      completion.refundAmount(purchase(), [
        {
          index: 0,
          returnedQuantity: 1,
          refundedUnitsBefore: 2,
        },
      ]),
      9000,
    );
  },
);

test(
  "reviewed package snapshot preserves exact COD allocations and independent copied contents",
  () => {
    const quote = review();

    const snapshot = snapshotPurchasedShipping(
      quote,
      "682001",
    );

    assert.equal(snapshot.packageCount, 2);
    assert.equal(snapshot.shippingPaise, 9910);
    assert.equal(snapshot.payNowPaise, 4700);
    assert.equal(snapshot.amountDuePaise, 52206);

    assert.equal(
      snapshot.shipments[0].contents[0].selectedSize,
      "M",
    );

    assert.equal(
      snapshot.shipments.reduce(
        (total, parcel) => total + parcel.amountDuePaise,
        0,
      ),
      52206,
    );

    quote.shippingReview.shipments[0].label =
      "Changed after purchase";

    assert.equal(
      snapshot.shipments[0].label,
      "Your kit",
    );
  },
);

test(
  "online payment parcels have no COD balances",
  () => {
    const order = withShipping(false);

    validatePurchasedShipping(order);

    assert.equal(
      order.shippingSnapshot.payNowPaise,
      56906,
    );

    assert.equal(
      order.shippingSnapshot.amountDuePaise,
      0,
    );
  },
);

test(
  "estimated and expired shipping reviews cannot become purchased snapshots",
  () => {
    const changes = [
      (quote) => {
        quote.shippingIsEstimate = true;
      },

      (quote) => {
        quote.shippingReview.ready = false;
      },

      (quote) => {
        quote.shippingReview.validUntil = new Date(
          Date.now() - 1000,
        ).toISOString();
      },
    ];

    for (const change of changes) {
      const quote = review();

      change(quote);

      assert.throws(() =>
        snapshotPurchasedShipping(quote, "682001"),
      );
    }
  },
);

test(
  "invalid package fees, variants, unit counts and COD distribution are rejected",
  () => {
    const changes = [
      (order) => {
        order.shippingSnapshot.destinationPincode =
          "682002";
      },

      (order) => {
        order.shippingSnapshot.shipments[0]
          .contents[0].quantity = 2;
      },

      (order) => {
        order.shippingSnapshot.shipments[0]
          .contents[0].selectedSize = "XL";
      },

      (order) => {
        order.shippingSnapshot.shipments[0]
          .shippingPaise++;
      },

      (order) => {
        order.shippingSnapshot.shipments[0]
          .estimatedDays.minimum = 10;
      },

      (order) => {
        order.shippingSnapshot.shipments[0]
          .amountDuePaise++;

        order.shippingSnapshot.shipments[1]
          .amountDuePaise--;
      },

      (order) => {
        order.shippingSnapshot.shipments[0]
          .groupId = null;
      },
    ];

    for (const change of changes) {
      const order = withShipping();

      change(order);

      assert.throws(() =>
        validatePurchasedShipping(order),
      );
    }
  },
);

test(
  "expired review dates do not invalidate a correctly recorded earlier purchase",
  () => {
    const order = withShipping();

    order.shippingSnapshot.reviewedAt = new Date(
      Date.now() - 86400000 * 2,
    );

    order.shippingSnapshot.validUntil = new Date(
      Date.now() - 86400000,
    );

    assert.doesNotThrow(() =>
      validatePurchasedShipping(order),
    );
  },
);

test(
  "Mongoose saves reconciled purchase terms and prevents document and query edits",
  async () => {
    const original = withShipping();
    const document = new Order(original);

    await document.validate();

    assert.equal(
      document.shippingSnapshot.shipments[0]
        .amountDuePaise,
      29299,
    );

    const saved = Order.hydrate(
      document.toObject({ transform: false }),
    );

    saved.status = "processing";

    await saved.validate();

    saved.shippingSnapshot.shipments[0]
      .shippingPaise = 1;

    await assert.rejects(
      saved.validate(),
      /cannot be changed/,
    );

    await assert.rejects(
      Order.updateOne(
        {},
        {
          $set: {
            "shippingSnapshot.shipments.0.shippingPaise": 1,
          },
        },
      ),
      /cannot be changed/,
    );

    await assert.rejects(
      Order.updateOne(
        {},
        {
          $rename: {
            other: "shippingSnapshot",
          },
        },
      ),
      /cannot be changed/,
    );

    await assert.rejects(
      Order.updateOne(
        {},
        {
          $set: {
            kitSnapshots: [],
          },
        },
      ),
      /cannot be changed/,
    );
  },
);

test(
  "both customer serializers expose purchased allocations while dropping private sourcing and unknown fields",
  () => {
    const order = withShipping();

    order.items[0].sourcing = {
      meeshoProductLink:
        "https://meesho.com/private/p/a",
    };

    order.items[0].priceAllocation.purchaseCost = 123;

    order.kitSnapshots[0].supplierContact =
      "PRIVATE SUPPLIER";

    order.shippingSnapshot.shipments[0]
      .courierCostPaise = 123;

    for (const filename of [
      "orderController.js",
      "razorpayController.js",
    ]) {
      const serialize = internals(
        filename,
        "safeOrder",
      ).safeOrder;

      const response = serialize(order);
      const json = JSON.stringify(response);

      assert.equal(
        response.items[0].priceAllocation.linePaidPaise,
        26999,
      );

      assert.equal(
        response.kitSnapshots[0].name,
        "Beginner kit",
      );

      assert.equal(
        response.shippingSnapshot.packageCount,
        2,
      );

      for (const value of [
        "meesho",
        "sourcing",
        "purchaseCost",
        "PRIVATE",
        "supplierContact",
        "courierCostPaise",
      ]) {
        assert.equal(
          json.includes(value),
          false,
        );
      }
    }

    assert.equal(
      publicKitItemFields(order.items[0])
        .priceAllocation.linePaidPaise,
      26999,
    );

    assert.equal(
      publicKitOrderFields(order)
        .shippingSnapshot.packageCount,
      2,
    );
  },
);

test(
  "kit snapshot preparation ignores browser snapshot and uses backend pricing and sourcing",
  async () => {
    const quote = review();

    const dbProduct = {
      _id: id,
      meeshoProductLink:
        "https://meesho.com/original/p/a",
    };

    const prepare = internals(
      "razorpayController.js",
      "snapshot,quote",
      {
        "../../utils/checkoutReview": {
          loadCheckoutReview: async (body) => {
            assert.equal(body.pincode, "682001");

            return {
              quote,

              products: [
                dbProduct,
                { _id: other },
              ],
            };
          },
        },
      },
    );

    const result = await prepare.snapshot({
      items: [
        {
          id,
          kitGroup: {
            id: "kit-group-1",
          },
        },
      ],

      shippingAddress: purchase().shippingAddress,
      expectedTotal: 569.06,

      expectedReviewKey:
        require("../utils/kitReviewKey").kitReviewKey(
          quote,
          "682001",
        ),

      shippingSnapshot: {
        shippingPaise: 0,
      },

      sourcing: "forged",
    });

    assert.equal(
      result.shippingSnapshot.shippingPaise,
      9910,
    );

    assert.equal(
      result.items[0].sourcing.meeshoProductLink,
      dbProduct.meeshoProductLink,
    );

    assert.equal(
      result.items[0].priceAllocation.linePaidPaise,
      26999,
    );

    await assert.rejects(
      prepare.snapshot({
        items: [
          {
            id,
            kitGroup: {},
          },
        ],

        shippingAddress: purchase().shippingAddress,
        expectedTotal: 1,
      }),
      (error) =>
        error.code === "CHECKOUT_TOTAL_CHANGED",
    );
  },
);

test(
  "retry fingerprints detect component grouping and shipping changes but ignore audit timestamps and source-link edits",
  () => {
    const fingerprint = internals(
      "razorpayController.js",
      "quote",
    ).quote;

    const first = withShipping();
    const later = structuredClone(first);

    later.shippingSnapshot.reviewedAt = new Date();

    later.shippingSnapshot.validUntil = new Date(
      Date.now() + 86400000 * 2,
    );

    later.items[0].sourcing = {
      meeshoProductLink: "private changed",
    };

    assert.equal(
      fingerprint(first),
      fingerprint(later),
    );

    later.shippingSnapshot.shipments[0].carrier =
      "Changed courier";

    assert.notEqual(
      fingerprint(first),
      fingerprint(later),
    );

    later.shippingSnapshot = first.shippingSnapshot;
    later.items[0].kit.slotKey = "other";

    assert.notEqual(
      fingerprint(first),
      fingerprint(later),
    );
  },
);

test(
  "kit payment endpoint forwards selections to backend validation and rejects purchased snapshots",
  () => {
    let delegated = 0;

    const { createRazorpayOrder } = internals(
      "paymentController.js",
      "createRazorpayOrder",
      {
        "./razorpayController": {
          createRazorpayOrder() {
            delegated += 1;
          },
        },
      },
    );

    const res = {
      statusCode: 200,

      set() {},

      status(value) {
        this.statusCode = value;
        return this;
      },

      json(value) {
        this.data = value;
        return this;
      },
    };

    createRazorpayOrder(
      {
        body: {
          items: [
            {
              id,
              kitGroup: {
                id: "kit-group-1",
              },
            },
          ],
        },
      },
      res,
    );

    assert.equal(delegated, 1);

    createRazorpayOrder(
      {
        body: {
          items: [
            {
              id,
              kit: {},
            },
          ],
        },
      },
      res,
    );

    assert.equal(delegated, 1);
    assert.equal(res.statusCode, 400);
    assert.equal(res.data.code, "INVALID_CHECKOUT");
  },
);

test(
  "kit purchase rejects incomplete shipping and missing or stale review keys at the purchase boundary",
  async () => {
    const quote = review();

    const { snapshot } = internals(
      "razorpayController.js",
      "snapshot",
      {
        "../../utils/checkoutReview": {
          loadCheckoutReview: async () => ({
            quote,
            products: [],
          }),
        },
      },
    );

    const body = {
      items: [
        {
          id,
          kitGroup: {
            id: "kit-group-1",
          },
        },
      ],

      shippingAddress: purchase().shippingAddress,
    };

    for (const expectedReviewKey of [
      undefined,
      "0".repeat(64),
    ]) {
      await assert.rejects(
        snapshot({
          ...body,
          expectedReviewKey,
        }),
        (error) =>
          error.code === "CHECKOUT_REVIEW_CHANGED",
      );
    }

    quote.shippingReview.ready = false;

    await assert.rejects(snapshot(body));
  },
);