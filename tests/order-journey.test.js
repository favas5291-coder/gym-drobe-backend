"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildKitCheckoutPricing,
} = require("../utils/kitCheckoutPricing");

const {
  checkoutDelivery,
} = require("../utils/checkoutDelivery");

const {
  snapshotPurchasedShipping,
  validatePurchasedShipping,
} = require("../utils/purchasedShipping");

const {
  calculateItemRefundPaise,
} = require("../utils/orderRefundAllocation");

const {
  applyKitFulfillmentAction,
  progressStage,
  validateKitProgress,
} = require("../utils/kitFulfillmentProgress");

const {
  publicKitFulfillmentFields,
} = require("../utils/publicKitOrder");

const admin = "507f1f77bcf86cd799439019";

const now = () =>
  new Date(Date.now() - 1000);

function purchase() {
  const items = [100, 200].map(
    (price, index) => ({
      product:
        `507f1f77bcf86cd79943901${index + 1}`,

      name: index
        ? "Fixture bottle"
        : "Fixture shirt",

      price,
      quantity: 1,
      selectedSize: null,
      selectedColor: null,

      kit: {
        groupId: "fixture-kit",
        slotKey: index
          ? "bottle"
          : "clothing",
      },

      priceAllocation: {
        quantity: 1,
        lineSubtotalPaise: price * 100,
        kitDiscountPaise: price * 10,
        couponDiscountPaise: 0,
        linePaidPaise: price * 90,
        unitBasePaise: price * 90,
        extraPaiseUnits: 0,
      },
    }),
  );

  const quote = {
    items,

    kitSnapshots: [
      {
        groupId: "fixture-kit",
        fulfillmentMode:
          "separate-shipments",
      },
    ],

    pricing: {
      subtotal: 300,
      kitDiscount: 30,
      couponDiscount: 0,
      totalAfterCoupon: 270,
      shipping: 100,
      finalTotal: 370,
    },

    payment: {
      method: "cod-partial",
      amountToPayNow: 27,
      amountDue: 343,
    },

    shippingIsEstimate: false,

    shippingReview: {
      ready: true,
      shippingPaise: 10000,
      packageCount: 2,

      validUntil: new Date(
        Date.now() + 600000,
      ).toISOString(),

      shipments: items.map(
        (item, index) => ({
          key: `parcel-${index + 1}`,
          groupId: "fixture-kit",
          label: `Package ${index + 1}`,
          carrier: "Fixture courier",
          service: "Standard",

          contents: [
            {
              itemIndex: index,
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

          shipping: 50,

          amountDueOnDelivery:
            index ? 212 : 131,
        }),
      ),
    },
  };

  return {
    ...quote,
    status: "confirmed",

    shippingAddress: {
      pincode: "673001",
    },

    shippingSnapshot:
      snapshotPurchasedShipping(
        quote,
        "673001",
      ),

    payment: {
      ...quote.payment,
      status: "partially-paid",
      amountPaid: 27,
      grossCollected: 27,
      refundedAmount: 0,
      totalAmount: 370,
      verifiedAt: now(),
      razorpayPaymentId: "pay_fixture",
    },

    metadata: {
      inventoryReserved: true,
    },

    delivery: {},
  };
}

function act(order, input) {
  const result =
    applyKitFulfillmentAction(
      order,

      {
        revision:
          order.fulfillmentProgress
            ?.revision || 0,

        ...input,
      },

      admin,
      now(),
    );

  return {
    ...order,
    status: result.status,
    payment: result.payment,
    delivery: result.delivery,
    fulfillmentProgress: result.progress,
  };
}

function received() {
  let order = act(
    purchase(),
    { action: "initialize" },
  );

  for (
    let itemIndex = 0;
    itemIndex < 2;
    itemIndex++
  ) {
    order = act(order, {
      action: "component",
      itemIndex,
      receivedQuantity: 1,

      supplierReference:
        "private-supplier-reference",

      notes: "Internal procurement note",
    });
  }

  return order;
}

function outForDelivery(order, key) {
  order = act(order, {
    action: "parcel",
    key,
    status: "packed",
    packingChecked: true,
  });

  order = act(order, {
    action: "parcel",
    key,
    status: "shipped",
    carrier: "Fixture courier",
    trackingNumber: `TRACK-${key}`,
  });

  return act(order, {
    action: "parcel",
    key,
    status: "out-for-delivery",
  });
}

test(
  "empty or missing package progress never claims delivery",
  () => {
    assert.equal(
      progressStage({}),
      "awaiting-setup",
    );

    assert.equal(
      progressStage({
        fulfillmentProgress: {
          parcels: [],
        },
      }),
      "awaiting-setup",
    );

    assert.equal(
      progressStage({
        fulfillmentProgress: {},
      }),
      "awaiting-setup",
    );

    assert.equal(
      progressStage({
        shippingSnapshot: {
          shipments: [
            { key: "one" },
            { key: "two" },
          ],
        },

        fulfillmentProgress: {
          parcels: [
            {
              key: "one",
              status: "delivered",
            },
          ],
        },
      }),
      "awaiting-setup",
    );
  },
);

test(
  "kit procurement and dispatch require received components and confirmed packing",
  () => {
    const initial = act(
      purchase(),
      { action: "initialize" },
    );

    assert.throws(
      () =>
        act(initial, {
          action: "parcel",
          key: "parcel-1",
          status: "shipped",
        }),
      /in order/,
    );

    assert.throws(
      () =>
        act(initial, {
          action: "parcel",
          key: "parcel-1",
          status: "packed",
          packingChecked: true,
        }),
      /received component/,
    );

    const order = received();

    assert.throws(
      () =>
        act(order, {
          action: "parcel",
          key: "parcel-1",
          status: "packed",
        }),
      /checked/,
    );

    assert.throws(
      () =>
        act(order, {
          action: "parcel",
          key: "parcel-1",
          status: "packed",
          packingChecked: true,
          revision: 0,
        }),
      /Reload|changed/,
    );
  },
);

test(
  "one delivered parcel cannot mark the complete kit delivered or collect the other balance",
  () => {
    let order = outForDelivery(
      received(),
      "parcel-1",
    );

    order = act(order, {
      action: "cod",
      key: "parcel-1",
      collectionConfirmed: true,
      collectionReference:
        "actual-collection-1",
    });

    assert.equal(
      order.payment.amountPaid,
      158,
    );

    assert.equal(
      order.payment.amountDue,
      212,
    );

    assert.throws(
      () =>
        act(order, {
          action: "cod",
          key: "parcel-1",
          collectionConfirmed: true,
          collectionReference: "duplicate",
        }),
      /once/,
    );

    order = act(order, {
      action: "parcel",
      key: "parcel-1",
      status: "delivered",
    });

    assert.notEqual(
      order.status,
      "delivered",
    );

    assert.notEqual(
      progressStage(order),
      "delivered",
    );

    assert.equal(
      order.payment.status,
      "partially-paid",
    );

    order = outForDelivery(
      order,
      "parcel-2",
    );

    assert.throws(
      () =>
        act(order, {
          action: "parcel",
          key: "parcel-2",
          status: "delivered",
        }),
      /COD balance/,
    );

    order = act(order, {
      action: "cod",
      key: "parcel-2",
      collectionConfirmed: true,
      collectionReference:
        "actual-collection-2",
    });

    order = act(order, {
      action: "parcel",
      key: "parcel-2",
      status: "delivered",
    });

    assert.equal(
      order.status,
      "delivered",
    );

    assert.equal(
      order.payment.amountPaid,
      370,
    );

    assert.equal(
      order.payment.amountDue,
      0,
    );

    assert.equal(
      order.payment.status,
      "paid",
    );

    assert.doesNotThrow(
      () => validateKitProgress(order),
    );
  },
);

test(
  "pending payments and active refunds cannot unlock kit fulfillment",
  () => {
    const blockedOrders = [
      {
        ...purchase(),
        status: "payment-pending",
      },

      {
        ...purchase(),

        metadata: {
          inventoryReserved: false,
        },
      },

      {
        ...purchase(),

        refund: {
          status: "pending",
        },
      },
    ];

    for (const order of blockedOrders) {
      assert.throws(
        () =>
          act(order, {
            action: "initialize",
          }),
        /verified payment|refund/,
      );
    }
  },
);

test(
  "kit snapshots allocate every purchased unit, fee and COD balance exactly once",
  () => {
    const order = purchase();

    assert.doesNotThrow(
      () =>
        validatePurchasedShipping(order),
    );

    const changed =
      structuredClone(order);

    changed.shippingSnapshot
      .shipments[0]
      .amountDuePaise++;

    assert.throws(
      () =>
        validatePurchasedShipping(changed),
      /COD|allocate/,
    );

    changed.shippingSnapshot =
      structuredClone(
        order.shippingSnapshot,
      );

    changed.shippingSnapshot
      .shipments[1]
      .contents[0]
      .itemIndex = 0;

    assert.throws(
      () =>
        validatePurchasedShipping(changed),
      /contents/,
    );
  },
);

test(
  "component refunds use purchased discounts and exclude delivery fees",
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
        [{ index: 1, quantity: 1 }],
      ),
      18000,
    );

    assert.equal(
      calculateItemRefundPaise(
        order,

        [
          { index: 0, quantity: 1 },
          { index: 1, quantity: 1 },
        ],
      ),
      27000,
    );

    assert.throws(
      () =>
        calculateItemRefundPaise(
          order,
          [{ index: 0, quantity: 2 }],
        ),
      /exceeds/,
    );
  },
);

test(
  "partial component refunds do not return the same rounding paise twice",
  () => {
    const order = {
      items: [
        {
          price: 100,
          quantity: 3,

          kit: {
            groupId: "fixture-kit",
          },

          priceAllocation: {
            quantity: 3,
            lineSubtotalPaise: 30000,
            kitDiscountPaise: 2,
            couponDiscountPaise: 0,
            linePaidPaise: 29998,
            unitBasePaise: 9999,
            extraPaiseUnits: 1,
          },
        },
      ],

      pricing: {
        subtotal: 300,
        kitDiscount: 0.02,
        couponDiscount: 0,
        totalAfterCoupon: 299.98,
      },
    };

    const amounts = [0, 1, 2].map(
      (refundedUnitsBefore) =>
        calculateItemRefundPaise(
          order,

          [
            {
              index: 0,
              quantity: 1,
              refundedUnitsBefore,
            },
          ],
        ),
    );

    assert.deepEqual(
      amounts,
      [10000, 9999, 9999],
    );

    assert.equal(
      amounts.reduce(
        (a, b) => a + b,
      ),
      29998,
    );
  },
);

test(
  "customer kit progress omits internal procurement and collection references",
  () => {
    const order = received();

    const text = JSON.stringify(
      publicKitFulfillmentFields(order),
    );

    assert.equal(
      text.includes(
        "private-supplier-reference",
      ),
      false,
    );

    assert.equal(
      text.includes(
        "Internal procurement note",
      ),
      false,
    );

    assert.equal(
      text.includes("supplierReference"),
      false,
    );
  },
);

test(
  "server checkout uses database prices, stock and images rather than client claims",
  () => {
    const product = {
      _id: "507f1f77bcf86cd799439011",
      name: "Fixture shirt",
      price: 500,
      discount: 0,
      stock: 2,
      image: "/default.jpg",
      sizes: ["M"],
      colors: ["Blue"],

      variants: {
        Blue: {
          M: 2,
        },
      },

      colorImages: [
        {
          color: "Blue",
          images: ["/blue.jpg"],
        },
      ],

      meeshoProductLink:
        "https://secret-supplier.example/private",

      isActive: true,
    };

    const selected = {
      id: product._id,
      quantity: 1,
      selectedSize: "M",
      selectedColor: "Blue",
      price: 1,

      meeshoProductLink:
        "https://customer.invalid/forged",
    };

    const result =
      buildKitCheckoutPricing({
        items: [selected],
        products: [product],
        kits: [],
      });

    assert.equal(
      result.items[0].price,
      500,
    );

    assert.equal(
      result.items[0].image,
      "/blue.jpg",
    );

    assert.equal(
      JSON.stringify(result).includes(
        "secret-supplier",
      ),
      false,
    );

    assert.equal(
      JSON.stringify(result).includes(
        "customer.invalid",
      ),
      false,
    );

    assert.throws(
      () =>
        buildKitCheckoutPricing({
          items: [
            {
              ...selected,
              quantity: 3,
            },
          ],

          products: [product],
          kits: [],
        }),
      /available|stock/,
    );

    const delivery = checkoutDelivery(
      [product],
      result.items,
      "673001",
    );

    assert.equal(
      delivery.ready,
      true,
    );

    assert.equal(
      delivery.courierCoverageConfirmed,
      false,
    );

    assert.equal(
      delivery.estimatedDays,
      null,
    );
  },
);