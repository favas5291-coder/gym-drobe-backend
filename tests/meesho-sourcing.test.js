"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const mongoose = require("mongoose");

const Product = require("../models/Product");
const Order = require("../models/Order");

const {
  normalizeMeeshoLink,
  safeMeeshoLink,
} = require("../utils/meeshoUrl");

const {
  snapshotProductSourcing,
  withAdminSourcing,
} = require("../utils/orderSourcing");

// Test controller helpers without changing production exports.
// Loading these modules does not start a server or database connection.
function internals(filename, names) {
  const absolute = path.resolve(
    __dirname,
    "../middleware/controllers",
    filename,
  );

  const module = { exports: {} };

  const source =
    fs.readFileSync(absolute, "utf8") +
    "\nmodule.exports.__test = {" +
    names +
    "};";

  vm.runInNewContext(source, {
    module,
    exports: module.exports,

    require: (name) =>
      name === "../../utils/checkoutShipping"
        ? require("./helpers/checkoutShipping.cjs")
            .shippingWithRecord()
        : createRequire(absolute)(name),

    console,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    URL,
  });

  return module.exports.__test;
}

const products = internals(
  "productController.js",
  "normalizePayload,serializeProduct",
);

const payments = internals(
  "razorpayController.js",
  "snapshot,safeOrder,quote,advance",
);

const orders = internals(
  "orderController.js",
  "safeOrder",
);

const id = new mongoose.Types.ObjectId();
const user = new mongoose.Types.ObjectId();

const originalLink =
  "https://www.meesho.com/training-shirt/p/abc123";

const currentLink =
  "https://www.athflex.com/products/training-shirt";

const admin = {
  role: "admin",
  isActive: true,
};

const address = {
  fullName: "Test Customer",
  name: "Test Customer",
  email: "customer@example.test",
  phone: "9000000000",
  addressLine: "Test street 123",
  city: "Kochi",
  state: "Kerala",
  pincode: "682001",
};

function fixture(link = originalLink) {
  return new Product({
    _id: id,
    name: "Training shirt",
    slug: "training-shirt",
    category: "Clothing",
    brand: "Fixture brand",
    price: 1000,
    discount: 10,
    sku: "FIXTURE",
    stock: 5,
    sizes: ["M"],
    colors: ["Black"],

    variants: {
      Black: {
        M: 5,
      },
    },

    meeshoProductLink: link,

    optionLabels: {
      size: "Size",
      color: "Colour",
    },
  });
}

function purchase(
  sourcing = snapshotProductSourcing(fixture()),
) {
  return {
    _id: new mongoose.Types.ObjectId(),
    orderNumber: "GD-TEST",
    user,
    checkoutToken: "test-only",
    status: "payment-pending",

    customer: {
      name: address.name,
      email: address.email,
      phone: address.phone,
    },

    shippingAddress: address,

    items: [
      {
        product: id,
        name: "Training shirt",
        image: "https://example.test/shirt.jpg",
        originalPrice: 1000,
        price: 900,
        quantity: 2,
        selectedSize: "M",
        selectedColor: "Black",
        sourcing,
      },
    ],

    pricing: {
      subtotal: 1800,
      couponDiscount: 0,
      totalAfterCoupon: 1800,
      shipping: 0,
      finalTotal: 1800,
    },

    deliveryMethod: "standard",
  };
}

const unsafe = [
  "http://www.athflex.com/products/shirt",
  "javascript:alert(1)",
  "https://user:pass@www.athflex.com/products/shirt",
  "https://www.athflex.com:8443/products/shirt",
  "https://localhost/product",
  "https://127.0.0.1/product",
  "https://[::1]/product",
  "https://private.internal/product",
  "https://supplier.test/product",
  "https://www.athflex.com/",
  "https://www.athflex.com/\\evil",
  "https://www.athflex.com/a\nb",
  "//www.athflex.com/products/shirt",
  "https://www.athflex.com/item with space",
  {},
  123,
];

test(
  "product website links accept public brands, share links and clearing",
  () => {
    for (const link of [
      originalLink,
      currentLink,
      "https://ltl.sh/share/fixture?product=shirt",
    ]) {
      assert.equal(
        normalizeMeeshoLink("  " + link + "  "),
        link,
      );
    }

    assert.equal(
      normalizeMeeshoLink(
        "https://ATHFLEX.com:443/products/shirt?x=2",
      ),
      "https://athflex.com/products/shirt?x=2",
    );

    assert.equal(
      normalizeMeeshoLink(
        "https://www.athflex.com:0443/products/shirt",
      ),
      "https://www.athflex.com/products/shirt",
    );

    for (const empty of ["", "   ", null, undefined]) {
      assert.equal(
        normalizeMeeshoLink(empty),
        "",
      );
    }

    for (const value of unsafe) {
      assert.throws(
        () => normalizeMeeshoLink(value),
      );

      assert.equal(
        safeMeeshoLink(value),
        "",
      );
    }

    assert.throws(() =>
      normalizeMeeshoLink(
        "https://www.athflex.com/" +
          "a".repeat(2000),
      ),
    );

    assert.throws(() =>
      normalizeMeeshoLink(
        "https://www.athflex.com/" +
          "é".repeat(400),
      ),
    );
  },
);

test(
  "admin payload supports adding, editing, clearing and omitting links",
  () => {
    for (const link of [
      originalLink,
      currentLink,
      "",
    ]) {
      assert.equal(
        products.normalizePayload({
          meeshoProductLink: link,
        }).meeshoProductLink,
        link,
      );
    }

    assert.equal(
      Object.hasOwn(
        products.normalizePayload({
          name: "Changed name",
        }),
        "meeshoProductLink",
      ),
      false,
    );

    assert.throws(
      () =>
        products.normalizePayload({
          meeshoProductLink: unsafe[0],
        }),
      (error) => error.status === 400,
    );
  },
);

test(
  "Product stores links privately and products without links still validate",
  async () => {
    for (const link of [
      originalLink,
      currentLink,
      "",
    ]) {
      const product = fixture(link);

      await product.validate();

      assert.equal(
        product.toObject({
          transform: false,
        }).meeshoProductLink,
        link,
      );

      assert.equal(
        Object.hasOwn(
          product.toJSON(),
          "meeshoProductLink",
        ),
        false,
      );

      assert.equal(
        Object.hasOwn(
          product.toObject(),
          "meeshoProductLink",
        ),
        false,
      );

      assert.equal(
        products.serializeProduct(
          product,
          true,
        ).meeshoProductLink,
        link,
      );

      assert.equal(
        Object.hasOwn(
          products.serializeProduct(
            product,
            false,
          ),
          "meeshoProductLink",
        ),
        false,
      );
    }

    assert.equal(
      Product.schema.path(
        "meeshoProductLink",
      ).options.select,
      false,
    );

    assert.equal(
      Object.hasOwn(
        products.serializeProduct(
          {
            _id: id,
            meeshoProductLink: currentLink,
          },
          false,
        ),
        "meeshoProductLink",
      ),
      false,
    );

    await assert.rejects(
      new Product({
        ...fixture().toObject({
          transform: false,
        }),

        meeshoProductLink: unsafe[0],
      }).validate(),
    );
  },
);

test(
  "server checkout snapshots database links and variants, ignoring forged values",
  async (t) => {
    t.mock.method(
      Product,
      "findById",
      () => ({
        select(fields) {
          assert.match(
            fields,
            /\+meeshoProductLink/,
          );

          return Promise.resolve(fixture());
        },
      }),
    );

    const result = await payments.snapshot({
      items: [
        {
          id: String(id),
          quantity: 2,
          selectedSize: "M",
          selectedColor: "Black",
          price: 1,

          sourcing: {
            meeshoProductLink:
              "https://untrusted.invalid/forged",
          },

          meeshoProductLink: currentLink,
        },
      ],
    });

    const item = result.items[0];

    assert.equal(
      item.sourcing.meeshoProductLink,
      originalLink,
    );

    assert.equal(
      item.selectedSize,
      "M",
    );

    assert.equal(
      item.selectedColor,
      "Black",
    );

    assert.equal(item.quantity, 2);
    assert.equal(item.price, 900);

    assert.equal(
      result.pricing.finalTotal,
      1800,
    );

    const saved = new Order({
      ...purchase(),
      items: result.items,
      pricing: result.pricing,
    });

    await saved.validate();

    assert.equal(
      saved.toObject({
        transform: false,
      }).items[0].sourcing.meeshoProductLink,
      originalLink,
    );

    await assert.rejects(
      payments.snapshot({
        items: [
          {
            id: String(id),
            quantity: 1,
            selectedSize: "XL",
            selectedColor: "Black",
          },
        ],
      }),
      /available size/,
    );

    await assert.rejects(
      payments.snapshot({
        items: [
          {
            id: String(id),
            quantity: 6,
            selectedSize: "M",
            selectedColor: "Black",
          },
        ],
      }),
      /insufficient stock/,
    );
  },
);

test(
  "order projections and customer serializers exclude private sourcing fields",
  async () => {
    const data = purchase();
    const document = new Order(data);

    await document.validate();

    assert.equal(
      Order.schema.path("items")
        .schema.path("sourcing")
        .options.select,
      false,
    );

    const publicQuery = Order.findOne();

    publicQuery._applyPaths();

    assert.equal(
      publicQuery._fields["items.sourcing"],
      0,
    );

    const adminQuery = Order.findOne().select(
      "+items.sourcing",
    );

    adminQuery._applyPaths();

    assert.equal(
      Order.hydrate(
        data,
        adminQuery._fields,
      ).isSelected("items.sourcing"),
      true,
    );

    assert.equal(
      Object.hasOwn(
        document.toJSON().items[0],
        "sourcing",
      ),
      false,
    );

    assert.equal(
      Object.hasOwn(
        document.toObject().items[0],
        "sourcing",
      ),
      false,
    );

    for (const serialize of [
      payments.safeOrder,
      orders.safeOrder,
    ]) {
      for (const value of [data, document]) {
        const response = serialize(value);
        const json = JSON.stringify(response);

        assert.equal(
          json.includes(originalLink),
          false,
        );

        assert.equal(
          json.includes("sourcing"),
          false,
        );

        assert.equal(
          response.items[0].selectedSize,
          "M",
        );

        assert.equal(
          response.items[0].selectedColor,
          "Black",
        );

        assert.equal(
          response.items[0].quantity,
          2,
        );
      }
    }
  },
);

test(
  "saved and explicitly cleared snapshots survive product edits or deletion",
  async (t) => {
    t.mock.method(
      Product,
      "find",
      () => {
        throw new Error(
          "Snapshot must not look up current products",
        );
      },
    );

    const product = {
      meeshoProductLink: originalLink,

      optionLabels: {
        size: "Pack size",
        color: "Flavour",
      },
    };

    const snapshot =
      snapshotProductSourcing(product);

    product.meeshoProductLink = currentLink;

    assert.equal(
      snapshot.meeshoProductLink,
      originalLink,
    );

    for (const link of [originalLink, ""]) {
      const data = purchase({
        meeshoProductLink: link,
        sizeLabel: "Pack size",
        colorLabel: "Flavour",
      });

      const response = await withAdminSourcing(
        data,
        orders.safeOrder(data),
        admin,
      );

      assert.equal(
        response.items[0].sourcing.meeshoProductLink,
        link,
      );

      assert.equal(
        response.items[0].sourcing.source,
        "snapshot",
      );

      assert.equal(
        response.items[0].sourcing.sizeLabel,
        "Pack size",
      );

      assert.equal(
        response.items[0].sourcing.colorLabel,
        "Flavour",
      );
    }
  },
);

test(
  "legacy orders label current-link fallback and handle deleted products",
  async (t) => {
    let available = true;

    t.mock.method(
      Product,
      "find",
      (query) => {
        assert.deepEqual(
          query._id.$in,
          [String(id)],
        );

        return {
          select(fields) {
            assert.match(
              fields,
              /\+meeshoProductLink/,
            );

            return {
              lean: async () =>
                available
                  ? [
                      {
                        _id: id,
                        meeshoProductLink: currentLink,
                      },
                    ]
                  : [],
            };
          },
        };
      },
    );

    const data = purchase(null);

    const current = await withAdminSourcing(
      data,
      orders.safeOrder(data),
      admin,
    );

    assert.equal(
      current.items[0].sourcing.source,
      "current-product",
    );

    assert.equal(
      current.items[0].sourcing.meeshoProductLink,
      currentLink,
    );

    available = false;

    const missing = await withAdminSourcing(
      data,
      orders.safeOrder(data),
      admin,
    );

    assert.equal(
      missing.items[0].sourcing.source,
      "unavailable",
    );

    assert.equal(
      missing.items[0].sourcing.meeshoProductLink,
      "",
    );
  },
);

test(
  "only active admins access sourcing and mismatched items fail closed",
  async (t) => {
    let queried = false;

    t.mock.method(
      Product,
      "find",
      () => {
        queried = true;

        throw new Error(
          "Unexpected database access",
        );
      },
    );

    for (const value of [
      null,
      { role: "customer" },
      {
        role: "admin",
        isActive: false,
      },
    ]) {
      const data = purchase();

      await assert.rejects(
        withAdminSourcing(
          data,
          orders.safeOrder(data),
          value,
        ),
        (error) => error.status === 403,
      );
    }

    assert.equal(queried, false);

    await assert.rejects(
      withAdminSourcing(
        purchase(),
        {
          items: [
            { productId: "wrong" },
          ],
        },
        admin,
      ),
      /could not be matched/,
    );
  },
);

test(
  "admin status refresh reloads private snapshots omitted by a query",
  async (t) => {
    t.mock.method(
      Order,
      "findById",
      () => ({
        select(fields) {
          assert.match(
            fields,
            /\+items.sourcing/,
          );

          return {
            lean: async () => purchase(),
          };
        },
      }),
    );

    const data = purchase();

    data.isSelected = () => false;

    const result = await withAdminSourcing(
      data,
      orders.safeOrder(data),
      admin,
    );

    assert.equal(
      result.items[0].sourcing.meeshoProductLink,
      originalLink,
    );
  },
);

test(
  "purchased items stay immutable while payment, tracking and return fields remain editable",
  async () => {
    const original = purchase();
    const document = Order.hydrate(original);

    document.status = "processing";
    document.tracking.carrier = "Test courier";
    document.payment.status = "paid";
    document.returnRequest.reason = "Fixture return";

    await document.validate();

    document.items[0].name =
      "Replaced purchased item";

    await assert.rejects(
      document.validate(),
      /cannot be replaced/,
    );

    await assert.rejects(
      Order.updateOne(
        { _id: original._id },
        {
          $set: {
            "items.0.sourcing.meeshoProductLink":
              currentLink,
          },
        },
      ),
      /cannot be changed/,
    );

    await assert.rejects(
      Order.updateOne(
        { _id: original._id },
        {
          $rename: {
            other: "items",
          },
        },
      ),
      /cannot be changed/,
    );

    await assert.rejects(
      Order.findOneAndUpdate(
        { _id: original._id },
        {
          $set: {
            items: [],
          },
        },
      ),
      /cannot be changed/,
    );
  },
);

test(
  "payment retry identity and COD advance do not change with sourcing links",
  () => {
    const first = purchase();

    const second = purchase({
      meeshoProductLink: currentLink,
    });

    assert.equal(
      payments.quote(first),
      payments.quote(second),
    );

    const amounts = payments.advance({
      totalAfterCoupon: 1800,
      finalTotal: 1999,
    });

    assert.equal(
      amounts.advanceAmount,
      180,
    );

    assert.equal(
      amounts.amountDue,
      1819,
    );
  },
);