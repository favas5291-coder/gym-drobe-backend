const { checkoutDelivery } = require("../../utils/checkoutDelivery");
const { customerOwner, customerFilter } = require("../../utils/customerAccess");
const { selectedProductImage } = require("../../utils/productImages");
const { kitReviewKey } = require("../../utils/kitReviewKey");
const { loadCheckoutReview } = require("../../utils/checkoutReview");
const { loadShippingSettings, priceCheckoutShipping } = require("../../utils/checkoutShipping");
const { snapshotPurchasedShipping } = require("../../utils/purchasedShipping");
const { initializeKitFulfillment } = require("../../utils/kitFulfillmentProgress");
const { publicKitItemFields, publicKitOrderFields } = require("../../utils/publicKitOrder");
const { snapshotProductSourcing } = require("../../utils/orderSourcing");

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const mongoose = require("mongoose");

const Order = require("../../models/Order");
const Product = require("../../models/Product");
const PaymentAttempt = require("../../models/PaymentAttempt");

const { getRazorpayClient, getRazorpayKeyId } = require("../../config/razorpay");

const {
  getDiscountedPrice,
  getOriginalPrice,
  resolveCoupon,
  calculateOrderPricing,
} = require("../../utils/orderPricing");

const {
  getVariantStock,
  getVariantSku,
  reserveVariantStock,
} = require("../../utils/orderInventory");

const FULFILMENT = [
  "confirmed",
  "processing",
  "shipped",
  "out-for-delivery",
  "delivered",
];

const REFUNDS = [
  "pending",
  "manual-required",
  "refunded",
];

function problem(status, message, code = "PAYMENT_ERROR", extras = {}) {
  return Object.assign(new Error(message), {
    status,
    code,
    gymdrobe: true,
    ...extras,
  });
}

function text(value, name, maximum, minimum = 0, multiline = false) {
  if (value == null && minimum === 0) {
    return "";
  }

  if (typeof value !== "string") {
    throw problem(
      400,
      `${name} must be text.`,
      "INVALID_CHECKOUT",
    );
  }

  const result = value.trim();

  const controls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;

  if (
    result.length < minimum ||
    result.length > maximum ||
    controls.test(result)
  ) {
    throw problem(
      400,
      `Check ${name.toLowerCase()}.`,
      "INVALID_CHECKOUT",
    );
  }

  return result;
}

function cents(value, name = "Amount") {
  if (
    !["number", "string"].includes(typeof value) ||
    !String(value).trim()
  ) {
    throw problem(
      409,
      `${name} is missing. Check the order before paying.`,
      "INVALID_AMOUNT",
    );
  }

  const amount = Number(value);
  const result = Math.round(amount * 100);

  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(result) ||
    Math.abs(amount * 100 - result) > 0.000001
  ) {
    throw problem(
      409,
      `${name} is invalid. Check the order before paying.`,
      "INVALID_AMOUNT",
    );
  }

  return result;
}

function gatewayAmount(value, allowZero = false) {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw problem(
      502,
      "The payment provider returned an invalid amount.",
      "GATEWAY_AMOUNT_INVALID",
    );
  }

  return value;
}

function providerId(value, prefix) {
  return (
    typeof value === "string" &&
    value.length <= 100 &&
    new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value)
  );
}

function bodyOf(req) {
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body)
  ) {
    throw problem(
      400,
      "Checkout information is missing.",
      "INVALID_CHECKOUT",
    );
  }

  return req.body;
}

function configuration() {
  const keyId =
    String(getRazorpayKeyId() || "").trim();

  const secret =
    String(
      process.env.RAZORPAY_KEY_SECRET || "",
    ).trim();

  if (
    !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId) ||
    !secret
  ) {
    throw problem(
      503,
      "Online payment is not configured. Please contact GymDrobe support.",
      "PAYMENT_NOT_CONFIGURED",
    );
  }

  return {
    keyId,
    secret,
    client: getRazorpayClient(),
  };
}

function paymentTiming(res) {
  const durations = new Map();

  return async function measure(name, work) {
    const started = performance.now();

    try {
      return await work();
    } finally {
      const elapsed = Math.max(
        0,
        performance.now() - started,
      );

      durations.set(
        name,
        (durations.get(name) || 0) + elapsed,
      );

      if (!res.headersSent) {
        res.set(
          "Server-Timing",
          [...durations]
            .map(
              ([key, value]) =>
                `${key};dur=${value.toFixed(2)}`,
            )
            .join(", "),
        );
      }
    }
  };
}

async function gatewayCall(
  call,
  measure,
  name = "razorpay",
) {
  if (measure) {
    return measure(
      name,
      () => gatewayCall(call),
    );
  }

  let timer;

  try {
    return await Promise.race([
      Promise.resolve().then(call),

      new Promise((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              problem(
                503,
                "Payment confirmation timed out. Check My orders before trying another payment.",
                "GATEWAY_TIMEOUT",
                {
                  verificationUncertain: true,
                },
              ),
            ),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function transaction(work) {
  const session =
    await mongoose.startSession();

  try {
    return await session.withTransaction(
      () => work(session),
    );
  } finally {
    await session.endSession();
  }
}

function logFailure(error, stage) {
  const reference =
    crypto.randomBytes(8).toString("hex");

  const safe = (value) =>
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(value)
      ? value
      : "unknown";

  console.error(
    "GymDrobe payment error",
    {
      reference,
      stage,
      name: safe(error?.name),

      code:
        Number.isSafeInteger(error?.code)
          ? error.code
          : safe(error?.code),

      databaseState:
        mongoose.connection.readyState,
    },
  );

  return reference;
}

function fail(
  res,
  error,
  verification = false,
  stage = "payment-confirmation",
  captured = false,
) {
  const reference =
    logFailure(error, stage);

  const known =
    error?.gymdrobe === true;

  let status =
    known ? error.status : 503;

  let code =
    known
      ? error.code
      : "PAYMENT_UNAVAILABLE";

  let message = known
    ? error.message
    : verification
      ? "Payment confirmation was interrupted. Do not pay again; check My orders or contact support."
      : "Payment could not be started. Contact support with the error reference.";

  if (
    !known &&
    error?.name === "ValidationError"
  ) {
    code = "ORDER_VALIDATION_FAILED";

    message =
      "Your order could not be saved. Contact support with the error reference.";
  }

  if (
    !known &&
    error?.code === 11000
  ) {
    status = 409;
    code = "ORDER_CONFLICT";

    message =
      "An order conflict occurred. Check My orders before trying again.";
  }

  if (captured) {
    message =
      "Your payment was received, but confirmation needs review. Do not pay again; retry confirmation or check My orders.";
  }

  res.set(
    "X-GymDrobe-Error-Reference",
    reference,
  );

  return res.status(status).json({
    success: false,
    code,
    message,
    errorReference: reference,

    ...(captured
      ? {
          paymentReceived: true,
          retryVerification: true,
        }
      : {}),

    ...(
      (verification && !known) ||
      error?.verificationUncertain
        ? {
            verificationUncertain: true,
          }
        : {}
    ),
  });
}

function advance(pricing) {
  const total =
    cents(
      pricing.finalTotal,
      "Order total",
    );

  const merchandise =
    cents(
      pricing.totalAfterCoupon,
      "Product total",
    );

  const amount =
    Math.round(merchandise / 10);

  if (merchandise > total) {
    throw problem(
      409,
      "The order totals need review.",
      "INVALID_AMOUNT",
    );
  }

  return {
    advancePercentage: 10,
    advanceAmount: amount / 100,
    amountDue: (total - amount) / 100,
  };
}

function payable(order) {
  const payment = order.payment;
  const method = payment?.method;

  const total =
    cents(
      order.pricing?.finalTotal,
      "Order total",
    );

  if (
    !payment ||
    !["razorpay", "cod-partial"].includes(method) ||
    order.paymentMethod !== method ||
    (order.pricing.currency || "INR") !== "INR" ||
    cents(payment.totalAmount) !== total
  ) {
    throw problem(
      409,
      "This order's payment details need review. Do not pay again.",
      "PAYMENT_REVIEW_REQUIRED",
    );
  }

  const amount =
    method === "cod-partial"
      ? cents(payment.advanceAmount)
      : total;

  if (
    method === "cod-partial" &&
    (
      amount !==
        cents(
          advance(order.pricing).advanceAmount,
        ) ||
      payment.advancePercentage !== 10
    )
  ) {
    throw problem(
      409,
      "The COD advance needs review. Do not pay again.",
      "PAYMENT_REVIEW_REQUIRED",
    );
  }

  if (
    amount < 100 ||
    amount > total
  ) {
    throw problem(
      400,
      "The online amount must be at least ₹1.",
      "PAYMENT_AMOUNT_TOO_LOW",
    );
  }

  return amount;
}

function safeOrder(order) {
  const value =
    typeof order.toObject === "function"
      ? order.toObject()
      : order;

  return {
    id: value.orderNumber,
    orderNumber: value.orderNumber,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: value.status,
    source: value.source,
    giftMessage: value.giftMessage || "",
    orderNote: value.orderNote || "",

    user: value.user
      ? {
          id: String(
            value.user?._id || value.user,
          ),
        }
      : null,

    isGuestOrder:
      Boolean(order.guestSession),

    customer: value.customer,
    shippingAddress: value.shippingAddress,

    items: (value.items || []).map(
      (item) => ({
        id: String(item.product),
        productId: String(item.product),
        legacyId: item.legacyId,
        slug: item.slug,
        sku: item.sku,
        name: item.name,
        brand: item.brand,
        image: item.image,
        originalPrice: item.originalPrice,
        price: item.price,
        discount: item.discount,
        quantity: item.quantity,
        selectedSize: item.selectedSize,
        selectedColor: item.selectedColor,
        returnPolicy: item.returnPolicy,
        returnsEligible: item.returnsEligible,
        returnConditions: item.returnConditions,
        returnWindowDays: item.returnWindowDays,
        returnRequestTypes:
          item.returnRequestTypes,

        ...publicKitItemFields(item),
      }),
    ),

    ...publicKitOrderFields(value),

    pricing: value.pricing,
    coupon: value.coupon,
    payment: value.payment,
    paymentMethod: value.paymentMethod,
    delivery: value.delivery,
    deliveryMethod: value.deliveryMethod,
    tracking: value.tracking,
    cancellation: value.cancellation,
    returnRequest: value.returnRequest,
    refund: value.refund,

    metadata: {
      version: value.metadata?.version,
      demo: value.metadata?.demo,

      inventoryReserved:
        value.metadata?.inventoryReserved,

      checkoutToken:
        value.checkoutToken,
    },
  };
}

function address(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw problem(
      400,
      "Enter your delivery address.",
    );
  }

  const result = {
    fullName: text(
      value.fullName || value.name,
      "Full name",
      100,
      2,
    ),

    email: text(
      value.email,
      "Email",
      150,
      3,
    ).toLowerCase(),

    phone: text(
      value.phone,
      "Mobile number",
      30,
      1,
    ).replace(/[\s()+-]/g, ""),

    addressLine: text(
      value.addressLine || value.address,
      "House number and street",
      200,
      5,
    ),

    landmark: text(
      value.landmark,
      "Landmark",
      150,
    ),

    city: text(
      value.city,
      "City",
      100,
      1,
    ),

    state: text(
      value.state,
      "State",
      100,
      1,
    ),

    pincode: text(
      value.pincode,
      "Pincode",
      6,
      6,
    ),

    label: text(
      value.label || "Home",
      "Address label",
      30,
      1,
    ),
  };

  if (
    result.phone.startsWith("91") &&
    result.phone.length === 12
  ) {
    result.phone =
      result.phone.slice(2);
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      result.email,
    )
  ) {
    throw problem(
      400,
      "Enter a valid email address.",
    );
  }

  if (
    !/^[6-9]\d{9}$/.test(result.phone)
  ) {
    throw problem(
      400,
      "Enter a valid 10-digit Indian mobile number.",
    );
  }

  if (
    !/^[1-9]\d{5}$/.test(result.pincode)
  ) {
    throw problem(
      400,
      "Enter a valid 6-digit pincode.",
    );
  }

  return {
    ...result,
    name: result.fullName,
  };
}

async function findProduct(id) {
  if (
    mongoose.isObjectIdOrHexString(id)
  ) {
    const product =
      await Product.findById(id)
        .select("+meeshoProductLink");

    if (product) {
      return product;
    }
  }

  if (
    /^\d+$/.test(id) &&
    Number.isSafeInteger(Number(id))
  ) {
    const product =
      await Product.findOne({
        legacyId: Number(id),
      }).select("+meeshoProductLink");

    if (product) {
      return product;
    }
  }

  return Product.findOne({
    slug: id.toLowerCase(),
  }).select("+meeshoProductLink");
}

async function snapshot(body) {
  const hasKit =
    Array.isArray(body.items) &&
    body.items.some(
      (item) =>
        item &&
        Object.prototype.hasOwnProperty.call(
          item,
          "kitGroup",
        ),
    );

  if (hasKit) {
    const destination =
      address(
        body.shippingAddress,
      );

    const {
      quote: reviewed,
      products,
    } = await loadCheckoutReview({
      ...body,
      pincode: destination.pincode,
    });

    const shippingSnapshot =
      snapshotPurchasedShipping(
        reviewed,
        destination.pincode,
      );

    if (
      body.expectedTotal != null &&
      cents(body.expectedTotal) !==
        cents(
          reviewed.pricing.finalTotal,
        )
    ) {
      throw problem(
        409,
        "Your kit total changed. Review the current total before paying.",
        "CHECKOUT_TOTAL_CHANGED",
      );
    }

    if (
      typeof body.expectedReviewKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.expectedReviewKey) ||
      body.expectedReviewKey !==
        kitReviewKey(
          reviewed,
          destination.pincode,
        )
    ) {
      throw problem(
        409,
        "Your kit prices, package contents or delivery terms changed. Refresh the checkout review before paying.",
        "CHECKOUT_REVIEW_CHANGED",
      );
    }

    const sourceProducts = new Map(
      products.map(
        (product) => [
          String(
            product._id || product.id,
          ),
          product,
        ],
      ),
    );

    return {
      items: reviewed.items.map(
        (item) => ({
          ...item,

          sourcing:
            snapshotProductSourcing(
              sourceProducts.get(
                String(item.product),
              ),
            ),
        }),
      ),

      kitSnapshots:
        reviewed.kitSnapshots,

      shippingSnapshot,
      coupon: reviewed.coupon,
      pricing: reviewed.pricing,
      method: reviewed.method,
    };
  }

  if (
    !Array.isArray(body.items) ||
    body.items.length < 1 ||
    body.items.length > 50
  ) {
    throw problem(
      400,
      "Choose between 1 and 50 order items.",
    );
  }

  const products = new Map();
  const aliases = new Map();
  const rows = new Map();

  for (const raw of body.items) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    ) {
      throw problem(
        400,
        "Check the products in your bag.",
      );
    }

    const suppliedId =
      raw.id ??
      raw.productId ??
      raw.product;

    const id = text(
      typeof suppliedId === "number"
        ? String(suppliedId)
        : suppliedId,
      "Product ID",
      100,
      1,
    );

    const quantity =
      Number(raw.quantity);

    if (
      !["number", "string"].includes(
        typeof raw.quantity,
      ) ||
      !String(raw.quantity).trim() ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 99
    ) {
      throw problem(
        400,
        "Choose a whole-number quantity between 1 and 99.",
      );
    }

    let product =
      aliases.get(id);

    if (!product) {
      product =
        await findProduct(id);

      if (
        !product ||
        product.isActive === false
      ) {
        throw problem(
          409,
          "A product in your bag is no longer available.",
          "PRODUCT_UNAVAILABLE",
        );
      }

      if (
        product.delivery?.available === false
      ) {
        throw problem(
          409,
          `${product.name} is not available for delivery.`,
          "DELIVERY_UNAVAILABLE",
        );
      }

      const key =
        String(product._id);

      product =
        products.get(key) || product;

      products.set(
        key,
        product,
      );

      aliases.set(
        id,
        product,
      );
    }

    const size =
      product.sizes?.length
        ? text(
            raw.selectedSize,
            "Product size",
            50,
            1,
          )
        : null;

    const color =
      product.colors?.length
        ? text(
            raw.selectedColor,
            "Product colour",
            50,
            1,
          )
        : null;

    if (
      (
        size &&
        !product.sizes
          .map(String)
          .includes(size)
      ) ||
      (
        color &&
        !product.colors
          .map(String)
          .includes(color)
      )
    ) {
      throw problem(
        400,
        `Choose an available size and colour for ${product.name}.`,
        "INVALID_VARIANT",
      );
    }

    if (
      getVariantStock(
        product,
        size,
        color,
      ) < quantity
    ) {
      throw problem(
        409,
        `${product.name} has insufficient stock for this selection.`,
        "STOCK_UNAVAILABLE",
      );
    }

    if (
      product.price == null ||
      !Number.isFinite(
        Number(product.price),
      ) ||
      Number(product.price) < 0 ||
      !Number.isFinite(
        Number(
          product.discount ?? 0,
        ),
      ) ||
      Number(
        product.discount ?? 0,
      ) < 0 ||
      Number(
        product.discount ?? 0,
      ) > 100
    ) {
      throw problem(
        409,
        `${product.name} needs a price correction before purchase.`,
        "PRODUCT_PRICE_INVALID",
      );
    }

    const key =
      JSON.stringify([
        String(product._id),
        size,
        color,
      ]);

    const existing =
      rows.get(key);

    if (
      existing &&
      existing.quantity + quantity > 99
    ) {
      throw problem(
        400,
        "Combined product quantity cannot exceed 99.",
      );
    }

    if (existing) {
      existing.quantity +=
        quantity;
    } else {
      rows.set(key, {
        sourcing:
          snapshotProductSourcing(
            product,
          ),

        product: product._id,
        legacyId:
          product.legacyId ?? null,

        slug:
          product.slug || "",

        sku: getVariantSku(
          product,
          size,
          color,
        ),

        name: product.name,
        brand:
          product.brand || "",

        image:
          selectedProductImage(
            product,
            color,
          ),

        originalPrice:
          getOriginalPrice(
            product,
          ),

        price:
          getDiscountedPrice(
            product,
          ),

        discount: Number(
          product.discount || 0,
        ),

        quantity,
        selectedSize: size,
        selectedColor: color,

        returnPolicy:
          product.returnPolicy || "",

        returnRequestTypes:
          Array.isArray(
            product.returnRequestTypes,
          )
            ? [
                ...product.returnRequestTypes,
              ]
            : undefined,

        returnsEligible:
          ["yes", "no"].includes(
            product.returnsEligible,
          )
            ? product.returnsEligible
            : "unconfirmed",

        returnConditions:
          product.returnConditions || "",

        returnWindowDays:
          Number.isSafeInteger(
            product.returnWindowDays,
          ) &&
          product.returnWindowDays >= 1 &&
          product.returnWindowDays <= 7
            ? product.returnWindowDays
            : 7,
      });
    }

    // Check combined stock in memory during quoting.
    // Inventory is saved only when captured payment is finalized.
    reserveVariantStock(
      product,
      quantity,
      size,
      color,
    );
  }

  const method =
    body.deliveryMethod ??
    "standard";

  if (
    !["standard", "express"].includes(method)
  ) {
    throw problem(
      400,
      "Choose standard or express delivery.",
    );
  }

  const code =
    body.coupon == null
      ? ""
      : typeof body.coupon === "string"
        ? body.coupon
        : body.coupon.code;

  const couponCode =
    text(
      code,
      "Coupon code",
      100,
    );

  let coupon =
    resolveCoupon(
      couponCode,
    );

  if (
    couponCode &&
    !coupon
  ) {
    throw problem(
      400,
      "This coupon is unavailable. Remove it or choose another code.",
      "COUPON_INVALID",
    );
  }

  const items =
    [...rows.values()];

  const basePricing =
    calculateOrderPricing({
      cart: items,
      coupon,
      deliveryMethod: method,
    });

  const { pricing } =
    priceCheckoutShipping({
      settings:
        await loadShippingSettings(),

      pricing: basePricing,
      items,
      products:
        [...products.values()],

      deliveryMethod: method,

      paymentMethod:
        body.paymentMethod ??
        "razorpay",

      pincode:
        body.shippingAddress?.pincode,
    });

  for (
    const key of [
      "subtotal",
      "couponDiscount",
      "totalAfterCoupon",
      "shipping",
      "finalTotal",
    ]
  ) {
    cents(
      pricing[key],
    );
  }

  if (
    cents(pricing.subtotal) -
      cents(pricing.couponDiscount) !==
      cents(pricing.totalAfterCoupon) ||
    cents(pricing.totalAfterCoupon) +
      cents(pricing.shipping) !==
      cents(pricing.finalTotal)
  ) {
    throw problem(
      409,
      "Order pricing needs review.",
      "INVALID_AMOUNT",
    );
  }

  if (
    body.expectedTotal != null &&
    cents(
      body.expectedTotal,
      "Displayed total",
    ) !==
      cents(pricing.finalTotal)
  ) {
    throw problem(
      409,
      "Your order total changed. Review the latest total and try again.",
      "CHECKOUT_TOTAL_CHANGED",
    );
  }

  if (
    pricing.couponDiscount === 0
  ) {
    coupon = null;
  }

  return {
    items,
    coupon,
    pricing,
    method,

    deliveryReview:
      checkoutDelivery(
        [...products.values()],
        items,
        body.shippingAddress?.pincode,
      ),
  };
}

function quote(order) {
  return JSON.stringify({
    items: (order.items || [])
      .map(
        (item) => [
          String(item.product),
          item.selectedSize ?? null,
          item.selectedColor ?? null,
          item.quantity,
          cents(item.price),
        ],
      )
      .sort(
        (a, b) =>
          JSON.stringify(a).localeCompare(
            JSON.stringify(b),
          ),
      ),

    pricing: [
      "subtotal",
      "couponDiscount",
      "totalAfterCoupon",
      "shipping",
      "finalTotal",
    ].map(
      (key) =>
        cents(
          order.pricing[key],
        ),
    ),

    ...(
      order.kitSnapshots?.length
        ? {
            kitPurchase: {
              items:
                (order.items || []).map(
                  (item) => [
                    String(item.product),
                    item.kit?.groupId || null,
                    item.kit?.slotKey || null,
                    item.kit?.role || null,

                    item.priceAllocation
                      ? [
                          item.priceAllocation.quantity,
                          item.priceAllocation.lineSubtotalPaise,
                          item.priceAllocation.kitDiscountPaise,
                          item.priceAllocation.couponDiscountPaise,
                          item.priceAllocation.linePaidPaise,
                          item.priceAllocation.unitBasePaise,
                          item.priceAllocation.extraPaiseUnits,
                        ]
                      : null,
                  ],
                ),

              templates:
                order.kitSnapshots.map(
                  (kit) => [
                    kit.groupId,
                    String(kit.template),
                    kit.templateVersion,
                    kit.name,
                    kit.fulfillmentMode,
                    kit.linePaidPaise,
                  ],
                ),

              shipping:
                order.shippingSnapshot
                  ? {
                      destinationPincode:
                        order.shippingSnapshot.destinationPincode,

                      paymentMethod:
                        order.shippingSnapshot.paymentMethod,

                      shipments:
                        order.shippingSnapshot.shipments.map(
                          (parcel) => [
                            parcel.key,
                            parcel.groupId || null,
                            parcel.label,
                            parcel.carrier,
                            parcel.service,
                            parcel.merchandisePaise,
                            parcel.shippingPaise,
                            parcel.amountDuePaise,

                            [
                              parcel.preparationDays.minimum,
                              parcel.preparationDays.maximum,
                            ],

                            [
                              parcel.transitDays.minimum,
                              parcel.transitDays.maximum,
                            ],

                            parcel.contents.map(
                              (row) => [
                                row.itemIndex,
                                row.productId,
                                row.quantity,
                                row.selectedSize || null,
                                row.selectedColor || null,
                              ],
                            ),
                          ],
                        ),
                    }
                  : null,
            },
          }
        : {}
    ),

    coupon:
      order.coupon?.code || null,

    deliveryMethod:
      order.deliveryMethod,

    address:
      address(
        order.shippingAddress,
      ),

    giftMessage:
      order.giftMessage || "",

    orderNote:
      order.orderNote || "",
  });
}

function checkPayment(order, payment) {
  if (!order) {
    throw problem(
      404,
      "Payment order was not found.",
      "ORDER_NOT_FOUND",
    );
  }

  const expected =
    payable(order);

  if (
    !providerId(
      payment?.id,
      "pay",
    ) ||
    payment.order_id !==
      order.payment.razorpayOrderId ||
    payment.currency !== "INR" ||
    gatewayAmount(payment.amount) !== expected ||
    gatewayAmount(
      payment.amount_refunded ?? 0,
      true,
    ) > expected
  ) {
    throw problem(
      409,
      "Payment details do not match this order. Do not pay again.",
      "PAYMENT_MISMATCH",
    );
  }

  if (
    order.payment.verifiedAt &&
    (
      order.payment.razorpayPaymentId ||
      order.payment.transactionId
    ) !== payment.id
  ) {
    throw problem(
      409,
      "This order has a different verified payment. Contact support.",
      "PAYMENT_MISMATCH",
    );
  }
}

function recordPayment(order, payment) {
  if (
    order.payment.verifiedAt
  ) {
    return;
  }

  const now =
    new Date();

  const cod =
    order.payment.method ===
    "cod-partial";

  const total =
    cents(
      order.pricing.finalTotal,
    );

  const paid =
    gatewayAmount(
      payment.amount,
    );

  Object.assign(
    order.payment,
    {
      gateway: "razorpay",
      transactionId: payment.id,
      razorpayPaymentId: payment.id,
      verifiedAt: now,
      failedAt: null,
      totalAmount: total / 100,

      status:
        cod && paid < total
          ? "partially-paid"
          : "paid",

      amountPaid: paid / 100,
      amountDue:
        (total - paid) / 100,

      grossCollected: paid / 100,
      refundedAmount: 0,
      amountsReconciled: true,

      advancePercentage:
        cod ? 10 : 0,

      advanceAmount:
        cod ? paid / 100 : 0,

      advancePaidAt:
        cod ? now : null,

      balanceStatus:
        cod && paid < total
          ? "pending"
          : "not-applicable",

      paidAt:
        paid === total
          ? now
          : null,
    },
  );
}

function audit(
  order,
  status,
  description,
) {
  order.tracking =
    order.tracking || {};

  order.tracking.events =
    order.tracking.events || [];

  const exists =
    order.tracking.events.some(
      (event) =>
        event.status === status &&
        event.description ===
          description,
    );

  if (!exists) {
    order.tracking.events.push({
      status,
      description,
      timestamp: new Date(),
    });
  }
}

function paidOrder(order) {
  return (
    FULFILMENT.includes(
      order.status,
    ) &&
    order.metadata?.inventoryReserved === true &&
    Boolean(
      order.payment?.verifiedAt,
    ) &&
    [
      "paid",
      "partially-paid",
    ].includes(
      order.payment.status,
    )
  );
}

function refunding(order) {
  return (
    order.status === "cancelled" ||
    REFUNDS.includes(
      order.refund?.status,
    ) ||
    [
      "refunded",
      "partially-refunded",
    ].includes(
      order.payment?.status,
    )
  );
}

function resultResponse(
  res,
  order,
  alreadyPaid = false,
) {
  if (refunding(order)) {
    return res.status(409).json({
      success: false,

      code:
        "PAYMENT_REFUND_REVIEW",

      paymentReceived:
        Boolean(
          order.payment.verifiedAt,
        ),

      refundStarted:
        order.refund?.status ===
          "refunded" ||
        (
          order.refund?.status ===
            "pending" &&
          providerId(
            order.refund.reference,
            "rfnd",
          )
        ),

      message:
        "This order is cancelled or has a refund under review. Do not pay again; check My orders.",

      order:
        safeOrder(order),
    });
  }

  return res.json({
    success: true,
    paymentVerified: true,

    ...(
      alreadyPaid
        ? {
            alreadyPaid: true,
          }
        : {}
    ),

    paymentMethod:
      order.payment.method,

    paymentSummary: {
      totalAmount:
        order.payment.totalAmount,

      amountPaid:
        order.payment.amountPaid,

      amountDue:
        order.payment.amountDue,

      advancePercentage:
        order.payment.advancePercentage,

      advanceAmount:
        order.payment.advanceAmount,

      balanceStatus:
        order.payment.balanceStatus,
    },

    order:
      safeOrder(order),
  });
}

function checkGateway(
  order,
  gateway,
) {
  if (
    !providerId(
      gateway?.id,
      "order",
    ) ||
    gateway.currency !== "INR" ||
    gatewayAmount(
      gateway.amount,
    ) !== payable(order) ||
    gateway.receipt !==
      order.orderNumber
  ) {
    throw problem(
      502,
      "The provider order needs reconciliation. Do not start another payment.",
      "GATEWAY_ORDER_MISMATCH",
    );
  }
}

async function bindGateway(
  order,
  attempt,
  gateway,
) {
  checkGateway(
    order,
    gateway,
  );

  const ready =
    await PaymentAttempt.findOneAndUpdate(
      {
        _id: order._id,
        keyId: attempt.keyId,

        $or: [
          {
            state: {
              $in: [
                "creating",
                "uncertain",
              ],
            },
          },

          {
            state: "ready",

            razorpayOrderId:
              gateway.id,
          },
        ],
      },

      {
        $set: {
          state: "ready",

          razorpayOrderId:
            gateway.id,
        },

        $inc: {
          __v: 1,
        },
      },

      {
        new: true,
        runValidators: true,
      },
    );

  if (!ready) {
    throw problem(
      409,
      "Payment setup changed. Contact support before paying.",
      "PAYMENT_SETUP_CHANGED",
    );
  }

  const saved =
    await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: "payment-pending",

        "payment.status": {
          $in: [
            "pending",
            "failed",
          ],
        },

        "payment.verifiedAt": null,
        "payment.amountPaid": 0,

        "metadata.inventoryReserved": {
          $ne: true,
        },

        "refund.status":
          "not-requested",

        $or: [
          {
            "payment.razorpayOrderId":
              null,
          },

          {
            "payment.razorpayOrderId":
              gateway.id,
          },
        ],
      },

      {
        $set: {
          "payment.razorpayOrderId":
            gateway.id,

          "payment.status":
            "pending",

          "payment.failedAt":
            null,
        },

        $inc: {
          __v: 1,
        },
      },

      {
        new: true,
        runValidators: true,
      },
    );

  const current =
    saved ||
    (
      await Order.findById(
        order._id,
      )
    );

  if (
    !current ||
    current.payment.razorpayOrderId !==
      gateway.id
  ) {
    throw problem(
      409,
      "Your order changed. Check My orders before paying.",
      "PAYMENT_SETUP_CHANGED",
    );
  }

  return current;
}

async function providerOrder(
  order,
  config,
  measure,
) {
  const details = {
    _id: order._id,
    user: order.user,

    guestSession:
      order.guestSession,

    receipt:
      order.orderNumber,

    keyId:
      config.keyId,

    amount:
      payable(order),
  };

  if (
    details.receipt.length > 40
  ) {
    throw problem(
      409,
      "This order number needs review before payment.",
    );
  }

  let attempt;
  let winner = false;

  try {
    attempt =
      await PaymentAttempt.create(
        details,
      );

    winner = true;
  } catch (error) {
    if (
      error.code !== 11000
    ) {
      throw error;
    }

    attempt =
      await PaymentAttempt.findById(
        order._id,
      );
  }

  if (
    !attempt ||
    attempt.keyId !== config.keyId ||
    attempt.amount !== details.amount ||
    String(
      attempt.user || "",
    ) !==
      String(
        order.user || "",
      ) ||
    String(
      attempt.guestSession || "",
    ) !==
      String(
        order.guestSession || "",
      ) ||
    attempt.receipt !==
      details.receipt
  ) {
    throw problem(
      409,
      "This payment attempt needs reconciliation. Do not pay again.",
      "PAYMENT_SETUP_CHANGED",
    );
  }

  if (!winner) {
    if (
      attempt.state === "ready" &&
      providerId(
        attempt.razorpayOrderId,
        "order",
      )
    ) {
      const gateway =
        await gatewayCall(
          () =>
            config.client.orders.fetch(
              attempt.razorpayOrderId,
            ),
          measure,
          "razorpay_order_read",
        );

      return {
        order:
          await bindGateway(
            order,
            attempt,
            gateway,
          ),

        fresh: false,
      };
    }

    if (
      attempt.state === "creating" &&
      Date.now() -
        new Date(
          attempt.createdAt,
        ).getTime() <
        30000
    ) {
      throw problem(
        409,
        "Payment is being prepared. Wait a moment, then retry the same checkout.",
        "PAYMENT_STARTING",
      );
    }

    // Recover an uncertain creation through its exact receipt.
    const data =
      await gatewayCall(
        () =>
          config.client.orders.all({
            receipt:
              details.receipt,

            count: 100,
          }),
        measure,
        "razorpay_order_recovery",
      );

    if (
      !Array.isArray(
        data?.items,
      ) ||
      data.items.length >= 100
    ) {
      throw problem(
        503,
        "Payment setup needs provider review. Contact support.",
        "PAYMENT_SETUP_UNCERTAIN",
      );
    }

    const matches =
      data.items.filter(
        (item) =>
          item.receipt ===
          details.receipt,
      );

    if (
      matches.length !== 1
    ) {
      throw problem(
        503,
        "Payment setup is not yet confirmed. Retry this checkout later or contact support; do not make another payment.",
        "PAYMENT_SETUP_UNCERTAIN",
      );
    }

    return {
      order:
        await bindGateway(
          order,
          attempt,
          matches[0],
        ),

      fresh: false,
    };
  }

  try {
    const gateway =
      await gatewayCall(
        () =>
          config.client.orders.create({
            amount:
              details.amount,

            currency: "INR",

            receipt:
              details.receipt,

            partial_payment:
              false,

            notes: {
              gymdrobeOrder:
                order.orderNumber,

              paymentMethod:
                order.payment.method,

              orderNumber:
                order.orderNumber,
            },
          }),
        measure,
        "razorpay_order_create",
      );

    const saved =
      await bindGateway(
        order,
        attempt,
        gateway,
      );

    return {
      order: saved,

      // Only this request's successfully created, untouched provider order
      // can skip an immediate history lookup. Reused or uncertain attempts
      // always go through reconciliation before checkout is offered again.
      fresh:
        gateway.status === "created" &&
        gateway.attempts === 0 &&
        gateway.amount_paid === 0 &&
        gateway.amount_due ===
          details.amount,
    };
  } catch (error) {
    await PaymentAttempt.updateOne(
      {
        _id: order._id,
        state: "creating",
      },

      {
        $set: {
          state: "uncertain",
        },

        $inc: {
          __v: 1,
        },
      },
    );

    throw error;
  }
}

async function reconcileExistingPayment(
  order,
  config,
  measure,
) {
  const data =
    await gatewayCall(
      () =>
        config.client.orders.fetchPayments(
          order.payment.razorpayOrderId,
        ),
      measure,
      "razorpay_payment_history",
    );

  if (
    !Array.isArray(
      data?.items,
    )
  ) {
    throw problem(
      502,
      "Payment history could not be verified. Do not pay again.",
      "PAYMENT_HISTORY_UNAVAILABLE",
    );
  }

  const received =
    data.items.filter(
      (item) =>
        [
          "captured",
          "refunded",
        ].includes(
          item.status,
        ),
    );

  if (
    received.length > 1
  ) {
    throw problem(
      409,
      "Multiple payments need review. Do not pay again.",
      "MULTIPLE_PAYMENTS_REQUIRE_REVIEW",
    );
  }

  if (
    received.length === 1
  ) {
    const payment =
      await gatewayCall(
        () =>
          config.client.payments.fetch(
            received[0].id,
          ),
        measure,
        "razorpay_payment_read",
      );

    checkPayment(
      order,
      payment,
    );

    if (
      payment.status !== "captured" ||
      Number(
        payment.amount_refunded || 0,
      ) > 0
    ) {
      throw problem(
        409,
        "This payment has a refund recorded. Check My orders or contact support.",
        "PAYMENT_REFUND_REVIEW",
      );
    }

    try {
      return await finalizeCapturedPayment(
        order._id,
        payment,
      );
    } catch (error) {
      error.paymentReceived = true;
      throw error;
    }
  }

  if (
    data.items.some(
      (item) =>
        item.status ===
        "authorized",
    )
  ) {
    throw problem(
      409,
      "A payment is awaiting confirmation. Do not pay again; retry confirmation or check My orders.",
      "PAYMENT_CONFIRMATION_PENDING",

      {
        verificationUncertain: true,
      },
    );
  }

  return null;
}

async function createRazorpayOrder(
  req,
  res,
) {
  res.set(
    "Cache-Control",
    "no-store",
  );

  const measure =
    paymentTiming(res);

  let stage =
    "checkout-validation";

  try {
    const owner =
      customerOwner(req);

    const access =
      customerFilter(req);

    const body =
      bodyOf(req);

    const checkoutToken =
      text(
        body.checkoutToken,
        "Checkout token",
        200,
        1,
      );

    if (
      ![
        "razorpay",
        "cod-partial",
      ].includes(
        body.paymentMethod,
      )
    ) {
      throw problem(
        400,
        "Choose a valid payment method.",
      );
    }

    const config =
      configuration();

    let order =
      await measure(
        "order_lookup",
        async () => {
          await Order.init();

          return Order.findOne({
            ...access,
            checkoutToken,
          });
        },
      );

    if (order) {
      if (
        order.payment.method !==
        body.paymentMethod
      ) {
        throw problem(
          409,
          "This checkout uses a different payment method. Start a new checkout.",
        );
      }

      if (
        refunding(order)
      ) {
        return resultResponse(
          res,
          order,
        );
      }

      if (
        paidOrder(order)
      ) {
        return resultResponse(
          res,
          order,
          true,
        );
      }

      if (
        order.status !==
          "payment-pending" ||
        order.payment.verifiedAt ||
        order.metadata
          ?.inventoryReserved === true
      ) {
        throw problem(
          409,
          "This order needs payment review. Do not pay again; check My orders.",
        );
      }

      if (
        order.metadata?.demo !==
        config.keyId.startsWith(
          "rzp_test_",
        )
      ) {
        throw problem(
          409,
          "This checkout belongs to a different payment mode. Check My orders before starting a new checkout.",
          "PAYMENT_MODE_CHANGED",
        );
      }

      if (
        order.payment.razorpayOrderId
      ) {
        const recorded =
          await reconcileExistingPayment(
            order,
            config,
            measure,
          );

        if (recorded) {
          return resultResponse(
            res,
            recorded,
            true,
          );
        }
      }
    }

    stage =
      "checkout-products-and-address";

    const shippingAddress =
      address(
        body.shippingAddress,
      );

    const current =
      await measure(
        "checkout_review",
        () => snapshot(body),
      );

    const giftMessage =
      text(
        body.giftMessage,
        "Gift message",
        250,
        0,
        true,
      );

    const orderNote =
      text(
        body.orderNote,
        "Delivery instructions",
        300,
        0,
        true,
      );

    const comparison = {
      ...current,

      deliveryMethod:
        current.method,

      shippingAddress,
      giftMessage,
      orderNote,
    };

    if (
      order &&
      quote(order) !==
        quote(comparison)
    ) {
      throw problem(
        409,
        "Your checkout details changed. Start a new checkout to use the updated bag, address or total.",
        "CHECKOUT_CHANGED",
      );
    }

    if (!order) {
      const partial =
        advance(
          current.pricing,
        );

      if (
        body.paymentMethod ===
          "cod-partial" &&
        cents(
          partial.advanceAmount,
        ) < 100
      ) {
        throw problem(
          400,
          "This order amount is too low for a COD advance.",
          "PAYMENT_AMOUNT_TOO_LOW",
        );
      }

      stage =
        "order-create";

      try {
        order =
          await measure(
            "order_save",
            () =>
              Order.create({
                orderNumber:
                  `GD-${Date.now()
                    .toString(36)
                    .toUpperCase()}-` +
                  crypto
                    .randomBytes(6)
                    .toString("hex")
                    .toUpperCase(),

                ...owner,

                checkoutToken,

                source: [
                  "cart",
                  "selection",
                  "buy-now",
                ].includes(
                  body.source,
                )
                  ? body.source
                  : "cart",

                status:
                  "payment-pending",

                giftMessage,
                orderNote,
                shippingAddress,

                customer: {
                  name:
                    shippingAddress.fullName,

                  email:
                    shippingAddress.email,

                  phone:
                    shippingAddress.phone,
                },

                items:
                  current.items,

                kitSnapshots:
                  current.kitSnapshots || [],

                shippingSnapshot:
                  current.shippingSnapshot ||
                  null,

                pricing: {
                  ...current.pricing,
                  currency: "INR",
                },

                coupon:
                  current.coupon || {
                    code: null,
                    type: null,
                    value: null,
                    minimum: null,
                  },

                payment: {
                  method:
                    body.paymentMethod,

                  gateway:
                    "razorpay",

                  status:
                    "pending",

                  totalAmount:
                    current.pricing.finalTotal,

                  amountPaid: 0,

                  amountDue:
                    current.pricing.finalTotal,

                  grossCollected: 0,
                  refundedAmount: 0,
                  amountsReconciled: true,

                  advancePercentage:
                    body.paymentMethod ===
                    "cod-partial"
                      ? 10
                      : 0,

                  advanceAmount:
                    body.paymentMethod ===
                    "cod-partial"
                      ? partial.advanceAmount
                      : 0,

                  balanceStatus:
                    body.paymentMethod ===
                    "cod-partial"
                      ? "pending"
                      : "not-applicable",
                },

                paymentMethod:
                  body.paymentMethod,

                deliveryMethod:
                  current.method,

                delivery: {
                  method:
                    current.method,

                  status:
                    "pending",

                  label:
                    current.method ===
                    "express"
                      ? "Express delivery"
                      : "Standard delivery",

                  estimatedTime:
                    current.deliveryReview
                      ?.estimatedDays
                      ? `${current.deliveryReview.estimatedDays.minimum}–${current.deliveryReview.estimatedDays.maximum} days (recorded preparation and transit estimate)`
                      : null,

                  deliveredAt: null,
                },

                tracking: {
                  carrier: null,
                  trackingNumber: null,
                  estimatedDelivery: null,
                  events: [],
                },

                cancellation: {
                  status:
                    "not-cancelled",
                },

                returnRequest: {
                  status:
                    "not-requested",
                },

                refund: {
                  status:
                    "not-requested",

                  amount: 0,

                  submissionState:
                    "not-started",
                },

                metadata: {
                  version:
                    "7.0",

                  demo:
                    config.keyId.startsWith(
                      "rzp_test_",
                    ),

                  inventoryReserved:
                    false,
                },
              }),
          );
      } catch (error) {
        if (
          error.code !== 11000
        ) {
          throw error;
        }

        order =
          await Order.findOne({
            ...access,
            checkoutToken,
          });

        if (!order) {
          throw error;
        }

        if (
          order.payment.method !==
            body.paymentMethod ||
          quote(order) !==
            quote(comparison)
        ) {
          throw problem(
            409,
            "Another request saved different checkout details. Start a new checkout.",
            "CHECKOUT_CHANGED",
          );
        }
      }
    }

    stage =
      "razorpay-order-create-or-recover";

    const preparedGateway =
      !order.payment.razorpayOrderId;

    let needsReconciliation =
      preparedGateway;

    if (preparedGateway) {
      const prepared =
        await measure(
          "payment_setup",
          () =>
            providerOrder(
              order,
              config,
              measure,
            ),
        );

      order =
        prepared.order;

      needsReconciliation =
        !prepared.fresh;
    }

    if (
      refunding(order)
    ) {
      return resultResponse(
        res,
        order,
      );
    }

    if (
      paidOrder(order)
    ) {
      return resultResponse(
        res,
        order,
        true,
      );
    }

    if (
      needsReconciliation
    ) {
      stage =
        "payment-recovery";

      const recorded =
        await reconcileExistingPayment(
          order,
          config,
          measure,
        );

      if (recorded) {
        return resultResponse(
          res,
          recorded,
          true,
        );
      }
    }

    if (
      order.status !==
        "payment-pending" ||
      order.payment.verifiedAt ||
      order.metadata
        ?.inventoryReserved === true ||
      !providerId(
        order.payment.razorpayOrderId,
        "order",
      ) ||
      order.metadata?.demo !==
        config.keyId.startsWith(
          "rzp_test_",
        )
    ) {
      throw problem(
        409,
        "Payment setup changed. Check My orders before paying.",
        "PAYMENT_SETUP_CHANGED",
      );
    }

    const amount =
      payable(order);

    return res.json({
      success: true,

      paymentMethod:
        order.payment.method,

      keyId:
        config.keyId,

      razorpayOrderId:
        order.payment.razorpayOrderId,

      amount,
      amountRupees:
        amount / 100,

      currency:
        "INR",

      orderNumber:
        order.orderNumber,

      paymentSummary: {
        totalAmount:
          order.pricing.finalTotal,

        amountToPayNow:
          amount / 100,

        amountDue:
          (
            cents(
              order.pricing.finalTotal,
            ) - amount
          ) / 100,

        advancePercentage:
          order.payment.advancePercentage,

        advanceAmount:
          order.payment.advanceAmount,
      },
    });
  } catch (error) {
    return fail(
      res,
      error,
      Boolean(
        error.paymentReceived,
      ),
      stage,
      Boolean(
        error.paymentReceived,
      ),
    );
  }
}

async function refundCancelled(
  order,
  payment,
) {
  const claim =
    await transaction(
      async (session) => {
        const current =
          await Order.findById(
            order._id,
          ).session(session);

        checkPayment(
          current,
          payment,
        );

        if (
          current.status !==
            "cancelled" ||
          current.metadata
            ?.inventoryReserved === true ||
          ![
            "not-requested",
            "not-applicable",
          ].includes(
            current.refund?.status,
          )
        ) {
          return {
            order:
              current,

            claimed:
              false,
          };
        }

        recordPayment(
          current,
          payment,
        );

        const amount =
          gatewayAmount(
            payment.amount,
          );

        if (
          cents(
            current.payment.amountPaid,
          ) !== amount ||
          cents(
            current.payment.refundedAmount ||
              0,
          ) !== 0
        ) {
          throw problem(
            409,
            "This cancellation payment needs reconciliation.",
            "REFUND_REVIEW_REQUIRED",
          );
        }

        current.payment.amountDue =
          0;

        current.payment.balanceStatus =
          "not-applicable";

        current.refund.status =
          "pending";

        current.refund.amount =
          amount / 100;

        current.refund.reference =
          "";

        current.refund.requestedAt =
          new Date();

        current.refund.submissionState =
          "submitting";

        current.refund.submissionStartedAt =
          new Date();

        current.refund.submissionKey =
          "GD-STOCK-" +
          crypto
            .createHash("sha256")
            .update(
              String(current._id),
            )
            .digest("hex")
            .slice(0, 40);

        await current.save({
          session,
        });

        return {
          order:
            current,

          claimed:
            true,
        };
      },
    );

  if (
    !claim.claimed
  ) {
    return claim.order;
  }

  const amount =
    gatewayAmount(
      payment.amount,
    );

  try {
    const config =
      configuration();

    const latest =
      await gatewayCall(
        () =>
          config.client.payments.fetch(
            payment.id,
          ),
      );

    checkPayment(
      claim.order,
      latest,
    );

    if (
      latest.status !== "captured" ||
      gatewayAmount(
        latest.amount_refunded ?? 0,
        true,
      ) !== 0
    ) {
      throw problem(
        409,
        "The provider refund requires reconciliation.",
      );
    }

    const response =
      await fetch(
        `https://api.razorpay.com/v1/payments/${encodeURIComponent(
          payment.id,
        )}/refund`,

        {
          method: "POST",
          redirect: "error",

          signal:
            AbortSignal.timeout(
              20000,
            ),

          headers: {
            Accept:
              "application/json",

            "Content-Type":
              "application/json",

            Authorization:
              "Basic " +
              Buffer.from(
                `${config.keyId}:${config.secret}`,
              ).toString("base64"),

            "X-Refund-Idempotency":
              claim.order.refund.submissionKey,
          },

          body: JSON.stringify({
            amount,
            speed: "normal",

            notes: {
              gymdrobe_order:
                claim.order.orderNumber,

              reason:
                "paid_stock_unavailable",
            },
          }),
        },
      );

    const result =
      await response.json();

    if (
      !response.ok ||
      !providerId(
        result?.id,
        "rfnd",
      ) ||
      result.payment_id !==
        payment.id ||
      result.currency !==
        "INR" ||
      gatewayAmount(
        result.amount,
      ) !== amount ||
      ![
        "pending",
        "processed",
      ].includes(
        result.status,
      )
    ) {
      throw new Error(
        "Refund outcome requires review",
      );
    }

    await transaction(
      async (session) => {
        const current =
          await Order.findById(
            order._id,
          ).session(session);

        if (
          !current ||
          current.refund.status ===
            "refunded" ||
          current.refund.submissionKey !==
            claim.order.refund.submissionKey
        ) {
          return;
        }

        if (
          current.refund.reference &&
          current.refund.reference !==
            result.id
        ) {
          throw new Error(
            "Refund reference changed",
          );
        }

        current.refund.reference =
          result.id;

        current.refund.submissionState =
          "submitted";

        current.refund.status =
          result.status ===
          "processed"
            ? "refunded"
            : "pending";

        if (
          result.status ===
          "processed"
        ) {
          current.refund.refundedAt =
            new Date();

          Object.assign(
            current.payment,
            {
              status:
                "refunded",

              amountPaid:
                0,

              grossCollected:
                amount / 100,

              refundedAmount:
                amount / 100,

              amountsReconciled:
                true,
            },
          );
        }

        audit(
          current,

          result.status ===
          "processed"
            ? "refund-completed"
            : "refund-requested",

          `Razorpay refund ${result.id} is ${result.status}.`,
        );

        await current.save({
          session,
        });
      },
    );
  } catch (error) {
    logFailure(
      error,
      "stock-refund-reconciliation",
    );

    await transaction(
      async (session) => {
        const current =
          await Order.findById(
            order._id,
          ).session(session);

        if (
          !current ||
          current.refund.status ===
            "refunded" ||
          current.refund.reference ||
          current.refund.submissionKey !==
            claim.order.refund.submissionKey
        ) {
          return;
        }

        current.refund.status =
          "manual-required";

        current.refund.submissionState =
          "uncertain";

        audit(
          current,
          "refund-manual-required",
          "Refund outcome needs provider review. Do not send another refund without checking it.",
        );

        await current.save({
          session,
        });
      },
    );
  }

  return Order.findById(
    order._id,
  );
}

async function finalizeCapturedPayment(
  orderId,
  payment,
) {
  const initial =
    await Order.findById(
      orderId,
    );

  checkPayment(
    initial,
    payment,
  );

  if (
    payment.status !== "captured" ||
    gatewayAmount(
      payment.amount_refunded ?? 0,
      true,
    ) > 0
  ) {
    throw problem(
      409,
      "This payment is not eligible for confirmation. Check My orders.",
      "PAYMENT_REFUND_REVIEW",
    );
  }

  let result;

  try {
    result =
      await transaction(
        async (session) => {
          const current =
            await Order.findById(
              orderId,
            ).session(session);

          checkPayment(
            current,
            payment,
          );

          if (
            refunding(current) ||
            paidOrder(current)
          ) {
            return current;
          }

          if (
            current.status !==
            "payment-pending"
          ) {
            throw problem(
              409,
              "This order needs manual confirmation. Do not pay again.",
            );
          }

          if (
            current.metadata
              ?.inventoryReserved !== true
          ) {
            const touched =
              new Map();

            for (
              const item of
              current.items
            ) {
              if (
                !Number.isSafeInteger(
                  item.quantity,
                ) ||
                item.quantity < 1
              ) {
                throw problem(
                  409,
                  "Purchased quantities need review.",
                );
              }

              const id =
                String(
                  item.product,
                );

              let product =
                touched.get(id);

              if (!product) {
                product =
                  await Product.findById(
                    item.product,
                  ).session(session);
              }

              if (
                !product ||
                product.isActive === false ||
                getVariantStock(
                  product,
                  item.selectedSize,
                  item.selectedColor,
                ) < item.quantity
              ) {
                throw problem(
                  409,
                  "Stock changed after payment.",
                  "PAID_STOCK_UNAVAILABLE",
                );
              }

              reserveVariantStock(
                product,
                item.quantity,
                item.selectedSize,
                item.selectedColor,
              );

              touched.set(
                id,
                product,
              );
            }

            for (
              const product of
              touched.values()
            ) {
              await product.save({
                session,
              });
            }

            current.metadata
              .inventoryReserved = true;
          }

          recordPayment(
            current,
            payment,
          );

          current.status =
            "confirmed";

          if (
            current.kitSnapshots?.length &&
            !current.fulfillmentProgress
          ) {
            current.fulfillmentProgress =
              initializeKitFulfillment(
                current,
              );
          }

          audit(
            current,
            "confirmed",

            current.payment.method ===
            "cod-partial"
              ? `10% COD advance received. Remaining ₹${current.payment.amountDue} is due on delivery.`
              : "Online payment verified. Order confirmed by GymDrobe.",
          );

          await current.save({
            session,
          });

          return current;
        },
      );
  } catch (error) {
    if (
      error.code !==
      "PAID_STOCK_UNAVAILABLE"
    ) {
      throw error;
    }

    result =
      await transaction(
        async (session) => {
          const current =
            await Order.findById(
              orderId,
            ).session(session);

          checkPayment(
            current,
            payment,
          );

          if (
            refunding(current) ||
            paidOrder(current) ||
            current.metadata
              ?.inventoryReserved === true
          ) {
            return current;
          }

          if (
            current.status !==
            "payment-pending"
          ) {
            throw problem(
              409,
              "This paid order needs inventory review.",
            );
          }

          recordPayment(
            current,
            payment,
          );

          current.status =
            "cancelled";

          current.payment.amountDue =
            0;

          current.payment.balanceStatus =
            "not-applicable";

          current.delivery.status =
            "cancelled";

          Object.assign(
            current.cancellation,
            {
              status:
                "cancelled",

              reason:
                "Product stock changed after online payment.",

              cancelledAt:
                new Date(),
            },
          );

          audit(
            current,
            "cancelled",
            "Payment received, but items could not be reserved. Cancellation refund requires confirmation.",
          );

          await current.save({
            session,
          });

          return current;
        },
      );
  }

  if (
    result.status ===
    "cancelled"
  ) {
    result =
      await refundCancelled(
        result,
        payment,
      );
  }

  return result;
}

async function verifyRazorpayPayment(
  req,
  res,
) {
  res.set(
    "Cache-Control",
    "no-store",
  );

  let captured =
    false;

  try {
    const owner =
      customerOwner(req);

    const access =
      customerFilter(req);

    const body =
      bodyOf(req);

    const checkoutToken =
      text(
        body.checkoutToken,
        "Checkout token",
        200,
        1,
      );

    const orderId =
      text(
        body.razorpay_order_id,
        "Razorpay order ID",
        100,
        1,
      );

    const paymentId =
      text(
        body.razorpay_payment_id,
        "Razorpay payment ID",
        100,
        1,
      );

    const signature =
      text(
        body.razorpay_signature,
        "Payment signature",
        64,
        64,
      );

    if (
      !providerId(
        orderId,
        "order",
      ) ||
      !providerId(
        paymentId,
        "pay",
      ) ||
      !/^[a-f0-9]{64}$/i.test(
        signature,
      )
    ) {
      throw problem(
        400,
        "Incomplete or invalid Razorpay payment details.",
      );
    }

    const order =
      await Order.findOne({
        ...access,
        checkoutToken,
      });

    if (
      !order ||
      order.payment.razorpayOrderId !==
        orderId
    ) {
      throw problem(
        404,
        "Payment order was not found for your account.",
      );
    }

    const config =
      configuration();

    const expected =
      crypto
        .createHmac(
          "sha256",
          config.secret,
        )
        .update(
          `${order.payment.razorpayOrderId}|${paymentId}`,
        )
        .digest();

    if (
      !crypto.timingSafeEqual(
        expected,
        Buffer.from(
          signature,
          "hex",
        ),
      )
    ) {
      throw problem(
        400,
        "Payment verification failed.",
        "PAYMENT_SIGNATURE_INVALID",
      );
    }

    let payment =
      await gatewayCall(
        () =>
          config.client.payments.fetch(
            paymentId,
          ),
      );

    checkPayment(
      order,
      payment,
    );

    if (
      payment.status ===
      "authorized"
    ) {
      try {
        await gatewayCall(
          () =>
            config.client.payments.capture(
              paymentId,
              payable(order),
              "INR",
            ),
        );
      } catch {
        // Fetch the actual provider state after an uncertain capture.
      }

      payment =
        await gatewayCall(
          () =>
            config.client.payments.fetch(
              paymentId,
            ),
        );

      checkPayment(
        order,
        payment,
      );
    }

    if (
      payment.status === "refunded" ||
      Number(
        payment.amount_refunded || 0,
      ) > 0
    ) {
      const current =
        await Order.findById(
          order._id,
        );

      return res.status(409).json({
        success: false,

        code:
          "PAYMENT_REFUND_REVIEW",

        paymentReceived:
          true,

        message:
          "This payment has a refund recorded. Do not pay again; check My orders for refund progress.",

        order:
          safeOrder(current),
      });
    }

    if (
      payment.status !==
      "captured"
    ) {
      throw problem(
        409,
        "Payment is not confirmed yet. Do not pay again; retry confirmation or check My orders.",
        "PAYMENT_CONFIRMATION_PENDING",

        {
          verificationUncertain: true,
        },
      );
    }

    captured =
      true;

    const saved =
      await finalizeCapturedPayment(
        order._id,
        payment,
      );

    return resultResponse(
      res,
      saved,
    );
  } catch (error) {
    return fail(
      res,
      error,
      true,
      "payment-confirmation",
      captured,
    );
  }
}

module.exports = {
  createRazorpayOrder,
  verifyRazorpayPayment,
  finalizeCapturedPayment,
};