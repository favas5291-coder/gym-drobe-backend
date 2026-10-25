const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildKitShippingQuote,
} = require("../utils/kitShipping");

const now = Date.parse("2026-10-14T12:00:00Z");

const p1 = "507f1f77bcf86cd799439011";
const p2 = "507f1f77bcf86cd799439012";
const kitId = "507f1f77bcf86cd799439013";
const locationId = "507f1f77bcf86cd799439014";
const verifier = "507f1f77bcf86cd799439015";

const confirmedAt = new Date(now - 86400000);
const validUntil = new Date(now + 86400000);

const copy = (value) => structuredClone(value);

function fixture(cod = false) {
  const items = [
    {
      product: p1,
      name: "Shirt",
      quantity: 2,
      selectedSize: "M",
      selectedColor: "Black",

      kit: {
        groupId: "kit-group-1",
        slotKey: "clothing",
      },

      priceAllocation: {
        quantity: 2,
        unitBasePaise: 5000,
        extraPaiseUnits: 1,
        linePaidPaise: 10001,
      },
    },

    {
      product: p2,
      name: "Shaker",
      quantity: 1,
      selectedSize: null,
      selectedColor: null,

      kit: {
        groupId: "kit-group-1",
        slotKey: "bottle-or-shaker",
      },

      priceAllocation: {
        quantity: 1,
        unitBasePaise: 10000,
        extraPaiseUnits: 0,
        linePaidPaise: 10000,
      },
    },
  ];

  const origin = {
    kind: "packing-location",
    name: "Confirmed packing partner",
    packingLocation: locationId,
    pickupPincode: "682001",
  };

  const plan = {
    _id: "507f1f77bcf86cd799439016",
    status: "active",
    origin,

    verification: {
      confirmedAt,
      confirmedBy: verifier,
      validUntil,
      measurementReference: "Fixture measurements",
    },

    components: [
      {
        key: "shirt",
        product: p1,
        selectedSize: "M",
        selectedColor: "Black",
        quantity: 2,
      },

      {
        key: "shaker",
        product: p2,
        quantity: 1,
      },
    ],

    parcels: [
      {
        key: "parcel-one",
        label: "Your kit",
        weightGrams: 1200,
        lengthMm: 350,
        widthMm: 250,
        heightMm: 100,

        contents: [
          {
            componentKey: "shirt",
            quantity: 2,
          },

          {
            componentKey: "shaker",
            quantity: 1,
          },
        ],
      },
    ],

    notes: "PRIVATE PLAN NOTE",
  };

  const profile = {
    _id: "507f1f77bcf86cd799439017",
    status: "active",

    origin: {
      ...origin,
    },

    verification: {
      confirmedAt,
      confirmedBy: verifier,
      validUntil,
      arrangementReference: "PRIVATE RATE REFERENCE",
    },

    productIds: [p1, p2],
    destinationPincodes: ["682001"],

    service: {
      carrier: "Fixture courier",
      name: "Verified standard service",
      deliveryMethod: "standard",
      supportsOnline: true,
      supportsCodAdvance: true,
      maximumCodBalancePaise: 1000000,
      transitDaysMin: 2,
      transitDaysMax: 4,
    },

    parcelLimits: {
      maximumWeightGrams: 2000,
      maximumLengthMm: 400,
      maximumWidthMm: 300,
      maximumHeightMm: 200,
      maximumUnits: 3,
    },

    charges: {
      shippingPaise: 9900,
      codFeePaise: 1500,
      courierCostPaise: 7000,
    },

    notes: "PRIVATE SHIPPING NOTE",
  };

  return {
    now,
    pincode: "682001",
    plans: [plan],
    profiles: [profile],

    products: [
      { _id: p1 },
      { _id: p2 },
    ],

    kits: [
      {
        _id: kitId,

        fulfillment: {
          mode: "packed-together",
          packingLocation: locationId,
        },
      },
    ],

    quote: {
      items,

      kitSnapshots: [
        {
          groupId: "kit-group-1",
          template: kitId,
        },
      ],

      method: "standard",

      pricing: {
        totalAfterCoupon: 200.01,
      },

      payment: {
        method: cod ? "cod-partial" : "razorpay",
      },

      fulfillment: {
        configurationReady: true,

        groups: [
          {
            groupId: "kit-group-1",

            estimates: {
              preparationDays: {
                minimum: 2,
                maximum: 4,
              },
            },

            components: items.map((item) => ({
              productId: item.product,
              selectedSize: item.selectedSize,
              selectedColor: item.selectedColor,

              preparationDays: {
                minimum: 1,
                maximum: 2,
              },
            })),
          },
        ],
      },
    },
  };
}

function separate() {
  const data = fixture(true);

  data.quote.kitSnapshots = [];
  data.kits = [];

  data.quote.items.forEach((item) => {
    item.kit = null;
  });

  data.products.forEach((product) => {
    product.fulfillment = {
      dispatchBy: "gymdrobe",
    };
  });

  data.plans[0].origin = {
    kind: "gymdrobe",
    name: "Verified warehouse",
    pickupPincode: "682001",
  };

  data.profiles[0].origin = {
    ...data.plans[0].origin,
  };

  const first = data.plans[0].parcels[0];

  data.plans[0].parcels = [
    {
      ...first,
      key: "parcel-one",

      contents: [
        {
          componentKey: "shirt",
          quantity: 1,
        },
      ],
    },

    {
      ...first,
      key: "parcel-two",

      contents: [
        {
          componentKey: "shirt",
          quantity: 1,
        },

        {
          componentKey: "shaker",
          quantity: 1,
        },
      ],
    },
  ];

  data.quote.fulfillment.groups[0].groupId = null;

  return data;
}

test(
  "packed kit confirms one measured parcel and real courier fee without inventory mutation",
  () => {
    const data = fixture();
    const before = copy(data);
    const result = buildKitShippingQuote(data);

    assert.equal(result.ready, true);
    assert.equal(result.packageCount, 1);
    assert.equal(result.shippingPaise, 9900);

    assert.equal(
      result.shipments[0].amountDueOnDelivery,
      0,
    );

    assert.equal(
      result.shipments[0].contents.reduce(
        (sum, row) => sum + row.quantity,
        0,
      ),
      3,
    );

    assert.deepEqual(
      result.shipments[0].estimatedDays,
      {
        minimum: 4,
        maximum: 8,
      },
    );

    assert.deepEqual(data, before);
  },
);

test(
  "COD advance is 10% of discounted merchandise and shipping/COD fees remain in balance",
  () => {
    const result = buildKitShippingQuote(fixture(true));

    assert.equal(result.shippingPaise, 11400);

    assert.equal(
      Math.round(
        result.shipments[0].amountDueOnDelivery * 100,
      ),
      20001 - 2000 + 11400,
    );
  },
);

test(
  "separate parcels disclose exact contents and allocate advance once across all packages",
  () => {
    const result = buildKitShippingQuote(separate());

    assert.equal(result.ready, true);
    assert.equal(result.packageCount, 2);
    assert.equal(result.shippingPaise, 22800);

    assert.equal(
      result.shipments.reduce(
        (sum, row) =>
          sum + Math.round(row.amountDueOnDelivery * 100),
        0,
      ),
      20001 - 2000 + 22800,
    );

    assert.equal(
      result.shipments
        .flatMap((row) => row.contents)
        .reduce(
          (sum, row) => sum + row.quantity,
          0,
        ),
      3,
    );
  },
);

test(
  "single-package kits reject plans containing multiple parcels",
  () => {
    const data = fixture();

    data.plans[0].parcels.push({
      ...data.plans[0].parcels[0],
      key: "extra",
    });

    assert.equal(
      buildKitShippingQuote(data).ready,
      false,
    );
  },
);

test(
  "missing pincode, supplier setup, plans and ambiguous plans cannot produce confirmed charges",
  () => {
    const cases = [
      (data) => {
        data.pincode = "";
      },

      (data) => {
        data.pincode = "000000";
      },

      (data) => {
        data.quote.fulfillment.configurationReady = false;
      },

      (data) => {
        data.plans = [];
      },

      (data) => {
        data.plans.push(copy(data.plans[0]));
      },
    ];

    for (const mutate of cases) {
      const data = fixture();

      mutate(data);

      const result = buildKitShippingQuote(data);

      assert.equal(result.ready, false);
      assert.equal(result.shippingPaise, null);
    }
  },
);

test(
  "plans must match sizes, colours and quantities exactly and allocate each unit once",
  () => {
    const cases = [
      (data) => {
        data.plans[0].components[0].selectedSize = "XL";
      },

      (data) => {
        data.plans[0].components[0].selectedColor = "Red";
      },

      (data) => {
        data.plans[0].components[0].quantity = 1;
      },

      (data) => {
        data.plans[0].parcels[0].contents[0].quantity = 3;
      },

      (data) => {
        data.plans[0].parcels[0].contents[0].quantity = 1;
      },
    ];

    for (const mutate of cases) {
      const data = fixture();

      mutate(data);

      assert.equal(
        buildKitShippingQuote(data).ready,
        false,
      );
    }
  },
);

test(
  "expired, future-confirmed and unverified records are rejected",
  () => {
    const cases = [
      (row) => {
        row.verification.validUntil = new Date(now);
      },

      (row) => {
        row.verification.confirmedAt = new Date(now + 1000);
      },

      (row) => {
        row.verification.confirmedBy = null;
      },

      (row) => {
        row.status = "paused";
      },
    ];

    for (const record of ["plans", "profiles"]) {
      for (const mutate of cases) {
        const data = fixture();

        mutate(data[record][0]);

        assert.equal(
          buildKitShippingQuote(data).ready,
          false,
        );
      }
    }
  },
);

test(
  "courier coverage, origin, payment capability and measured parcel limits are enforced",
  () => {
    const mutations = [
      (data) => {
        data.profiles[0].destinationPincodes = ["682002"];
      },

      (data) => {
        data.profiles[0].origin.pickupPincode = "682003";
      },

      (data) => {
        data.profiles[0].productIds = [p1];
      },

      (data) => {
        data.profiles[0].service.supportsOnline = false;
      },

      (data) => {
        data.profiles[0].service.deliveryMethod = "express";
      },

      (data) => {
        data.profiles[0].parcelLimits.maximumWeightGrams = 500;
      },

      (data) => {
        data.profiles[0].parcelLimits.maximumUnits = 2;
      },

      (data) => {
        data.profiles[0].parcelLimits.maximumWidthMm = 200;
      },
    ];

    for (const mutate of mutations) {
      const data = fixture();

      mutate(data);

      assert.equal(
        buildKitShippingQuote(data).ready,
        false,
      );
    }
  },
);

test(
  "COD capabilities and maximum collectible balance are enforced",
  () => {
    const cases = [
      (data) => {
        data.profiles[0].service.supportsCodAdvance = false;
      },

      (data) => {
        data.profiles[0].service.maximumCodBalancePaise = 29400;
      },
    ];

    for (const mutate of cases) {
      const data = fixture(true);

      mutate(data);

      assert.equal(
        buildKitShippingQuote(data).ready,
        false,
      );
    }

    const data = fixture(true);

    data.profiles[0].service.maximumCodBalancePaise = 29401;

    assert.equal(
      buildKitShippingQuote(data).ready,
      true,
    );
  },
);

test(
  "eligible courier profile with lowest complete customer fee is selected",
  () => {
    const data = fixture(true);
    const other = copy(data.profiles[0]);

    other._id = "507f1f77bcf86cd799439019";
    other.service.carrier = "Cheaper verified courier";
    other.charges.shippingPaise = 5000;
    other.charges.codFeePaise = 1000;

    data.profiles.push(other);

    const result = buildKitShippingQuote(data);

    assert.equal(result.ready, true);
    assert.equal(result.shippingPaise, 6000);

    assert.equal(
      result.shipments[0].carrier,
      "Cheaper verified courier",
    );
  },
);

test(
  "unknown or negative charges and unreconciled component payment allocations are blocked",
  () => {
    const cases = [
      (data) => {
        data.profiles[0].charges.shippingPaise = null;
      },

      (data) => {
        data.profiles[0].charges.shippingPaise = -1;
      },

      (data) => {
        data.quote.items[0].priceAllocation.linePaidPaise =
          10002;
      },

      (data) => {
        data.quote.pricing.totalAfterCoupon = 200.02;
      },
    ];

    for (const mutate of cases) {
      const data = fixture();

      mutate(data);

      assert.equal(
        buildKitShippingQuote(data).ready,
        false,
      );
    }

    const data = fixture();

    data.profiles[0].charges.shippingPaise = 0;

    assert.equal(
      buildKitShippingQuote(data).shippingPaise,
      0,
    );
  },
);

test(
  "customer shipping output excludes private records, costs, contacts and sourcing links",
  () => {
    const data = fixture();

    data.products[0].meeshoProductLink =
      "https://www.meesho.com/private/p/fixture";

    data.profiles[0].contact = {
      phone: "9999999999",
    };

    const result = buildKitShippingQuote(data);

    assert.equal(result.ready, true);

    const json = JSON.stringify(result);

    for (const privateValue of [
      "PRIVATE",
      "courierCostPaise",
      "9999999999",
      "meeshoProductLink",
      locationId,
      verifier,
    ]) {
      assert.equal(
        json.includes(privateValue),
        false,
      );
    }
  },
);

test(
  "checkout API uses DB prices, applies kit discount, confirms shipping and returns no private data",
  async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const vm = require("node:vm");
    const { createRequire } = require("node:module");

    const {
      kitDraft,
    } = require("../utils/kitDefinitions");

    const absolute = path.resolve(
      __dirname,
      "../middleware/controllers/paymentController.js",
    );

    const baseRequire = createRequire(absolute);

    const rawProduct = {
      _id: p1,
      name: "Fixture shirt",
      price: 100,
      discount: 0,
      isActive: true,

      delivery: {
        available: true,
      },

      stock: 5,
      sizes: ["M"],
      colors: ["Black"],

      variants: {
        Black: {
          M: 5,
        },
      },

      sku: "FIXTURE",

      kitSettings: {
        eligible: true,
        roles: ["clothing"],
      },

      meeshoProductLink:
        "https://meesho.com/private/p/a",

      purchaseCost: 60,
    };

    const kit = {
      ...kitDraft("beginner"),

      _id: kitId,
      __v: 0,
      status: "published",

      fulfillment: {
        mode: "packed-together",
        packingLocation: locationId,
      },

      discount: {
        type: "percentage",
        value: 10,
        minimumSubtotal: 0,
        minimumCategories: 1,
        requiredRoles: [],
        allowCouponStacking: true,
      },
    };

    kit.slots[0].allowedProducts = [p1];
    kit.slots[0].defaultProduct = p1;

    const configs = fixture(true);

    configs.plans[0].components = [
      configs.plans[0].components[0],
    ];

    configs.plans[0].parcels[0].contents = [
      {
        componentKey: "shirt",
        quantity: 2,
      },
    ];

    for (const record of [
      ...configs.plans,
      ...configs.profiles,
    ]) {
      record.verification.confirmedAt = new Date(
        Date.now() - 86400000,
      );

      record.verification.validUntil = new Date(
        Date.now() + 86400000,
      );
    }

    const selection = {
      id: p1,
      quantity: 2,
      selectedSize: "M",
      selectedColor: "Black",
      price: 1,
      shipping: 0,

      kitGroup: {
        id: "kit-group-1",
        kitId,
        version: 0,
        slotKey: "clothing",
      },
    };

    const observed = [];

    function model(data) {
      return {
        adminFields: "+private",

        find(filter) {
          observed.push(filter);

          return {
            select() {
              return this;
            },

            limit() {
              return this;
            },

            lean() {
              return this;
            },

            maxTimeMS() {
              return this;
            },

            then(resolve, reject) {
              return Promise.resolve(data).then(
                resolve,
                reject,
              );
            },
          };
        },
      };
    }

    const mocks = {
      "../models/Product": model([rawProduct]),
      "../models/KitTemplate": model([kit]),
      "../models/PackingLocation": model([]),
      "../models/Supplier": model([]),
      "../models/PackagePlan": model(configs.plans),
      "../models/ShippingProfile": model(configs.profiles),

      "./kitFulfillment": {
        inspectCheckoutFulfillment: () =>
          configs.quote.fulfillment,
      },
    };

    const helperPath = path.resolve(
      __dirname,
      "../utils/checkoutReview.js",
    );

    const helperModule = {
      exports: {},
    };

    const helperRequire = createRequire(helperPath);

    vm.runInNewContext(
      fs.readFileSync(helperPath, "utf8"),

      {
        require: (name) =>
          mocks[name] || helperRequire(name),

        module: helperModule,
        exports: helperModule.exports,
        console,
        Date,
        Buffer,
      },
    );

    const mockRequire = (name) =>
      name === "../../utils/checkoutReview"
        ? helperModule.exports
        : name === "./razorpayController"
          ? {
              createRazorpayOrder: () => {
                throw new Error(
                  "No payment should be started",
                );
              },
            }
          : baseRequire(name);

    const controllerModule = {
      exports: {},
    };

    vm.runInNewContext(
      fs.readFileSync(absolute, "utf8"),

      {
        require: mockRequire,
        module: controllerModule,
        exports: controllerModule.exports,
        console,
        Date,
        Buffer,
      },
    );

    let response;
    let status = 200;

    const res = {
      set() {
        return this;
      },

      status(code) {
        status = code;
        return this;
      },

      json(value) {
        response = value;
        return this;
      },
    };

    await controllerModule.exports.getCheckoutQuote(
      {
        user: {
          _id: verifier,
        },

        body: {
          items: [selection],
          paymentMethod: "cod-partial",
          pincode: "682001",
        },
      },
      res,
    );

    assert.equal(
      status,
      200,
      JSON.stringify(response),
    );

    assert.equal(response.success, true);

    assert.equal(
      response.quote.pricing.subtotal,
      200,
    );

    assert.equal(
      response.quote.pricing.kitDiscount,
      20,
    );

    assert.equal(
      response.quote.pricing.totalAfterCoupon,
      180,
    );

    assert.equal(
      response.quote.pricing.shipping,
      114,
    );

    assert.equal(
      response.quote.payment.amountToPayNow,
      18,
    );

    assert.equal(
      response.quote.payment.amountDue,
      276,
    );

    assert.equal(
      response.quote.shippingIsEstimate,
      false,
    );

    assert.equal(
      response.quote.purchaseEnabled,
      true,
    );

    assert.equal(
      response.quote.shippingReview.packageCount,
      1,
    );

    assert.equal(
      response.quote.fulfillment.finalShippingConfirmed,
      true,
    );

    assert.equal(
      rawProduct.variants.Black.M,
      5,
    );

    const json = JSON.stringify(response);

    for (const value of [
      "PRIVATE",
      "purchaseCost",
      "meeshoProductLink",
      "courierCostPaise",
    ]) {
      assert.equal(
        json.includes(value),
        false,
      );
    }

    response = null;

    await controllerModule.exports.getCheckoutQuote(
      {
        body: {
          items: [selection],
        },
      },
      res,
    );

    // Quotes are intentionally public and do not start a payment.
    // Missing confirmed package coverage keeps purchase disabled.
    assert.equal(status, 200);

    assert.equal(
      response.quote.purchaseEnabled,
      false,
    );
  },
);