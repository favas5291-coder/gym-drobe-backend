const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Order = require("../models/Order");
const Product = require("../models/Product");

const {
  getRazorpayClient,
  getRazorpayKeyId,
} = require("../config/razorpay");

const {
  getDiscountedPrice,
  getOriginalPrice,
  resolveCoupon,
  calculateOrderPricing,
  roundMoney,
} = require("../utils/orderPricing");

const {
  getVariantStock,
  getVariantSku,
  reserveVariantStock,
} = require("../utils/orderInventory");

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

function problem(status, message, code = "PAYMENT_ERROR") {
  return Object.assign(new Error(message), {
    status,
    code,
  });
}

function text(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function paise(value) {
  const amount = Math.round(Number(value) * 100);

  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw problem(400, "Invalid payment amount.");
  }

  return amount;
}

// COD advance is 10% of merchandise after coupons.
// Delivery charges remain in the balance due on delivery.
function advance(pricing) {
  const amount = roundMoney(
    Number(pricing.totalAfterCoupon) * 0.1,
  );

  return {
    advancePercentage: 10,
    advanceAmount: amount,
    amountDue: roundMoney(
      Math.max(0, pricing.finalTotal - amount),
    ),
  };
}

function payable(order) {
  return order.payment.method === "cod-partial"
    ? advance(order.pricing).advanceAmount
    : roundMoney(order.pricing.finalTotal);
}

function safeOrder(order) {
  const value = order.toObject
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

    user: {
      id: String(value.user),
    },

    customer: value.customer,
    shippingAddress: value.shippingAddress,

    items: (value.items || []).map((item) => ({
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
    })),

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
      ...value.metadata,
      checkoutToken: value.checkoutToken,
    },
  };
}

// Log diagnostic identifiers without logging credentials,
// authentication tokens, request bodies or customer details.
function logPaymentFailure(error, stage) {
  const reference = crypto.randomBytes(8).toString("hex");

  const safeName = (value) =>
    typeof value === "string" &&
    /^[a-zA-Z0-9_.-]{1,100}$/.test(value)
      ? value
      : "unknown";

  console.error("GymDrobe payment error", {
    reference,
    stage,
    name: safeName(error?.name),

    code: Number.isSafeInteger(error?.code)
      ? error.code
      : safeName(error?.code),

    databaseState: mongoose.connection.readyState,

    validationFields: Object.keys(error?.errors || {})
      .filter((field) =>
        /^[a-zA-Z0-9_.-]{1,100}$/.test(field),
      )
      .slice(0, 20),

    duplicateFields: Object.keys(
      error?.keyPattern || {},
    ).filter((field) =>
      /^[a-zA-Z0-9_.-]{1,100}$/.test(field),
    ),

    stack: String(error?.stack || "")
      .split("\n")
      .filter((line) => /^\s*at /.test(line))
      .slice(0, 5),
  });

  return reference;
}

function fail(
  res,
  error,
  verification = false,
  stage = "payment-confirmation",
) {
  const reference = logPaymentFailure(error, stage);
  const explicitStatus = Number(error?.status);

  const knownError =
    Number.isInteger(explicitStatus) &&
    explicitStatus >= 400 &&
    explicitStatus <= 599;

  let status = knownError ? explicitStatus : 503;

  let code = knownError
    ? error.code || "PAYMENT_ERROR"
    : "PAYMENT_UNAVAILABLE";

  let message = knownError
    ? error.message
    : "Payment could not be started.";

  if (!knownError && verification) {
    message =
      "Payment confirmation was interrupted. Do not pay again; check My orders or contact support.";
  } else if (
    !knownError &&
    error?.name === "ValidationError"
  ) {
    status = 500;
    code = "ORDER_VALIDATION_FAILED";
    message =
      "Your order could not be saved. Contact support with the error reference.";
  } else if (!knownError && error?.code === 11000) {
    status = 409;
    code = "ORDER_CONFLICT";
    message =
      "An order conflict occurred. Check My orders before trying again.";
  } else if (
    !knownError &&
    [
      "MongoServerSelectionError",
      "MongooseServerSelectionError",
      "MongoNetworkError",
      "MongoNetworkTimeoutError",
    ].includes(error?.name)
  ) {
    code = "PAYMENT_DATABASE_UNAVAILABLE";
    message =
      "The order database is temporarily unavailable. Please try again later.";
  } else if (!knownError && !verification) {
    message =
      "Payment could not be started. Contact support with the error reference.";
  }

  res.set("Cache-Control", "no-store");
  res.set("X-GymDrobe-Error-Reference", reference);

  return res.status(status).json({
    success: false,
    code,
    message,
    errorReference: reference,

    ...(verification && !knownError
      ? { verificationUncertain: true }
      : {}),
  });
}

function address(value = {}) {
  const result = {
    fullName: text(value.fullName || value.name, 100),
    email: text(value.email, 150).toLowerCase(),
    phone: text(value.phone, 20).replace(/\D/g, ""),

    addressLine: text(
      value.addressLine || value.address,
      200,
    ),

    landmark: text(value.landmark, 150),
    city: text(value.city, 100),
    state: text(value.state, 100),
    pincode: text(value.pincode, 10).replace(/\D/g, ""),
    label: text(value.label || "Home", 30),
  };

  if (result.fullName.length < 2) {
    throw problem(400, "Enter your full name.");
  }

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)
  ) {
    throw problem(400, "Enter a valid email.");
  }

  if (!/^[6-9]\d{9}$/.test(result.phone)) {
    throw problem(
      400,
      "Enter a valid 10-digit Indian mobile number.",
    );
  }

  if (result.addressLine.length < 5) {
    throw problem(
      400,
      "Enter your house number and street.",
    );
  }

  if (!result.city || !result.state) {
    throw problem(400, "Enter your city and state.");
  }

  if (!/^[1-9]\d{5}$/.test(result.pincode)) {
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
  if (mongoose.Types.ObjectId.isValid(id)) {
    const product = await Product.findById(id);
    if (product) return product;
  }

  if (Number.isSafeInteger(Number(id))) {
    const product = await Product.findOne({
      legacyId: Number(id),
    });

    if (product) return product;
  }

  return Product.findOne({
    slug: id.toLowerCase(),
  });
}

async function snapshot(body) {
  if (
    !Array.isArray(body.items) ||
    !body.items.length ||
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
    const id = text(
      raw?.id || raw?.productId || raw?.product,
      100,
    );

    const quantity = Number(raw?.quantity);

    if (
      !id ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 99
    ) {
      throw problem(
        400,
        "Choose a whole-number quantity between 1 and 99.",
      );
    }

    let product = aliases.get(id);

    if (!product) {
      product = await findProduct(id);

      if (!product || product.isActive === false) {
        throw problem(
          409,
          "A product in your bag is no longer available.",
        );
      }

      const canonicalId = String(product._id);

      product = products.get(canonicalId) || product;

      products.set(canonicalId, product);
      aliases.set(id, product);
    }

    const size = product.sizes?.length
      ? text(raw.selectedSize, 50)
      : null;

    const color = product.colors?.length
      ? text(raw.selectedColor, 50)
      : null;

    if (
      getVariantStock(product, size, color) < quantity
    ) {
      throw problem(
        409,
        `${product.name} has insufficient stock for this selection.`,
      );
    }

    const key = JSON.stringify([
      String(product._id),
      size,
      color,
    ]);

    const existing = rows.get(key);

    if (
      existing &&
      existing.quantity + quantity > 99
    ) {
      throw problem(400, "Quantity is too large.");
    }

    if (existing) {
      existing.quantity += quantity;
    } else {
      rows.set(key, {
        product: product._id,
        legacyId: product.legacyId ?? null,
        slug: product.slug || "",
        sku: getVariantSku(product, size, color),
        name: product.name,
        brand: product.brand || "",
        image: product.image || "",
        originalPrice: getOriginalPrice(product),
        price: getDiscountedPrice(product),

        discount: Math.max(
          0,
          Math.min(100, Number(product.discount || 0)),
        ),

        quantity,
        selectedSize: size,
        selectedColor: color,
        returnPolicy: product.returnPolicy || "",
      });
    }

    // Check combined stock using the in-memory document.
    // Stock is not saved until payment is verified.
    reserveVariantStock(
      product,
      quantity,
      size,
      color,
    );
  }

  const items = [...rows.values()];
  const coupon = resolveCoupon(body.coupon);

  const method =
    body.deliveryMethod === "express"
      ? "express"
      : "standard";

  const pricing = calculateOrderPricing({
    cart: items,
    coupon,
    deliveryMethod: method,
  });

  const expected = Number(body.expectedTotal);

  if (
    Number.isFinite(expected) &&
    Math.abs(
      roundMoney(expected) - pricing.finalTotal,
    ) > 0.01
  ) {
    throw problem(
      409,
      "Your order total changed. Review the latest total and try again.",
    );
  }

  return {
    items,
    coupon,
    pricing,
    method,
  };
}

function gatewayResponse(res, order, status = 200) {
  const amount = payable(order);

  return res.status(status).json({
    success: true,
    paymentMethod: order.payment.method,
    keyId: getRazorpayKeyId(),
    razorpayOrderId: order.payment.razorpayOrderId,
    amount: paise(amount),
    amountRupees: amount,
    currency: "INR",
    orderNumber: order.orderNumber,

    paymentSummary: {
      totalAmount: order.pricing.finalTotal,
      amountToPayNow: amount,
      amountDue: roundMoney(
        order.pricing.finalTotal - amount,
      ),
      advancePercentage:
        order.payment.advancePercentage,
      advanceAmount: order.payment.advanceAmount,
    },
  });
}

async function createRazorpayOrder(req, res) {
  let stage = "checkout-validation";

  try {
    const body = req.body || {};
    const user = req.user?._id;

    if (!user) {
      throw problem(
        401,
        "Please sign in again.",
        "AUTHENTICATION_REQUIRED",
      );
    }

    const checkoutToken = text(
      body.checkoutToken,
      200,
    );

    if (!checkoutToken) {
      throw problem(
        400,
        "Checkout token is missing. Refresh checkout and try again.",
      );
    }

    if (
      !["razorpay", "cod-partial"].includes(
        body.paymentMethod,
      )
    ) {
      throw problem(
        400,
        "Choose a valid payment method.",
      );
    }

    stage = "order-lookup";

    let order = await Order.findOne({
      user,
      checkoutToken,
    });

    if (!order) {
      stage = "checkout-address";
      const shippingAddress = address(
        body.shippingAddress,
      );

      stage = "checkout-products-and-stock";
      const current = await snapshot(body);
      const partial = advance(current.pricing);

      if (
        body.paymentMethod === "cod-partial" &&
        partial.advanceAmount < 1
      ) {
        throw problem(
          400,
          "This order amount is too low for COD advance payment.",
        );
      }

      try {
        stage = "order-create";

        order = await Order.create({
          orderNumber: `GD-${Date.now()
            .toString(36)
            .toUpperCase()}-${crypto
            .randomBytes(3)
            .toString("hex")
            .toUpperCase()}`,

          user,
          checkoutToken,

          source: [
            "cart",
            "selection",
            "buy-now",
          ].includes(body.source)
            ? body.source
            : "cart",

          status: "payment-pending",
          giftMessage: text(body.giftMessage, 250),
          orderNote: text(body.orderNote, 300),

          customer: {
            name: shippingAddress.fullName,
            email: shippingAddress.email,
            phone: shippingAddress.phone,
          },

          shippingAddress,
          items: current.items,

          pricing: {
            ...current.pricing,
            currency: "INR",
          },

          coupon: current.coupon || {
            code: null,
            type: null,
            value: null,
            minimum: null,
          },

          payment: {
            method: body.paymentMethod,
            gateway: "razorpay",
            status: "pending",
            totalAmount: current.pricing.finalTotal,
            amountPaid: 0,
            amountDue: current.pricing.finalTotal,

            advancePercentage:
              body.paymentMethod === "cod-partial"
                ? 10
                : 0,

            advanceAmount:
              body.paymentMethod === "cod-partial"
                ? partial.advanceAmount
                : 0,

            balanceStatus:
              body.paymentMethod === "cod-partial"
                ? "pending"
                : "not-applicable",
          },

          paymentMethod: body.paymentMethod,
          deliveryMethod: current.method,

          delivery: {
            method: current.method,
            status: "pending",
            label:
              current.method === "express"
                ? "Express delivery"
                : "Standard delivery",
            estimatedTime: null,
            deliveredAt: null,
          },

          tracking: {
            carrier: null,
            trackingNumber: null,
            estimatedDelivery: null,
            events: [],
          },

          cancellation: {
            status: "not-cancelled",
          },

          returnRequest: {
            status: "not-requested",
          },

          refund: {
            status: "not-requested",
            amount: 0,
          },

          metadata: {
            version: "7.0",
            demo:
              getRazorpayKeyId().startsWith(
                "rzp_test_",
              ),
            inventoryReserved: false,
          },
        });
      } catch (error) {
        if (error.code !== 11000) throw error;

        order = await Order.findOne({
          user,
          checkoutToken,
        });

        if (!order) throw error;
      }
    }

    stage = "existing-order-validation";

    if (
      order.payment.method !== body.paymentMethod
    ) {
      throw problem(
        409,
        "This checkout attempt uses a different payment method. Start a new checkout.",
      );
    }

    if (
      order.status === "cancelled" ||
      REFUNDS.includes(order.refund?.status) ||
      order.payment.status === "refunded"
    ) {
      throw problem(
        409,
        "This order is cancelled or under refund review. Do not pay for it again.",
      );
    }

    if (
      FULFILMENT.includes(order.status) &&
      order.metadata?.inventoryReserved &&
      ["paid", "partially-paid"].includes(
        order.payment.status,
      )
    ) {
      return res.json({
        success: true,
        alreadyPaid: true,
        order: safeOrder(order),
      });
    }

    if (
      order.status !== "payment-pending" ||
      ["paid", "partially-paid"].includes(
        order.payment.status,
      )
    ) {
      throw problem(
        409,
        "This order needs payment confirmation. Do not pay again; check My orders.",
      );
    }

    if (order.payment.razorpayOrderId) {
      return gatewayResponse(res, order);
    }

    const amount = paise(payable(order));

    stage = "razorpay-order-create";

    const gateway =
      await getRazorpayClient().orders.create({
        amount,
        currency: "INR",
        receipt: order.orderNumber.slice(0, 40),

        notes: {
          gymdrobeOrder: order.orderNumber,
          paymentMethod: order.payment.method,
          checkoutToken: checkoutToken.slice(0, 100),
          userId: String(user),
        },
      });

    if (
      !gateway?.id ||
      Number(gateway.amount) !== amount ||
      gateway.currency !== "INR"
    ) {
      throw problem(
        502,
        "Razorpay returned unexpected order details.",
      );
    }

    stage = "razorpay-order-save";

    const saved = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: "payment-pending",
        "payment.razorpayOrderId": null,
        "payment.status": {
          $in: ["pending", "failed"],
        },
        "refund.status": "not-requested",
      },
      {
        $set: {
          "payment.razorpayOrderId": gateway.id,
          "payment.status": "pending",
          "payment.failedAt": null,
        },
      },
      {
        new: true,
      },
    );

    order =
      saved || (await Order.findById(order._id));

    if (
      !order ||
      order.status !== "payment-pending" ||
      !order.payment.razorpayOrderId ||
      REFUNDS.includes(order.refund?.status)
    ) {
      throw problem(
        409,
        "Your order changed while starting payment. Check My orders before paying.",
      );
    }

    return gatewayResponse(
      res,
      order,
      saved ? 201 : 200,
    );
  } catch (error) {
    return fail(res, error, false, stage);
  }
}

function recordPayment(order, payment) {
  const now = new Date();
  const total = roundMoney(
    order.pricing.finalTotal,
  );
  const partial = advance(order.pricing);
  const cod =
    order.payment.method === "cod-partial";

  Object.assign(order.payment, {
    gateway: "razorpay",
    transactionId: payment.id,
    razorpayPaymentId: payment.id,
    verifiedAt: order.payment.verifiedAt || now,
    failedAt: null,
    totalAmount: total,
    status: cod ? "partially-paid" : "paid",
    amountPaid: Number(payment.amount) / 100,
    amountDue: cod ? partial.amountDue : 0,
    advancePercentage: cod ? 10 : 0,
    advanceAmount: cod ? partial.advanceAmount : 0,

    advancePaidAt: cod
      ? order.payment.advancePaidAt || now
      : null,

    balanceStatus: cod
      ? "pending"
      : "not-applicable",

    paidAt: cod
      ? null
      : order.payment.paidAt || now,
  });
}

async function transaction(work) {
  const session = await mongoose.startSession();

  try {
    return await session.withTransaction(
      () => work(session),
    );
  } finally {
    await session.endSession();
  }
}

function checkPayment(order, payment) {
  if (
    !order ||
    !["razorpay", "cod-partial"].includes(
      order.payment?.method,
    )
  ) {
    throw problem(
      404,
      "Payment order was not found.",
    );
  }

  if (
    !payment?.id ||
    payment.order_id !==
      order.payment.razorpayOrderId ||
    Number(payment.amount) !==
      paise(payable(order)) ||
    payment.currency !== "INR"
  ) {
    throw problem(
      400,
      "Payment details do not match this order.",
    );
  }

  if (
    order.payment.verifiedAt &&
    order.payment.razorpayPaymentId &&
    order.payment.razorpayPaymentId !== payment.id
  ) {
    throw problem(
      409,
      "This order has a different verified payment. Contact support.",
    );
  }
}

async function refundCancelled(order, payment) {
  const key =
    `gd-auto-${order._id}-${payment.id}`;

  const claimed = await transaction(
    async (session) => {
      const current = await Order.findById(
        order._id,
      ).session(session);

      checkPayment(current, payment);

      if (
        current.status !== "cancelled" ||
        current.metadata?.inventoryReserved
      ) {
        return current;
      }

      if (
        REFUNDS.includes(current.refund?.status)
      ) {
        return current;
      }

      recordPayment(current, payment);

      current.payment.amountDue = 0;
      current.payment.balanceStatus =
        "not-applicable";

      current.refund.status = "pending";
      current.refund.amount =
        Number(payment.amount) / 100;
      current.refund.reference = key;
      current.refund.requestedAt = new Date();

      await current.save({ session });

      return current;
    },
  );

  if (
    claimed.refund?.status !== "pending" ||
    claimed.refund.reference !== key
  ) {
    return claimed;
  }

  try {
    const keyId = text(getRazorpayKeyId());
    const secret = text(
      process.env.RAZORPAY_KEY_SECRET,
    );

    if (!keyId || !secret) {
      throw new Error(
        "Refund configuration unavailable",
      );
    }

    const response = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(
        payment.id,
      )}/refund`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),

        headers: {
          Authorization:
            `Basic ${Buffer.from(
              `${keyId}:${secret}`,
            ).toString("base64")}`,

          "Content-Type": "application/json",
          "X-Refund-Idempotency": key,
        },

        body: JSON.stringify({
          amount: Number(payment.amount),
          speed: "normal",
        }),
      },
    );

    const refund = await response.json();

    if (
      !response.ok ||
      !refund?.id ||
      refund.payment_id !== payment.id ||
      Number(refund.amount) !==
        Number(payment.amount)
    ) {
      throw new Error(
        "Refund response unavailable",
      );
    }

    const processed =
      refund.status === "processed";

    const changes = {
      "refund.reference": refund.id,

      "refund.status": processed
        ? "refunded"
        : refund.status === "failed"
          ? "manual-required"
          : "pending",
    };

    if (processed) {
      Object.assign(changes, {
        "refund.refundedAt": new Date(),
        "payment.status": "refunded",
        "payment.amountPaid": 0,
      });
    }

    await Order.updateOne(
      {
        _id: claimed._id,
        "refund.status": "pending",
        "refund.reference": key,
      },
      {
        $set: changes,
      },
    );
  } catch {
    // An uncertain refund needs review.
    // Do not automatically issue a second refund.
    await Order.updateOne(
      {
        _id: claimed._id,
        "refund.status": "pending",
        "refund.reference": key,
      },
      {
        $set: {
          "refund.status": "manual-required",
        },
      },
    );
  }

  return Order.findById(claimed._id);
}

async function finalizeCapturedPayment(
  orderId,
  payment,
) {
  const initial = await Order.findById(orderId);

  checkPayment(initial, payment);

  if (
    payment.status !== "captured" ||
    Number(payment.amount_refunded || 0) > 0
  ) {
    throw problem(
      409,
      "This payment is not eligible for order confirmation. Check My orders or contact support.",
    );
  }

  let result;

  try {
    result = await transaction(
      async (session) => {
        const current = await Order.findById(
          orderId,
        ).session(session);

        checkPayment(current, payment);

        if (
          current.status === "cancelled" ||
          REFUNDS.includes(
            current.refund?.status,
          ) ||
          current.payment.status === "refunded"
        ) {
          return current;
        }

        if (
          FULFILMENT.includes(current.status) &&
          current.metadata?.inventoryReserved
        ) {
          return current;
        }

        if (
          current.status !== "payment-pending"
        ) {
          throw problem(
            409,
            "This order needs manual confirmation. Do not pay again.",
          );
        }

        if (
          !current.metadata.inventoryReserved
        ) {
          const touched = new Map();

          for (const item of current.items) {
            const id = String(item.product);
            let product = touched.get(id);

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

            touched.set(id, product);
          }

          for (const product of touched.values()) {
            await product.save({ session });
          }

          current.metadata.inventoryReserved =
            true;
        }

        recordPayment(current, payment);
        current.status = "confirmed";

        if (
          !current.tracking.events.some(
            (event) =>
              event.status === "confirmed",
          )
        ) {
          current.tracking.events.push({
            status: "confirmed",

            description:
              current.payment.method ===
              "cod-partial"
                ? `10% COD advance paid online. Remaining ₹${current.payment.amountDue} is due on delivery.`
                : "Online payment verified. Order confirmed by GymDrobe.",

            timestamp: new Date(),
          });
        }

        await current.save({ session });

        return current;
      },
    );
  } catch (error) {
    if (
      error.code !== "PAID_STOCK_UNAVAILABLE"
    ) {
      throw error;
    }

    result = await transaction(
      async (session) => {
        const current = await Order.findById(
          orderId,
        ).session(session);

        checkPayment(current, payment);

        if (
          current.metadata?.inventoryReserved ||
          FULFILMENT.includes(current.status)
        ) {
          return current;
        }

        if (
          current.status === "payment-pending"
        ) {
          recordPayment(current, payment);

          current.status = "cancelled";
          current.payment.amountDue = 0;
          current.payment.balanceStatus =
            "not-applicable";

          current.cancellation.status =
            "cancelled";

          current.cancellation.reason =
            "Product stock changed after online payment.";

          current.cancellation.cancelledAt =
            new Date();

          await current.save({ session });
        }

        return current;
      },
    );
  }

  if (result.status === "cancelled") {
    result = await refundCancelled(
      result,
      payment,
    );
  }

  return result;
}

async function verifyRazorpayPayment(req, res) {
  let captured = false;

  try {
    const body = req.body || {};

    const checkoutToken = text(
      body.checkoutToken,
      200,
    );

    const orderId = text(
      body.razorpay_order_id,
      200,
    );

    const paymentId = text(
      body.razorpay_payment_id,
      200,
    );

    const signature = text(
      body.razorpay_signature,
      500,
    );

    if (
      !checkoutToken ||
      !orderId ||
      !paymentId ||
      !/^[a-f0-9]{64}$/i.test(signature)
    ) {
      throw problem(
        400,
        "Incomplete or invalid Razorpay payment details.",
      );
    }

    const order = await Order.findOne({
      user: req.user._id,
      checkoutToken,
    });

    if (
      !order ||
      order.payment.razorpayOrderId !== orderId
    ) {
      throw problem(
        400,
        "Razorpay order does not match this checkout.",
      );
    }

    const secret = text(
      process.env.RAZORPAY_KEY_SECRET,
    );

    if (!secret) {
      throw new Error(
        "Payment configuration unavailable",
      );
    }

    const expected = crypto
      .createHmac("sha256", secret)
      .update(
        `${order.payment.razorpayOrderId}|${paymentId}`,
      )
      .digest();

    if (
      !crypto.timingSafeEqual(
        expected,
        Buffer.from(signature, "hex"),
      )
    ) {
      throw problem(
        400,
        "Payment verification failed.",
      );
    }

    const client = getRazorpayClient();
    let payment =
      await client.payments.fetch(paymentId);

    checkPayment(order, payment);

    if (payment.status === "authorized") {
      try {
        payment = await client.payments.capture(
          paymentId,
          paise(payable(order)),
          "INR",
        );
      } catch {
        payment =
          await client.payments.fetch(paymentId);
      }
    }

    if (payment.status === "refunded") {
      throw problem(
        409,
        "This payment has already been refunded. Check My orders.",
      );
    }

    if (payment.status !== "captured") {
      throw problem(
        409,
        "Payment is not captured yet. Check My orders before paying again.",
      );
    }

    captured = true;

    const saved = await finalizeCapturedPayment(
      order._id,
      payment,
    );

    if (
      saved.status === "cancelled" ||
      REFUNDS.includes(saved.refund?.status)
    ) {
      return res.status(409).json({
        success: false,
        code: "PAYMENT_REFUND_REVIEW",
        paymentReceived: true,

        refundStarted:
          saved.refund.status === "refunded" ||
          (
            saved.refund.status === "pending" &&
            saved.refund.reference.startsWith(
              "rfnd_",
            )
          ),

        message:
          "Your payment was received, but this order cannot be fulfilled. Do not pay again. Check My orders for the refund status or contact support.",

        order: safeOrder(saved),
      });
    }

    return res.json({
      success: true,
      paymentVerified: true,
      paymentMethod: saved.payment.method,

      paymentSummary: {
        totalAmount: saved.payment.totalAmount,
        amountPaid: saved.payment.amountPaid,
        amountDue: saved.payment.amountDue,
        advancePercentage:
          saved.payment.advancePercentage,
        advanceAmount:
          saved.payment.advanceAmount,
        balanceStatus:
          saved.payment.balanceStatus,
      },

      order: safeOrder(saved),
    });
  } catch (error) {
    if (captured && !error.status) {
      const reference = logPaymentFailure(
        error,
        "captured-payment-confirmation",
      );

      res.set("Cache-Control", "no-store");

      return res.status(503).json({
        success: false,
        paymentReceived: true,
        retryVerification: true,
        errorReference: reference,

        message:
          "Your payment was received, but confirmation was interrupted. Do not pay again. Please retry confirmation or check My orders.",
      });
    }

    return fail(res, error, true);
  }
}

module.exports = {
  createRazorpayOrder,
  verifyRazorpayPayment,
  finalizeCapturedPayment,
};