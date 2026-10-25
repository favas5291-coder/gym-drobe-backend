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
  normalizeColorImages,
  productImageSources,
  selectedProductImage,
} = require("../utils/productImages");

const { kitDraft } = require("../utils/kitDefinitions");

const {
  buildKitCheckoutPricing,
} = require("../utils/kitCheckoutPricing");

const id = new mongoose.Types.ObjectId();
const user = new mongoose.Types.ObjectId();

const colors = ["Black", "Blue", "White"];

function fixture() {
  return new Product({
    _id: id,
    name: "Fixture shirt",
    slug: "fixture-shirt",
    category: "Clothing",
    brand: "Fixture brand",
    price: 500,
    stock: 12,

    image: "/default.jpg",

    images: [
      "/default.jpg",
      "/default-back.jpg",
    ],

    sizes: ["M", "L"],
    colors,

    variants: {
      Black: {
        M: 3,
        L: 3,
      },
      Blue: {
        M: 0,
        L: 3,
      },
      White: {
        M: 3,
        L: 0,
      },
    },

    colorImages: [
      {
        color: "Black",
        images: [
          "/black.jpg",
          "/black-back.jpg",
        ],
      },
      {
        color: "Blue",
        images: [
          "/blue.jpg",
          "/blue-back.jpg",
        ],
      },
    ],

    kitSettings: {
      eligible: true,
      roles: ["clothing"],
    },
  });
}

// Expose internal functions inside an isolated test context.
// This does not connect to MongoDB or call Razorpay.
function internals(file, names) {
  const absolute = path.resolve(
    __dirname,
    "../middleware/controllers",
    file,
  );

  const module = {
    exports: {},
  };

  const source =
    fs.readFileSync(absolute, "utf8") +
    `\nmodule.exports.__test = { ${names} };`;

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
    URL,
    setTimeout,
    clearTimeout,
  });

  return module.exports.__test;
}

const controller = internals(
  "productController.js",
  "normalizePayload, serializeProduct",
);

const payments = internals(
  "razorpayController.js",
  "snapshot, safeOrder",
);

const orders = internals(
  "orderController.js",
  "safeOrder",
);

test(
  "each colour has ordered deduplicated photos and missing assignments use only the default gallery",
  () => {
    const product = fixture();

    assert.deepEqual(
      productImageSources(product, "Blue"),
      ["/blue.jpg", "/blue-back.jpg"],
    );

    assert.deepEqual(
      productImageSources(product, "White"),
      ["/default.jpg", "/default-back.jpg"],
    );

    assert.equal(
      selectedProductImage(product, "Black"),
      "/black.jpg",
    );

    assert.deepEqual(
      normalizeColorImages(
        [
          {
            color: "Blue",
            images: [
              " /blue.jpg ",
              "/blue.jpg",
            ],
          },
        ],
        colors,
      ),
      [
        {
          color: "Blue",
          images: ["/blue.jpg"],
        },
      ],
    );
  },
);

test(
  "unsafe URLs, wrong colour names, duplicates and excessive photos are rejected",
  () => {
    const unsafeSources = [
      "javascript:alert(1)",
      "data:image/svg+xml,bad",
      "file:///C:/photo.jpg",
      "C:\\photo.jpg",
      "//evil.test/a.jpg",
      "https://user:password@host.test/a.jpg",
      "http://localhost/a.jpg",
      "https://127.0.0.1/a.jpg",
      "/a\nb.jpg",
    ];

    for (const source of unsafeSources) {
      assert.throws(() =>
        normalizeColorImages(
          [
            {
              color: "Black",
              images: [source],
            },
          ],
          colors,
        ),
      );

      assert.throws(
        () =>
          controller.normalizePayload({
            colorImages: [
              {
                color: "Black",
                images: [source],
              },
            ],
          }),
        (error) => error.status === 400,
      );
    }

    assert.throws(() =>
      normalizeColorImages(
        [
          {
            color: "Red",
            images: ["/red.jpg"],
          },
        ],
        colors,
      ),
    );

    assert.throws(() =>
      normalizeColorImages(
        [
          {
            color: "Black",
            images: [],
          },
          {
            color: "black",
            images: [],
          },
        ],
        colors,
      ),
    );

    assert.throws(() =>
      normalizeColorImages(
        [
          {
            color: "Black",
            images: Array(21).fill("/black.jpg"),
          },
        ],
        colors,
      ),
    );

    assert.throws(() =>
      normalizeColorImages(
        Array.from(
          { length: 6 },
          (_, index) => ({
            color: `Colour${index}`,
            images: Array.from(
              { length: 20 },
              (_, number) =>
                `/${index}-${number}.jpg`,
            ),
          }),
        ),
      ),
    );
  },
);

test(
  "admin add, edit, clear and omitted photo patches retain the existing stock fields",
  async () => {
    const product = fixture();

    await product.validate();

    const patch = controller.normalizePayload({
      colorImages: [
        {
          color: "Blue",
          images: ["/new-blue.jpg"],
        },
      ],
    });

    assert.equal(
      Object.hasOwn(patch, "variants"),
      false,
    );

    product.set(patch);

    await product.validate();

    assert.equal(
      selectedProductImage(product, "Blue"),
      "/new-blue.jpg",
    );

    assert.equal(
      product.variants.Blue.L,
      3,
    );

    const unrelatedPatch =
      controller.normalizePayload({
        name: "New name",
      });

    assert.equal(
      Object.hasOwn(
        unrelatedPatch,
        "colorImages",
      ),
      false,
    );

    product.set(
      controller.normalizePayload({
        colorImages: [],
      }),
    );

    await product.validate();

    assert.equal(
      selectedProductImage(product, "Blue"),
      "/default.jpg",
    );
  },
);

test(
  "schema enforces current colour names and old products without galleries still validate",
  async () => {
    const product = fixture();

    product.colorImages.push({
      color: "Unknown",
      images: ["/unknown.jpg"],
    });

    await assert.rejects(
      product.validate(),
      /must match an available colour/,
    );

    const old = fixture();

    old.colorImages = undefined;

    await old.validate();

    assert.equal(
      selectedProductImage(old, "Blue"),
      "/default.jpg",
    );
  },
);

test(
  "public and admin product responses expose the galleries while keeping sourcing private",
  async () => {
    const product = fixture();

    product.meeshoProductLink =
      "https://meesho.com/private/p/fixture";

    await product.validate();

    const response =
      controller.serializeProduct(product);

    assert.equal(
      response.colorImages[1].images[0],
      "/blue.jpg",
    );

    assert.equal(
      Object.hasOwn(
        response,
        "meeshoProductLink",
      ),
      false,
    );

    const adminResponse =
      controller.serializeProduct(
        product,
        true,
      );

    assert.equal(
      adminResponse.colorImages[0].color,
      "Black",
    );
  },
);

test(
  "ordinary checkout saves the backend-selected colour image and ignores customer image overrides",
  async (t) => {
    const product = fixture();

    await product.validate();

    t.mock.method(
      Product,
      "findById",
      () => ({
        select: async () => product,
      }),
    );

    const result = await payments.snapshot({
      items: [
        {
          id: String(id),
          quantity: 1,
          selectedColor: "Blue",
          selectedSize: "L",

          image: "/forged-black.jpg",

          colorImages: [
            {
              color: "Blue",
              images: ["/forged.jpg"],
            },
          ],
        },
      ],
    });

    assert.equal(
      result.items[0].image,
      "/blue.jpg",
    );

    assert.equal(
      result.items[0].selectedSize,
      "L",
    );

    assert.equal(
      result.items[0].price,
      500,
    );

    await assert.rejects(
      payments.snapshot({
        items: [
          {
            id: String(id),
            quantity: 1,
            selectedColor: "Blue",
            selectedSize: "M",
          },
        ],
      }),
    );
  },
);

test(
  "kit checkout uses the same colour gallery and underlying size inventory",
  () => {
    const product = fixture().toObject({
      transform: false,
    });

    const template = {
      ...kitDraft("beginner"),

      _id: id,
      __v: 0,
      status: "published",

      fulfillment: {
        mode: "separate-shipments",
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

    template.slots[0].defaultProduct =
      String(id);

    template.slots[0].allowedProducts = [
      String(id),
    ];

    const result = buildKitCheckoutPricing({
      products: [product],
      kits: [template],

      items: [
        {
          id: String(id),
          quantity: 1,
          selectedColor: "Blue",
          selectedSize: "L",

          image: "/forged.jpg",

          kitGroup: {
            id: "kit-group-1",
            kitId: String(id),
            version: 0,
            slotKey: "clothing",
          },
        },
      ],
    });

    assert.equal(
      result.items[0].image,
      "/blue.jpg",
    );

    assert.equal(
      result.items[0].selectedColor,
      "Blue",
    );
  },
);

test(
  "purchased and legacy order thumbnails do not follow later product gallery changes",
  async () => {
    const original = {
      orderNumber: "GD-COLOUR-FIXTURE",
      user,
      checkoutToken: "fixture",
      status: "payment-pending",

      customer: {
        name: "Fixture Customer",
        email: "fixture@example.test",
        phone: "9000000000",
      },

      shippingAddress: {
        name: "Fixture Customer",
        fullName: "Fixture Customer",
        email: "fixture@example.test",
        phone: "9000000000",
        addressLine: "123 Test Street",
        city: "Kochi",
        state: "Kerala",
        pincode: "682001",
      },

      items: [
        {
          product: id,
          name: "Fixture shirt",
          image: "/old-blue.jpg",
          originalPrice: 500,
          price: 500,
          quantity: 1,
          selectedSize: "L",
          selectedColor: "Blue",
        },
      ],

      pricing: {
        subtotal: 500,
        couponDiscount: 0,
        totalAfterCoupon: 500,
        shipping: 0,
        finalTotal: 500,
      },
    };

    const order = new Order(original);

    await order.validate();

    const product = fixture();

    product.colorImages[1].images = [
      "/later-blue.jpg",
    ];

    for (const safe of [
      payments.safeOrder,
      orders.safeOrder,
    ]) {
      const response = safe(order);

      assert.equal(
        response.items[0].image,
        "/old-blue.jpg",
      );

      assert.equal(
        response.items[0].colorImages,
        undefined,
      );
    }

    const saved = Order.hydrate(
      order.toObject({
        transform: false,
      }),
    );

    saved.items[0].image =
      "/later-blue.jpg";

    await assert.rejects(
      saved.validate(),
      /cannot be replaced/,
    );
  },
);