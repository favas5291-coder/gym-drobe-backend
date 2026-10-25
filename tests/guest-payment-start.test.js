"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  createRequire,
} = require("node:module");

const productId = "507f1f77bcf86cd799439011";
const guestId = "507f1f77bcf86cd799439012";
const accountId = "507f1f77bcf86cd799439013";

const copy = (value) =>
  JSON.parse(JSON.stringify(value));

function checkout(paymentMethod = "razorpay") {
  return {
    checkoutToken: "guest-payment-regression",
    paymentMethod,
    deliveryMethod: "standard",
    expectedTotal: 1000,

    shippingAddress: {
      fullName: "Test Customer",
      email: "guest@example.test",
      phone: "9876543210",
      addressLine: "12 Workout Street",
      city: "Kozhikode",
      state: "Kerala",
      pincode: "673001",
    },

    items: [
      {
        id: productId,
        quantity: 1,
        selectedSize: "M",
        selectedColor: "Black",
      },
    ],
  };
}

function application({
  gatewayChanges = {},
  history = [],
  providerFailure = false,
} = {}) {
  const controllerPath = path.resolve(
    __dirname,
    "../middleware/controllers/razorpayController.js"
  );

  const filename =
    process.env.GYMDROBE_RAZORPAY_TEST_SOURCE ||
    controllerPath;

  const realRequire =
    createRequire(controllerPath);

  const orders = new Map();
  const attempts = new Map();
  const gatewayOrders = new Map();
  const calls = [];

  let clock = 0;
  let sequence = 0;

  const product = {
    _id: productId,
    name: "Training T-shirt",
    slug: "training-shirt",
    price: 1000,
    discount: 0,
    stock: 5,
    isActive: true,
    sizes: ["M"],
    colors: ["Black"],

    variants: {
      Black: {
        M: 5,
      },
    },

    delivery: {
      available: true,
    },
  };

  const byOwner = (filter) =>
    [...orders.values()].find(
      (row) =>
        row.checkoutToken ===
          filter.checkoutToken &&
        String(row.user || "") ===
          String(filter.user || "") &&
        String(row.guestSession || "") ===
          String(filter.guestSession || "")
    ) || null;

  const Order = {
    async init() {},

    async findOne(filter) {
      return byOwner(filter);
    },

    async findById(id) {
      return orders.get(String(id)) || null;
    },

    async create(value) {
      if (byOwner(value)) {
        throw Object.assign(
          Error("Duplicate checkout"),
          { code: 11000 }
        );
      }

      const row = copy(value);

      row._id = String(++sequence).padStart(
        24,
        "0"
      );

      row.payment.verifiedAt = null;
      row.payment.razorpayOrderId = null;

      orders.set(row._id, row);

      return row;
    },

    async findOneAndUpdate(filter, update) {
      const row = orders.get(
        String(filter._id)
      );

      if (
        !row ||
        row.status !== "payment-pending" ||
        row.payment.verifiedAt
      ) {
        return null;
      }

      for (
        const [key, value] of Object.entries(
          update.$set || {}
        )
      ) {
        const [parent, child] =
          key.split(".");

        if (child) {
          row[parent][child] = value;
        } else {
          row[key] = value;
        }
      }

      return row;
    },
  };

  const PaymentAttempt = {
    async create(details) {
      if (
        attempts.has(String(details._id))
      ) {
        throw Object.assign(
          Error("Duplicate attempt"),
          { code: 11000 }
        );
      }

      const value = {
        ...details,
        state: "creating",
        createdAt: new Date(),
      };

      attempts.set(
        String(value._id),
        value
      );

      return value;
    },

    async findById(id) {
      return attempts.get(String(id)) || null;
    },

    async findOneAndUpdate(filter, update) {
      const value = attempts.get(
        String(filter._id)
      );

      if (
        !value ||
        value.keyId !== filter.keyId
      ) {
        return null;
      }

      Object.assign(
        value,
        update.$set
      );

      return value;
    },

    async updateOne(filter, update) {
      const value = attempts.get(
        String(filter._id)
      );

      if (
        value &&
        value.state === filter.state
      ) {
        Object.assign(
          value,
          update.$set
        );
      }
    },
  };

  const client = {
    orders: {
      async create(details) {
        calls.push("create");

        clock += 120;

        if (providerFailure) {
          throw Error(
            "Provider interrupted"
          );
        }

        const gateway = {
          id: `order_Test${gatewayOrders.size + 1}`,
          entity: "order",
          ...copy(details),
          status: "created",
          attempts: 0,
          amount_paid: 0,
          amount_due: details.amount,
          ...gatewayChanges,
        };

        gatewayOrders.set(
          gateway.id,
          gateway
        );

        return gateway;
      },

      async fetch(id) {
        calls.push("fetch-order");

        clock += 40;

        return gatewayOrders.get(id);
      },

      async all({ receipt }) {
        calls.push("recover");

        clock += 60;

        return {
          items: [
            ...gatewayOrders.values(),
          ].filter(
            (row) =>
              row.receipt === receipt
          ),
        };
      },

      async fetchPayments() {
        calls.push("history");

        clock += 80;

        return {
          items: history,
        };
      },
    },

    payments: {
      async fetch(id) {
        calls.push("fetch-payment");

        clock += 50;

        return history.find(
          (row) => row.id === id
        );
      },
    },
  };

  const query = (value) => ({
    select() {
      return this;
    },

    then(resolve, reject) {
      return Promise.resolve(value).then(
        resolve,
        reject
      );
    },
  });

  const overrides = {
    "../../utils/checkoutShipping":
      require(
        "./helpers/checkoutShipping.cjs"
      ).shippingWithRecord(),

    "../../models/Order": Order,

    "../../models/Product": {
      findById: () =>
        query(copy(product)),

      findOne: () =>
        query(null),
    },

    "../../models/PaymentAttempt":
      PaymentAttempt,

    "../../config/razorpay": {
      getRazorpayClient: () => client,

      getRazorpayKeyId: () =>
        "rzp_test_Regression",
    },

    "node:perf_hooks": {
      performance: {
        now: () => clock,
      },
    },
  };

  const module = {
    exports: {},
  };

  vm.runInNewContext(
    fs.readFileSync(
      filename,
      "utf8"
    ),
    {
      module,
      exports: module.exports,

      require: (name) =>
        overrides[name] ||
        realRequire(name),

      process: {
        env: {
          RAZORPAY_KEY_SECRET:
            "regression-secret",
        },
      },

      console: {
        error() {},
      },

      Buffer,
      setTimeout,
      clearTimeout,
    },
    {
      filename,
    }
  );

  function response() {
    return {
      statusCode: 200,
      headers: {},
      headersSent: false,

      set(key, value) {
        this.headers[key] = value;
        return this;
      },

      status(value) {
        this.statusCode = value;
        return this;
      },

      json(value) {
        this.data = value;
        this.headersSent = true;
        return this;
      },
    };
  }

  return {
    orders,
    attempts,
    calls,
    product,
    gatewayOrders,
    history,

    get clock() {
      return clock;
    },

    async create(
      body = checkout(),
      account = false
    ) {
      const res = response();

      const req = {
        body,

        ...(account
          ? {
              user: {
                _id: accountId,
              },
            }
          : {
              guestSession: {
                _id: guestId,
              },
            }),
      };

      await module.exports.createRazorpayOrder(
        req,
        res
      );

      return res;
    },

    async verify(body) {
      const res = response();

      await module.exports.verifyRazorpayPayment(
        {
          body,

          guestSession: {
            _id: guestId,
          },
        },
        res
      );

      return res;
    },
  };
}

test(
  "a new guest order needs one provider request while retaining exact full and COD advance amounts",
  async () => {
    for (const method of [
      "razorpay",
      "cod-partial",
    ]) {
      const app = application();

      const result = await app.create(
        checkout(method)
      );

      assert.equal(
        result.statusCode,
        200
      );

      assert.equal(
        result.data.success,
        true
      );

      assert.equal(
        result.data.amount,
        method === "cod-partial"
          ? 10000
          : 100000
      );

      assert.deepEqual(
        app.calls,
        ["create"]
      );

      assert.equal(
        app.clock,
        120,
        "Synthetic provider time is 120ms; the old path also spent 80ms reading empty history"
      );

      assert.equal(
        app.orders.size,
        1
      );

      assert.equal(
        app.attempts.size,
        1
      );

      assert.equal(
        [...app.orders.values()][0]
          .metadata.inventoryReserved,
        false
      );

      assert.equal(
        app.product.variants.Black.M,
        5,
        "Stock is not deducted during payment setup"
      );
    }
  }
);

test(
  "the new-order shortcut also preserves signed-in checkout",
  async () => {
    const app = application();

    const result = await app.create(
      checkout(),
      true
    );

    assert.equal(
      result.statusCode,
      200
    );

    assert.equal(
      [...app.orders.values()][0].user,
      accountId
    );

    assert.deepEqual(
      app.calls,
      ["create"]
    );
  }
);

test(
  "new provider orders with missing or nonzero attempt/payment evidence still require history",
  async () => {
    for (const gatewayChanges of [
      {
        status: "attempted",
      },
      {
        attempts: 1,
      },
      {
        amount_paid: 100,
      },
      {
        amount_due: 99900,
      },
      {
        attempts: undefined,
      },
      {
        amount_paid: undefined,
      },
    ]) {
      const app = application({
        gatewayChanges,
      });

      const result = await app.create();

      assert.equal(
        result.statusCode,
        200
      );

      assert.deepEqual(
        app.calls,
        ["create", "history"]
      );
    }
  }
);

test(
  "payment cancellation and retry reuse the same checkout/provider order and still reconcile",
  async () => {
    const app = application();

    const first = await app.create();
    const retry = await app.create();

    assert.equal(
      retry.statusCode,
      200
    );

    assert.equal(
      retry.data.orderNumber,
      first.data.orderNumber
    );

    assert.equal(
      retry.data.razorpayOrderId,
      first.data.razorpayOrderId
    );

    assert.deepEqual(
      app.calls,
      ["create", "history"]
    );

    assert.equal(
      app.orders.size,
      1
    );

    assert.equal(
      app.attempts.size,
      1
    );
  }
);

test(
  "an authorized payment blocks another payment window on the same attempt",
  async () => {
    const app = application();

    await app.create();

    app.history.push({
      id: "pay_Authorized",
      status: "authorized",
    });

    const retry = await app.create();

    assert.equal(
      retry.statusCode,
      409
    );

    assert.equal(
      retry.data.code,
      "PAYMENT_CONFIRMATION_PENDING"
    );

    assert.equal(
      retry.data.verificationUncertain,
      true
    );

    assert.equal(
      app.calls.filter(
        (name) => name === "create"
      ).length,
      1
    );
  }
);

test(
  "a recovered provider order always checks for pending authorization",
  async () => {
    const app = application();

    await app.create();

    const order = [
      ...app.orders.values(),
    ][0];

    const attempt = [
      ...app.attempts.values(),
    ][0];

    order.payment.razorpayOrderId = null;
    attempt.state = "uncertain";

    app.history.push({
      id: "pay_Authorized",
      status: "authorized",
    });

    const retry = await app.create();

    assert.equal(
      retry.statusCode,
      409
    );

    assert.equal(
      retry.data.code,
      "PAYMENT_CONFIRMATION_PENDING"
    );

    assert.deepEqual(
      app.calls,
      [
        "create",
        "recover",
        "history",
      ]
    );
  }
);

test(
  "an already-ready attempt whose order binding was interrupted is reconciled before reuse",
  async () => {
    const app = application();

    await app.create();

    [...app.orders.values()][0]
      .payment.razorpayOrderId = null;

    const retry = await app.create();

    assert.equal(
      retry.statusCode,
      200
    );

    assert.deepEqual(
      app.calls,
      [
        "create",
        "fetch-order",
        "history",
      ]
    );
  }
);

test(
  "changed prices, required variants and stock are validated before calling the provider",
  async () => {
    for (const mutate of [
      (app, body) => {
        body.expectedTotal = 1;
      },

      (app, body) => {
        body.items[0].selectedSize = null;
      },

      (app) => {
        app.product.variants.Black.M = 0;
      },
    ]) {
      const app = application();
      const body = checkout();

      mutate(app, body);

      const result = await app.create(body);

      assert.equal(
        result.data.success,
        false
      );

      assert.ok(
        [400, 409].includes(
          result.statusCode
        )
      );

      assert.deepEqual(
        app.calls,
        []
      );

      assert.equal(
        app.orders.size,
        0
      );
    }
  }
);

test(
  "concurrent duplicate requests cannot create another provider order",
  async () => {
    const app = application();

    const results = await Promise.all([
      app.create(),
      app.create(),
    ]);

    assert.ok(
      results.some(
        (res) => res.data.success
      )
    );

    assert.equal(
      app.orders.size,
      1
    );

    assert.equal(
      app.attempts.size,
      1
    );

    assert.equal(
      app.calls.filter(
        (name) => name === "create"
      ).length,
      1
    );

    for (const res of results) {
      assert.ok(
        res.data.success ||
          [
            "PAYMENT_STARTING",
            "PAYMENT_SETUP_CHANGED",
          ].includes(res.data.code)
      );
    }
  }
);

test(
  "uncertain provider creation is recovered, never submitted as another new order",
  async () => {
    const app = application({
      providerFailure: true,
    });

    const first = await app.create();

    assert.equal(
      first.data.success,
      false
    );

    assert.equal(
      [...app.attempts.values()][0].state,
      "uncertain"
    );

    const retry = await app.create();

    assert.equal(
      retry.data.code,
      "PAYMENT_SETUP_UNCERTAIN"
    );

    assert.deepEqual(
      app.calls,
      ["create", "recover"]
    );
  }
);

test(
  "payment timing separates provider and checkout work without customer details",
  async () => {
    const app = application();

    const result = await app.create();

    const timing =
      result.headers["Server-Timing"];

    assert.match(
      timing,
      /razorpay_order_create;dur=120\.00/
    );

    assert.match(
      timing,
      /checkout_review;dur=/
    );

    assert.match(
      timing,
      /order_save;dur=/
    );

    assert.doesNotMatch(
      timing,
      /guest|customer|@|673001|GD-|order_Test|rzp_/
    );
  }
);

test(
  "invalid signatures still fail before any provider fetch",
  async () => {
    const app = application();

    const result = await app.create();

    const verified = await app.verify({
      checkoutToken:
        checkout().checkoutToken,

      razorpay_order_id:
        result.data.razorpayOrderId,

      razorpay_payment_id:
        "pay_Test1",

      razorpay_signature:
        "0".repeat(64),
    });

    assert.equal(
      verified.statusCode,
      400
    );

    assert.equal(
      verified.data.code,
      "PAYMENT_SIGNATURE_INVALID"
    );

    assert.deepEqual(
      app.calls,
      ["create"]
    );
  }
);