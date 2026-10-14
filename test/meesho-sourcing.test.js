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

// Expose internal functions inside an isolated test module.
// Production controller exports remain unchanged.
function internals(filename, names) {
  const absolute = path.resolve(
    __dirname,
    "../middleware/controllers",
    filename
  );

  const module = { exports: {} };

  const source =
    fs.readFileSync(absolute, "utf8") +
    `\nmodule.exports.__test = {${names}};`;

  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: createRequire(absolute),
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
  "normalizePayload,serializeProduct"
);

const payments = internals(
  "razorpayController.js",
  "snapshot,safeOrder,quote,advance"
);

const orders = internals(
  "orderController.js",
  "safeOrder"
);

const id = new mongoose.Types.ObjectId();
const user = new mongoose.Types.ObjectId();

const originalLink =
  "https://www.meesho.com/training-shirt/p/abc123";

const currentLink =
  "https://www.meesho.com/new-shirt/p/xyz987";

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
  sourcing = snapshotProductSourcing(fixture())
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
  "http://meesho.com/item/p/1",
  "javascript:alert(1)",
  "https://meesho.com.evil.test/item",
  "https://evil.test/meesho.com/item",
  "https://meesho.com@evil.test/item",
  "https://user@meesho.com/item",
  "https://api.meesho.com/item",
  "https://meesho.com:444/item",
  "https://meesho.com/",
  "https://meesho.com/\\evil",
  "https://meesho.com/a\nb",
  "//meesho.com/item",
  "https://meesho.com/item with space",
  {},
  123,
];

test(
  "HTTPS listing validation accepts Meesho, canonicalizes and allows clearing",
  () => {
    assert.equal(
      normalizeMeeshoLink(`  ${originalLink}  `),
      originalLink
    );

    assert.equal(
      normalizeMeeshoLink(
        "https://MEESHO.com:443/item/p/1?x=2"
      ),
      "https://meesho.com/item/p/1?x=2"
    );

    assert.equal(
      normalizeMeeshoLink(
        "https://www.meesho.com:0443/item/p/1"
      ),
      "https://www.meesho.com/item/p/1"
    );

    for (const empty of ["", "   ", null, undefined]) {
      assert.equal(normalizeMeeshoLink(empty), "");
    }

    for (const value of unsafe) {
      assert.throws(() => normalizeMeeshoLink(value));
      assert.equal(safeMeeshoLink(value), "");
    }

    assert.throws(() =>
      normalizeMeeshoLink(
        "https://meesho.com/" + "a".repeat(2000)
      )
    );

    assert.throws(() =>
      normalizeMeeshoLink(
        "https://meesho.com/" + "é".repeat(400)
      )
    );
  }
);

test(
  "admin payload supports add, edit, clear and omission; rejects invalid links",
  () => {
    assert.equal(
      products.normalizePayload({
        meeshoProductLink: originalLink,
      }).meeshoProductLink,
      originalLink
    );

    assert.equal(
      products.normalizePayload({
        meeshoProductLink: currentLink,
      }).meeshoProductLink,
      currentLink
    );

    assert.equal(
      products.normalizePayload({
        meeshoProductLink: "",
      }).meeshoProductLink,
      ""
    );

    assert.equal(
      Object.hasOwn(
        products.normalizePayload({
          name: "Changed name",
        }),
        "meeshoProductLink"
      ),
      false
    );

    assert.throws(
      () =>
        products.normalizePayload({
          meeshoProductLink: unsafe[0],
        }),
      (error) => error.status === 400
    );
  }
);

test(
  "Product stores valid link privately and old products remain valid",
  async () => {
    const product = fixture();

    await product.validate();

    assert.equal(
      product.toObject({
        transform: false,
      }).meeshoProductLink,
      originalLink
    );

    assert.equal(
      Product.schema.path("meeshoProductLink")
        .options.select,
      false
    );

    assert.equal(
      Object.hasOwn(
        product.toJSON(),
        "meeshoProductLink"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        product.toObject(),
        "meeshoProductLink"
      ),
      false
    );

    assert.equal(
      products.serializeProduct(
        product,
        true
      ).meeshoProductLink,
      originalLink
    );

    assert.equal(
      Object.hasOwn(
        products.serializeProduct(product, false),
        "meeshoProductLink"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        products.serializeProduct(
          {
            _id: id,
            meeshoProductLink: originalLink,
          },
          false
        ),
        "meeshoProductLink"
      ),
      false
    );

    const old = fixture("");

    await old.validate();

    old.meeshoProductLink = currentLink;

    assert.equal(
      old.meeshoProductLink,
      currentLink
    );

    old.meeshoProductLink = "";

    assert.equal(old.meeshoProductLink, "");

    await assert.rejects(
      new Product({
        ...fixture().toObject({
          transform: false,
        }),
        meeshoProductLink:
          "https://evil.test/item",
      }).validate()
    );
  }
);

test(
  "server checkout snapshots DB link, options, quantity and price; ignores forged client values",
  async (t) => {
    t.mock.method(Product, "findById", () => ({
      select(fields) {
        assert.match(
          fields,
          /\+meeshoProductLink/
        );

        return Promise.resolve(fixture());
      },
    }));

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
              "https://evil.test/forged",
          },

          meeshoProductLink: currentLink,
        },
      ],
    });

    const item = result.items[0];

    assert.equal(
      item.sourcing.meeshoProductLink,
      originalLink
    );

    assert.equal(item.selectedSize, "M");
    assert.equal(item.selectedColor, "Black");
    assert.equal(item.quantity, 2);
    assert.equal(item.price, 900);
    assert.equal(result.pricing.finalTotal, 1800);

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
      originalLink
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
      /available size/
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
      /insufficient stock/
    );
  }
);

test(
  "Order projections and all customer serializers exclude sourcing",
  async () => {
    const data = purchase();
    const document = new Order(data);

    await document.validate();

    assert.equal(
      Order.schema.path("items")
        .schema.path("sourcing")
        .options.select,
      false
    );

    const publicQuery = Order.findOne();

    publicQuery._applyPaths();

    assert.equal(
      publicQuery._fields["items.sourcing"],
      0
    );

    const adminQuery = Order.findOne().select(
      "+items.sourcing"
    );

    adminQuery._applyPaths();

    assert.equal(
      Order.hydrate(
        data,
        adminQuery._fields
      ).isSelected("items.sourcing"),
      true
    );

    assert.equal(
      Object.hasOwn(
        document.toJSON().items[0],
        "sourcing"
      ),
      false
    );

    assert.equal(
      Object.hasOwn(
        document.toObject().items[0],
        "sourcing"
      ),
      false
    );

    for (const serialize of [
      payments.safeOrder,
      orders.safeOrder,
    ]) {
      for (const value of [data, document]) {
        const json = JSON.stringify(
          serialize(value)
        );

        assert.equal(
          json.includes("meesho"),
          false
        );

        assert.equal(
          json.includes("sourcing"),
          false
        );

        assert.equal(
          serialize(value).items[0].selectedSize,
          "M"
        );
      }
    }
  }
);

test(
  "snapshots survive changed/deleted products and an originally empty link never uses a later link",
  async (t) => {
    t.mock.method(Product, "find", () => {
      throw new Error(
        "Snapshot must not look up current products"
      );
    });

    for (const link of [originalLink, ""]) {
      const data = purchase({
        meeshoProductLink: link,
        sizeLabel: "Pack size",
        colorLabel: "Flavour",
      });

      const response = await withAdminSourcing(
        data,
        orders.safeOrder(data),
        admin
      );

      assert.equal(
        response.items[0].sourcing
          .meeshoProductLink,
        link
      );

      assert.equal(
        response.items[0].sourcing.source,
        "snapshot"
      );

      assert.equal(
        response.items[0].sourcing.colorLabel,
        "Flavour"
      );
    }
  }
);

test(
  "legacy orders batch-load current link, label fallback, and handle missing products",
  async (t) => {
    let available = true;

    t.mock.method(Product, "find", (query) => {
      assert.deepEqual(
        query._id.$in,
        [String(id)]
      );

      return {
        select(fields) {
          assert.match(
            fields,
            /\+meeshoProductLink/
          );

          return {
            lean: async () =>
              available
                ? [
                    {
                      _id: id,
                      meeshoProductLink:
                        currentLink,
                    },
                  ]
                : [],
          };
        },
      };
    });

    const data = purchase(null);

    const current = await withAdminSourcing(
      data,
      orders.safeOrder(data),
      admin
    );

    assert.equal(
      current.items[0].sourcing.source,
      "current-product"
    );

    assert.equal(
      current.items[0].sourcing
        .meeshoProductLink,
      currentLink
    );

    available = false;

    const missing = await withAdminSourcing(
      data,
      orders.safeOrder(data),
      admin
    );

    assert.equal(
      missing.items[0].sourcing.source,
      "unavailable"
    );

    assert.equal(
      missing.items[0].sourcing
        .meeshoProductLink,
      ""
    );
  }
);

test(
  "only active admins can enrich order responses and mismatched rows fail closed",
  async () => {
    for (const value of [
      null,
      { role: "customer" },
      { role: "admin", isActive: false },
    ]) {
      await assert.rejects(
        withAdminSourcing(
          purchase(),
          orders.safeOrder(purchase()),
          value
        ),
        (error) => error.status === 403
      );
    }

    await assert.rejects(
      withAdminSourcing(
        purchase(),
        {
          items: [
            { productId: "wrong" },
          ],
        },
        admin
      ),
      /could not be matched/
    );
  }
);

test(
  "status refresh reloads unselected private snapshots only for an admin",
  async (t) => {
    t.mock.method(Order, "findById", () => ({
      select(fields) {
        assert.match(
          fields,
          /\+items.sourcing/
        );

        return {
          lean: async () => purchase(),
        };
      },
    }));

    const data = purchase();

    data.isSelected = () => false;

    const result = await withAdminSourcing(
      data,
      orders.safeOrder(data),
      admin
    );

    assert.equal(
      result.items[0].sourcing
        .meeshoProductLink,
      originalLink
    );
  }
);

test(
  "sourcing is immutable while status, payment, tracking and return updates remain valid",
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
      /cannot be replaced/
    );

    await assert.rejects(
      Order.updateOne(
        { _id: original._id },
        {
          $set: {
            "items.0.sourcing.meeshoProductLink":
              currentLink,
          },
        }
      ),
      /cannot be changed/
    );

    await assert.rejects(
      Order.updateOne(
        { _id: original._id },
        {
          $rename: {
            other: "items",
          },
        }
      ),
      /cannot be changed/
    );

    await assert.rejects(
      Order.findOneAndUpdate(
        { _id: original._id },
        {
          $set: {
            items: [],
          },
        }
      ),
      /cannot be changed/
    );
  }
);

test(
  "payment retry quote and 10% COD advance are independent of sourcing changes",
  () => {
    const first = purchase();

    const second = purchase({
      meeshoProductLink: currentLink,
    });

    assert.equal(
      payments.quote(first),
      payments.quote(second)
    );

    const amounts = payments.advance({
      totalAfterCoupon: 1800,
      finalTotal: 1999,
    });

    assert.equal(amounts.advanceAmount, 180);
    assert.equal(amounts.amountDue, 1819);
  }
);