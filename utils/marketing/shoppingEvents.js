"use strict";

const Product = require("../../models/Product");
const KitTemplate = require("../../models/KitTemplate");
const Order = require("../../models/Order");

const {
  customerFilter,
} = require("../customerAccess");

const {
  buildKitCheckoutPricing,
} = require("../kitCheckoutPricing");

const {
  loadCheckoutReview,
} = require("../checkoutReview");

const {
  getConfig,
  ready,
} = require("./config");

const {
  consentSubject,
  readConsent,
  contextMatches,
  queuePublicEvent,
} = require("./events");

const {
  objectId,
  toPaise,
  fromPaise,
  groupId,
  variantId,
  sellingPricePaise,
  catalogVariants,
  productEligible,
} = require("./rules");

const SHOPPING_EVENTS = Object.freeze([
  "PageView",
  "ViewContent",
  "AddToCart",
  "AddToWishlist",
  "InitiateCheckout",
  "AddPaymentInfo",
]);

const MAX_ROWS = 50;
const MAX_QUANTITY = 99;
const MAX_PAISE = 10000000000;

const PUBLIC_PATH =
  /^(?:\/|\/(?:shop|offers|cart|wishlist|checkout|kits)|\/(?:product|kits)\/[a-f0-9]{24})$/;

const PRODUCT_FIELDS = [
  "_id",
  "name",
  "description",
  "brand",
  "category",
  "subcategory",
  "tags",
  "highlights",
  "whatsIncluded",
  "isActive",
  "price",
  "discount",
  "stock",
  "sizes",
  "colors",
  "variants",
  "image",
  "images",
  "colorImages",
  "optionLabels",
  "delivery",
  "sku",
  "variantSkus",
  "returnPolicy",
  "returnRequestTypes",
  "returnsEligible",
  "returnConditions",
  "returnWindowDays",
  "+metaMarketing",
  "+kitSettings",
].join(" ");

function invalid(message) {
  throw Object.assign(
    new Error(message),
    {
      marketing: true,
      status: 400,
      code: "INVALID_SHOPPING_EVENT",
    },
  );
}

function plain(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [
      Object.prototype,
      null,
    ].includes(
      Object.getPrototypeOf(value),
    )
  );
}

function fields(value, allowed) {
  if (
    !plain(value) ||
    Object.keys(value).some(
      (key) => !allowed.includes(key),
    )
  ) {
    invalid(
      "Use only the supported shopping-event fields.",
    );
  }
}

function option(value, maximum) {
  if (
    value == null ||
    value === ""
  ) {
    return null;
  }

  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(
      "Check the selected product options.",
    );
  }

  return value;
}

function itemInput(row, kitsAllowed) {
  fields(row, [
    "id",
    "quantity",
    "selectedSize",
    "selectedColor",

    ...(kitsAllowed
      ? ["kitGroup"]
      : []),
  ]);

  const id =
    typeof row.id === "string"
      ? objectId(row.id)
      : "";

  const quantity =
    row.quantity ?? 1;

  if (
    !id ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_QUANTITY
  ) {
    invalid(
      "Use a database product ID and a whole-number quantity from 1 to 99.",
    );
  }

  const result = {
    id,
    quantity,

    selectedSize: option(
      row.selectedSize,
      50,
    ),

    selectedColor: option(
      row.selectedColor,
      80,
    ),
  };

  if (
    Object.hasOwn(row, "kitGroup")
  ) {
    fields(row.kitGroup, [
      "id",
      "kitId",
      "version",
      "slotKey",
    ]);

    const group = row.kitGroup;

    if (
      typeof group.id !== "string" ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(
        group.id,
      ) ||
      typeof group.kitId !== "string" ||
      !objectId(group.kitId) ||
      !Number.isSafeInteger(
        group.version,
      ) ||
      group.version < 0 ||
      typeof group.slotKey !== "string" ||
      !/^[a-z][a-z0-9-]{0,59}$/.test(
        group.slotKey,
      )
    ) {
      invalid(
        "Check the complete kit grouping and template version.",
      );
    }

    result.kitGroup = {
      id: group.id,
      kitId: objectId(group.kitId),
      version: group.version,
      slotKey: group.slotKey,
    };
  }

  return result;
}

function validateShoppingRequest(body) {
  if (
    !plain(body) ||
    !SHOPPING_EVENTS.includes(
      body.eventName,
    )
  ) {
    invalid(
      "Choose a supported shopping event.",
    );
  }

  const checkout =
    body.eventName ===
    "InitiateCheckout";

  const payment =
    body.eventName ===
    "AddPaymentInfo";

  const page =
    body.eventName === "PageView";

  fields(body, [
    "eventName",
    "actionId",
    "sourcePath",

    ...(!page && !payment
      ? ["items"]
      : []),

    ...(payment
      ? ["orderId"]
      : []),

    ...(checkout
      ? [
          "coupon",
          "deliveryMethod",
          "paymentMethod",
          "pincode",
        ]
      : []),
  ]);

  if (
    typeof body.actionId !== "string" ||
    !/^[A-Za-z0-9_-]{16,100}$/.test(
      body.actionId,
    )
  ) {
    invalid(
      "A stable shopping-action identifier is required.",
    );
  }

  if (
    typeof body.sourcePath !== "string" ||
    !PUBLIC_PATH.test(
      body.sourcePath,
    )
  ) {
    invalid(
      "Use a public storefront path without query strings or private order information.",
    );
  }

  const result = {
    eventName: body.eventName,
    actionId: body.actionId,
    sourcePath: body.sourcePath,
  };

  if (payment) {
    if (
      body.sourcePath !== "/checkout" ||
      typeof body.orderId !== "string" ||
      !/^(?:[a-f0-9]{24}|GD-[A-Z0-9-]{1,80})$/i.test(
        body.orderId,
      )
    ) {
      invalid(
        "Check the checkout order identifier.",
      );
    }

    result.orderId =
      objectId(body.orderId) ||
      body.orderId.toUpperCase();

    return result;
  }

  if (page) {
    return result;
  }

  if (
    !Array.isArray(body.items) ||
    !body.items.length ||
    body.items.length > MAX_ROWS
  ) {
    invalid(
      "Choose between 1 and 50 shopping components.",
    );
  }

  const cart =
    body.eventName === "AddToCart";

  result.items = body.items.map(
    (row) =>
      itemInput(
        row,
        checkout || cart,
      ),
  );

  if (
    !checkout &&
    !cart &&
    (
      result.items.length !== 1 ||
      result.items[0].quantity !== 1
    )
  ) {
    invalid(
      "Product views and wishlist additions describe one product at a time.",
    );
  }

  if (checkout) {
    const coupon =
      body.coupon ?? "";

    if (
      typeof coupon !== "string" ||
      coupon.length > 50 ||
      /[\u0000-\u001f\u007f]/.test(
        coupon,
      )
    ) {
      invalid(
        "Check the coupon code.",
      );
    }

    const method =
      body.paymentMethod ??
      "razorpay";

    const delivery =
      body.deliveryMethod ??
      "standard";

    if (
      ![
        "razorpay",
        "cod-partial",
      ].includes(method) ||
      ![
        "standard",
        "express",
      ].includes(delivery)
    ) {
      invalid(
        "Check the payment and delivery options.",
      );
    }

    const pincode =
      body.pincode ?? "";

    if (
      typeof pincode !== "string" ||
      (
        pincode &&
        !/^[1-9]\d{5}$/.test(
          pincode,
        )
      )
    ) {
      invalid(
        "Use a valid delivery pincode.",
      );
    }

    Object.assign(result, {
      coupon,
      paymentMethod: method,
      deliveryMethod: delivery,
      pincode,
    });

    if (
      result.sourcePath !==
      "/checkout"
    ) {
      invalid(
        "Checkout-start events belong to the checkout page.",
      );
    }
  }

  return result;
}

async function loadProducts(items) {
  const ids = [
    ...new Set(
      items.map((row) => row.id),
    ),
  ];

  const products =
    await Product.find({
      _id: {
        $in: ids,
      },
      isActive: true,
    })
      .select(PRODUCT_FIELDS)
      .read("primary")
      .maxTimeMS(2000)
      .lean();

  return (
    products.length === ids.length &&
    products.every((product) =>
      productEligible(product),
    )
  )
    ? products
    : null;
}

function selectedOption(
  declared,
  value,
) {
  if (value === null) {
    return null;
  }

  const found = (
    declared || []
  ).find(
    (choice) =>
      choice.normalize("NFC") ===
      value.normalize("NFC"),
  );

  if (!found) {
    invalid(
      "A selected product option no longer exists.",
    );
  }

  return found;
}

function normalizeItems(
  items,
  products,
) {
  return items.map((item) => {
    const product = products.find(
      (value) =>
        objectId(value) === item.id,
    );

    return {
      ...item,

      selectedSize: selectedOption(
        product.sizes,
        item.selectedSize,
      ),

      selectedColor: selectedOption(
        product.colors,
        item.selectedColor,
      ),
    };
  });
}

function contentData(items) {
  const combined = new Map();

  for (const item of items) {
    const id = variantId(
      item.product,
      item.selectedSize ?? null,
      item.selectedColor ?? null,
    );

    if (
      !Number.isSafeInteger(
        item.quantity,
      ) ||
      item.quantity < 1 ||
      item.quantity > MAX_QUANTITY
    ) {
      invalid(
        "Check the recorded component quantities.",
      );
    }

    const quantity =
      (combined.get(id) || 0) +
      item.quantity;

    if (
      !Number.isSafeInteger(quantity) ||
      quantity > 1000000
    ) {
      invalid(
        "The combined component quantity is unsupported.",
      );
    }

    combined.set(id, quantity);
  }

  const contents = [
    ...combined,
  ].map(([id, quantity]) => ({
    id,
    quantity,
  }));

  const count = contents.reduce(
    (sum, row) =>
      sum + row.quantity,
    0,
  );

  if (
    !contents.length ||
    contents.length > MAX_ROWS ||
    !Number.isSafeInteger(count)
  ) {
    invalid(
      "Check the shopping components.",
    );
  }

  return {
    currency: "INR",
    content_type: "product",

    content_ids: [
      ...combined.keys(),
    ],

    contents,
    num_items: count,
  };
}

function amount(value) {
  const result = toPaise(value);

  if (
    result === null ||
    result > MAX_PAISE
  ) {
    invalid(
      "The server could not validate the shopping amount.",
    );
  }

  return result;
}

function productData(
  product,
  item,
) {
  const sizes =
    product.sizes || [];

  const colors =
    product.colors || [];

  const complete =
    (
      !sizes.length ||
      item.selectedSize !== null
    ) &&
    (
      !colors.length ||
      item.selectedColor !== null
    );

  const variant = complete
    ? catalogVariants(product).find(
        (row) =>
          row.size ===
            item.selectedSize &&
          row.color ===
            item.selectedColor,
      )
    : null;

  if (
    complete &&
    !variant
  ) {
    invalid(
      "The selected catalogue variant is unavailable.",
    );
  }

  const id = variant
    ? variant.id
    : groupId(product);

  return {
    currency: "INR",

    value: fromPaise(
      sellingPricePaise(product),
    ),

    content_type: variant
      ? "product"
      : "product_group",

    content_ids: [id],

    contents: [
      {
        id,
        quantity: 1,
      },
    ],

    num_items: 1,
  };
}

async function paymentInformation(
  req,
  input,
  config,
  consent,
) {
  if (
    !req.user?._id &&
    !req.guestSession?._id
  ) {
    return null;
  }

  const id = objectId(
    input.orderId,
  );

  const order =
    await Order.findOne({
      ...(id
        ? {
            _id: id,
          }
        : {
            orderNumber:
              input.orderId,
          }),

      ...customerFilter(req),
    })
      .select(
        "_id orderNumber items pricing payment metadata status cancellation refund returnRequest +marketing",
      )
      .read("primary")
      .maxTimeMS(2000)
      .lean();

  if (
    !order ||
    !contextMatches(
      order.marketing,
      config,
    ) ||
    order.marketing.subject !==
      consent._id ||
    order.marketing.consentVersion !==
      consent.version ||
    order.metadata?.demo !==
      (config.testMode !== false) ||
    ![
      "payment-pending",
      "confirmed",
      "processing",
      "packed",
      "shipped",
      "out-for-delivery",
      "delivered",
    ].includes(order.status) ||
    order.cancellation?.status ===
      "cancelled" ||
    [
      "pending",
      "manual-required",
      "refunded",
      "processed",
    ].includes(
      order.refund?.status,
    ) ||
    [
      "requested",
      "approved",
      "completed",
    ].includes(
      order.returnRequest?.status,
    ) ||
    order.payment?.gateway !==
      "razorpay" ||
    ![
      "razorpay",
      "cod-partial",
    ].includes(
      order.payment.method,
    ) ||
    !/^order_[A-Za-z0-9]+$/.test(
      order.payment.razorpayOrderId ||
        "",
    ) ||
    order.pricing?.currency !==
      "INR" ||
    !Array.isArray(order.items) ||
    !order.items.length ||
    order.items.length > MAX_ROWS
  ) {
    return null;
  }

  const products =
    await loadProducts(
      order.items.map((item) => ({
        id: objectId(
          item.product,
        ),
      })),
    );

  if (!products) {
    return null;
  }

  const total = amount(
    order.pricing.finalTotal,
  );

  const shipping = amount(
    order.pricing.shipping,
  );

  if (
    amount(
      order.payment.totalAmount,
    ) !== total ||
    amount(
      order.pricing.totalAfterCoupon,
    ) + shipping !== total
  ) {
    return null;
  }

  // One payment-information event per
  // server order, including repeated callbacks.
  return {
    ...input,

    actionId:
      `payment_${objectId(order)}`,

    customData: {
      ...contentData(order.items),
      value: fromPaise(total),
      shipping: fromPaise(shipping),
    },
  };
}

async function prepareShoppingEvent(
  req,
  input,
  config,
  consent,
) {
  if (
    input.eventName ===
    "AddPaymentInfo"
  ) {
    return paymentInformation(
      req,
      input,
      config,
      consent,
    );
  }

  if (
    input.eventName === "PageView"
  ) {
    const match =
      /^\/product\/([a-f0-9]{24})$/.exec(
        input.sourcePath,
      );

    if (!match) {
      return {
        ...input,
        customData: {},
      };
    }

    const products =
      await loadProducts([
        {
          id: match[1],
        },
      ]);

    return products
      ? {
          ...input,

          customData: {
            content_type:
              "product_group",

            content_ids: [
              groupId(products[0]),
            ],
          },
        }
      : null;
  }

  const products =
    await loadProducts(
      input.items,
    );

  // Never disclose a mixed basket containing
  // excluded or unreviewed products.
  if (!products) {
    return null;
  }

  const items =
    normalizeItems(
      input.items,
      products,
    );

  if (
    [
      "ViewContent",
      "AddToWishlist",
    ].includes(input.eventName)
  ) {
    const product =
      products.find(
        (row) =>
          objectId(row) ===
          items[0].id,
      );

    if (
      input.eventName ===
        "ViewContent" &&
      input.sourcePath !==
        `/product/${
          objectId(product)
        }`
    ) {
      invalid(
        "Product-view events must match the actual product page.",
      );
    }

    return {
      ...input,

      customData: productData(
        product,
        items[0],
      ),
    };
  }

  let quote;

  if (
    input.eventName ===
    "InitiateCheckout"
  ) {
    ({ quote } =
      await loadCheckoutReview({
        items,
        coupon: input.coupon,
        deliveryMethod:
          input.deliveryMethod,
        paymentMethod:
          input.paymentMethod,
        pincode: input.pincode,
      }));
  } else {
    const ids = [
      ...new Set(
        items
          .map(
            (row) =>
              row.kitGroup?.kitId,
          )
          .filter(Boolean),
      ),
    ];

    const kits = ids.length
      ? await KitTemplate.find({
          _id: {
            $in: ids,
          },
          status: "published",
        })
          .select("+fulfillment")
          .read("primary")
          .maxTimeMS(2000)
          .lean()
      : [];

    quote =
      buildKitCheckoutPricing({
        items,
        products,
        kits,
        coupon: "",
        deliveryMethod:
          "standard",
        paymentMethod:
          "razorpay",
      });
  }

  if (
    !quote ||
    !Array.isArray(quote.items) ||
    !quote.items.length
  ) {
    return null;
  }

  // The content set must remain exactly the
  // already-reviewed public products.
  const allowed = new Set(
    products.map(
      (row) => objectId(row),
    ),
  );

  if (
    quote.items.some(
      (row) =>
        !allowed.has(
          objectId(row.product),
        ),
    )
  ) {
    return null;
  }

  const customData =
    contentData(quote.items);

  const merchandise = amount(
    quote.pricing.totalAfterCoupon,
  );

  const allocations =
    quote.items.map(
      (row) =>
        row.priceAllocation
          ?.linePaidPaise,
    );

  if (
    allocations.some(
      (value) =>
        !Number.isSafeInteger(
          value,
        ) ||
        value < 0,
    ) ||
    allocations.reduce(
      (sum, value) =>
        sum + value,
      0,
    ) !== merchandise
  ) {
    return null;
  }

  if (
    input.eventName === "AddToCart"
  ) {
    // Merchandise actually added, after kit
    // discounts, excluding future shipping.
    customData.value =
      fromPaise(merchandise);
  } else if (
    !quote.kitSnapshots?.length ||
    quote.shippingReview?.ready ===
      true
  ) {
    const total = amount(
      quote.pricing.finalTotal,
    );

    const shipping = amount(
      quote.pricing.shipping,
    );

    if (
      total !==
      merchandise + shipping
    ) {
      return null;
    }

    customData.value =
      fromPaise(total);

    customData.shipping =
      fromPaise(shipping);
  }

  // A kit checkout without confirmed shipping
  // sends IDs and quantities only. It does not
  // report an estimate as a final amount.
  return {
    ...input,
    customData,
  };
}

async function reportShoppingEvent(
  req,
  res,
) {
  res.set(
    "Cache-Control",
    "no-store",
  );

  try {
    const input =
      validateShoppingRequest(
        req.body,
      );

    const config =
      await getConfig();

    if (
      !config.allowedEvents.includes(
        input.eventName,
      ) ||
      (
        !ready(config, "pixel") &&
        !ready(config, "capi")
      )
    ) {
      return res.json({
        success: true,
        prepared: false,
        receipt: null,
      });
    }

    const consent =
      await readConsent(
        consentSubject(req),
      );

    if (!consent) {
      return res.json({
        success: true,
        prepared: false,
        receipt: null,
      });
    }

    const details =
      await prepareShoppingEvent(
        req,
        input,
        config,
        consent,
      );

    const receipt = details
      ? await queuePublicEvent(
          req,
          {
            eventName:
              details.eventName,

            actionId:
              details.actionId,

            sourcePath:
              details.sourcePath,

            customData:
              details.customData,

            consentVersion:
              consent.version,

            expectedConfig: {
              datasetId:
                config.datasetId,

              epoch:
                config.epoch,

              testMode:
                config.testMode !==
                false,
            },
          },
        )
      : null;

    // Prepared means stored/available for
    // delivery, never provider acceptance.
    return res.json({
      success: true,
      prepared: Boolean(receipt),
      receipt,
    });
  } catch (error) {
    if (
      error.marketing === true
    ) {
      return res.status(400).json({
        success: false,

        code:
          "INVALID_SHOPPING_EVENT",

        message:
          error.message,
      });
    }

    if (
      error.gymdrobe === true ||
      error.status === 400 ||
      error.status === 409
    ) {
      return res.json({
        success: true,
        prepared: false,
        receipt: null,
      });
    }

    return res.status(503).json({
      success: false,

      code:
        "SHOPPING_EVENT_UNAVAILABLE",

      message:
        "Optional measurement is unavailable. Your shopping and payment can continue.",
    });
  }
}

module.exports = {
  SHOPPING_EVENTS,
  validateShoppingRequest,
  prepareShoppingEvent,
  reportShoppingEvent,
};