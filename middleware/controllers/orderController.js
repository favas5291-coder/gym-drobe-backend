const {
  customerFilter,
} = require("../../utils/customerAccess");

const {
  collectedKitCodPaise,
  applyKitFulfillmentAction,
} = require("../../utils/kitFulfillmentProgress");

const {
  adminKitFulfillmentFields,
  publicKitItemFields,
  publicKitOrderFields,
} = require("../../utils/publicKitOrder");

const {
  calculateItemRefundPaise,
} = require("../../utils/orderRefundAllocation");

const {
  withAdminSourcing,
} = require("../../utils/orderSourcing");

const {
  parseTrackingExtras,
  applyTrackingExtras,
} = require("../../utils/trackingUpdates");

const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Order = require("../../models/Order");
const Product = require("../../models/Product");

const {
  getVariantStock,
  reserveVariantStock,
  restoreVariantStock,
} = require("../../utils/orderInventory");

const FLOW = [
  "confirmed",
  "processing",
  "shipped",
  "out-for-delivery",
  "delivered",
];

const RETURNS = [
  "requested",
  "approved",
  "rejected",
  "completed",
];

function problem(
  status,
  message,
  code = "ORDER_REQUEST_FAILED",
  details = {},
) {
  return Object.assign(new Error(message), {
    status,
    code,
    details,
  });
}

function inputText(
  value,
  name,
  maximum,
  minimum = 0,
  multiline = false,
) {
  if (typeof value !== "string") {
    throw problem(
      400,
      `${name} must be text.`,
      "INVALID_ORDER_DATA",
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
      `${name} must contain ${minimum}–${maximum} characters.`,
      "INVALID_ORDER_DATA",
    );
  }

  return result;
}

function bodyOf(req) {
  const body = req.body ?? {};

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw problem(
      400,
      "Send valid order information.",
      "INVALID_ORDER_DATA",
    );
  }

  return body;
}

function orderId(req) {
  return inputText(
    req.params?.id,
    "Order ID",
    150,
    1,
  );
}

function lookup(id) {
  const conditions = [
    { orderNumber: id },
  ];

  if (mongoose.isObjectIdOrHexString(id)) {
    conditions.push({ _id: id });
  }

  return { $or: conditions };
}

function own(object, field) {
  return Object.prototype.hasOwnProperty.call(
    object,
    field,
  );
}

function handler(action, admin = false) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");

    if (
      !req.user?._id &&
      !req.guestSession?._id
    ) {
      return res.status(401).json({
        success: false,
        code: "AUTHENTICATION_REQUIRED",
        message: "Please sign in again.",
      });
    }

    if (req.user?.isActive === false) {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_DISABLED",

        message:
          "This account is disabled. Contact support.",
      });
    }

    if (
      admin &&
      req.user?.role !== "admin"
    ) {
      return res.status(403).json({
        success: false,
        code: "ADMIN_REQUIRED",

        message:
          "Administrator access is required.",
      });
    }

    try {
      return await action(req, res);
    } catch (error) {
      const conflict = [
        "VersionError",
        "DocumentNotFoundError",
      ].includes(error.name);

      const validation = [
        "ValidationError",
        "CastError",
      ].includes(error.name);

      const status = conflict
        ? 409
        : error.status ||
          (validation ? 400 : 503);

      if (status >= 500) {
        console.error(
          "Order operation failed:",
          error.name || "Error",
        );
      }

      return res.status(status).json({
        success: false,

        code: conflict
          ? "ORDER_CHANGED"
          : error.code ||
            (
              validation
                ? "INVALID_ORDER_DATA"
                : "ORDER_SERVICE_UNAVAILABLE"
            ),

        message: conflict
          ? "The order changed. Reload it before trying again."
          : error.status
            ? error.message
            : validation
              ? "The order contains invalid information. Check it before retrying."
              : "The order service could not confirm this request. Reload the order before retrying.",

        ...(error.details || {}),
      });
    }
  };
}

async function transaction(action) {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      result = await action(session);
    });

    return result;
  } finally {
    await session.endSession();
  }
}

async function loadOrder(
  id,
  session,
  userId,
) {
  // Keep order lookup and ownership in separate $and clauses.
  // Both filters can contain their own $or safely.
  const query = {
    $and: [
      lookup(id),

      ...(userId
        ? [
            typeof userId === "object" &&
            !userId._bsontype
              ? userId
              : { user: userId },
          ]
        : []),
    ],
  };

  let request = Order.findOne(query);

  if (session) {
    request = request.session(session);
  }

  const order = await request;

  if (!order) {
    throw problem(
      404,
      "Order not found.",
      "ORDER_NOT_FOUND",
    );
  }

  return order;
}

function event(
  order,
  status,
  description,
  timestamp = new Date(),
) {
  if (!order.tracking) {
    order.tracking = {};
  }

  if (
    !Array.isArray(order.tracking.events)
  ) {
    order.tracking.events = [];
  }

  order.tracking.events.push({
    status,
    description,
    timestamp,
  });
}

function safeOrder(order) {
  const value =
    typeof order.toObject === "function"
      ? order.toObject()
      : order;

  const raw = value.user;

  const populated =
    raw &&
    typeof raw === "object" &&
    raw._id;

  const user = {
    id: String(
      populated
        ? raw._id
        : raw || "",
    ),
  };

  if (populated) {
    for (const field of [
      "name",
      "email",
      "phone",
      "role",
    ]) {
      if (raw[field]) {
        user[field] = raw[field];
      }
    }
  }

  return {
    id:
      value.orderNumber ||
      String(value._id || ""),

    orderNumber: value.orderNumber,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: value.status,
    source: value.source,

    giftMessage: value.giftMessage || "",
    orderNote: value.orderNote || "",

    user: value.user ? user : null,
    isGuestOrder: Boolean(order.guestSession),

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
      returnsEligible: item.returnsEligible,
      returnConditions: item.returnConditions,
      returnWindowDays: item.returnWindowDays,

      ...publicKitItemFields(item),
    })),

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

      checkoutToken: value.checkoutToken,
    },
  };
}

function cents(value, name) {
  if (
    !["number", "string"].includes(typeof value) ||
    !String(value).trim()
  ) {
    throw problem(
      409,
      `${name} is missing. Reconcile the payment records first.`,
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  const amount = Number(value);
  const parsed = Math.round(amount * 100);

  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(parsed) ||
    Math.abs(amount * 100 - parsed) > 0.000001
  ) {
    throw problem(
      409,
      `${name} is invalid. Reconcile the payment records first.`,
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  return parsed;
}

function numberOf(
  value,
  name,
  minimum = 0,
) {
  const number = Number(value);

  if (
    !["number", "string"].includes(typeof value) ||
    !String(value).trim() ||
    !Number.isSafeInteger(number) ||
    number < minimum
  ) {
    throw problem(
      400,
      `Enter a valid whole-number ${name}.`,
      "INVALID_ORDER_DATA",
    );
  }

  return number;
}

function methodOf(order) {
  const method =
    order.payment?.method ||
    order.paymentMethod;

  if (
    !order.payment ||
    ![
      "razorpay",
      "cod-partial",
      "cod",
    ].includes(method) ||
    (
      order.paymentMethod &&
      order.paymentMethod !== method
    )
  ) {
    throw problem(
      409,
      "The payment method is inconsistent. Reconcile the order first.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  return method;
}

// Supports older records whose return refund left
// amountPaid unchanged.
function ledger(order) {
  const payment = order.payment || {};

  const paid = cents(
    payment.amountPaid,
    "Amount paid",
  );

  const completed =
    order.refund?.status === "refunded"
      ? cents(
          order.refund.amount,
          "Completed refund",
        )
      : 0;

  if (payment.amountsReconciled === true) {
    const gross = cents(
      payment.grossCollected,
      "Money collected",
    );

    const refunded = cents(
      payment.refundedAmount,
      "Money refunded",
    );

    if (
      !Number.isSafeInteger(paid + refunded) ||
      gross !== paid + refunded ||
      completed > refunded
    ) {
      throw problem(
        409,
        "Collected, retained and refunded amounts do not match.",
        "PAYMENT_RECONCILIATION_REQUIRED",
      );
    }

    return {
      gross,
      refunded,
      retained: paid,
    };
  }

  if (payment.status === "refunded") {
    if (
      paid !== 0 ||
      completed <= 0
    ) {
      throw problem(
        409,
        "The completed refund needs reconciliation.",
        "PAYMENT_RECONCILIATION_REQUIRED",
      );
    }

    return {
      gross: completed,
      refunded: completed,
      retained: 0,
    };
  }

  if (completed > paid) {
    throw problem(
      409,
      "The recorded refund exceeds money collected.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  return {
    gross: paid,
    refunded: completed,
    retained: paid - completed,
  };
}

function paymentState(
  order,
  fullyPaid = false,
) {
  const method = methodOf(order);

  if (
    (order.pricing?.currency || "INR") !== "INR"
  ) {
    throw problem(
      409,
      "This order currency needs payment reconciliation.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  const total = cents(
    order.pricing?.finalTotal,
    "Order total",
  );

  const paymentTotal = cents(
    order.payment.totalAmount,
    "Payment total",
  );

  const due = cents(
    order.payment.amountDue,
    "Balance due",
  );

  const amounts = ledger(order);

  const merchandise = cents(
    order.pricing?.totalAfterCoupon,
    "Item total after coupon",
  );

  const shipping = cents(
    order.pricing?.shipping,
    "Delivery charge",
  );

  if (
    !Number.isSafeInteger(merchandise + shipping) ||
    merchandise + shipping !== total ||
    total <= 0 ||
    paymentTotal !== total ||
    amounts.gross + due !== total ||
    amounts.refunded > 0
  ) {
    throw problem(
      409,
      "The order and payment amounts need reconciliation before this action.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  const paid =
    order.payment.status === "paid" &&
    due === 0 &&
    amounts.gross === total;

  const verified = Boolean(
    order.payment.verifiedAt &&
    (
      order.payment.razorpayPaymentId ||
      order.payment.transactionId
    ),
  );

  if (
    method === "razorpay" &&
    (!paid || !verified)
  ) {
    throw problem(
      409,
      "Online payment has not been verified as completed.",
      "PAYMENT_NOT_VERIFIED",
    );
  }

  if (method === "cod-partial") {
    const advance = cents(
      order.payment.advanceAmount,
      "COD advance",
    );

    const expectedAdvance = Math.round(
      merchandise / 10,
    );

    if (
      advance <= 0 ||
      advance !== expectedAdvance ||
      advance > total ||
      (
        due > 0 &&
        amounts.gross !==
          advance +
            (
              order.shippingSnapshot
                ? collectedKitCodPaise(order)
                : 0
            )
      ) ||
      !verified ||
      !["paid", "partially-paid"].includes(
        order.payment.status,
      ) ||
      (
        due > 0 &&
        order.payment.balanceStatus !== "pending"
      ) ||
      (
        due === 0 &&
        (
          !paid ||
          ![
            "collected",
            "not-applicable",
          ].includes(
            order.payment.balanceStatus,
          )
        )
      )
    ) {
      throw problem(
        409,
        "The verified COD advance and remaining balance need reconciliation.",
        "PAYMENT_RECONCILIATION_REQUIRED",
      );
    }
  }

  if (
    method === "cod" &&
    !["pending", "paid"].includes(
      order.payment.status,
    )
  ) {
    throw problem(
      409,
      "The legacy COD payment needs reconciliation.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  if (fullyPaid && !paid) {
    throw problem(
      409,
      "Confirm and reconcile the full payment before processing this request.",
      "PAYMENT_NOT_COMPLETED",
    );
  }

  return {
    method,
    total,
    due,
    ...amounts,
  };
}

function recordRefund(
  order,
  amount,
  reference,
  now,
) {
  const amounts = ledger(order);

  if (
    amount <= 0 ||
    amount > amounts.retained
  ) {
    throw problem(
      409,
      "The refund exceeds the recorded money available to refund.",
      "REFUND_AMOUNT_INVALID",
    );
  }

  const refunded = amounts.refunded + amount;

  order.payment.grossCollected =
    amounts.gross / 100;

  order.payment.refundedAmount =
    refunded / 100;

  order.payment.amountsReconciled = true;

  order.payment.amountPaid =
    (amounts.gross - refunded) / 100;

  order.payment.status =
    refunded === amounts.gross
      ? "refunded"
      : "partially-refunded";

  order.refund.status = "refunded";
  order.refund.reference = reference;
  order.refund.refundedAt = now;
}

async function inventoryProduct(
  item,
  session,
  cache,
) {
  const key = String(item.product);

  if (!cache.has(key)) {
    const product =
      await Product.findById(item.product)
        .session(session);

    if (!product) {
      throw problem(
        409,
        `${item.name}: the inventory product no longer exists. Contact support.`,
        "INVENTORY_UNAVAILABLE",
      );
    }

    cache.set(key, product);
  }

  return cache.get(key);
}

function restorePurchasedStock(
  product,
  item,
  quantity,
) {
  try {
    restoreVariantStock(
      product,
      quantity,
      item.selectedSize,
      item.selectedColor,
    );
  } catch {
    throw problem(
      409,
      `${item.name}: the original stock variant needs an admin correction before restoration.`,
      "INVENTORY_RECONCILIATION_REQUIRED",
    );
  }
}

async function saveProducts(cache, session) {
  for (const product of cache.values()) {
    await product.save({ session });
  }
}

function storedReturnRows(order) {
  const rows = order.returnRequest?.items;

  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 50
  ) {
    throw problem(
      409,
      "The recorded return items need review.",
      "RETURN_ITEMS_INVALID",
    );
  }

  const seen = new Set();

  return rows.map((row) => {
    const index = numberOf(
      row.index,
      "item index",
    );

    const quantity = numberOf(
      row.quantity,
      "quantity",
      1,
    );

    const item = order.items?.[index];

    if (
      !item ||
      seen.has(index) ||
      quantity > item.quantity
    ) {
      throw problem(
        409,
        "The recorded return quantities need review.",
        "RETURN_ITEMS_INVALID",
      );
    }

    seen.add(index);

    return {
      index,
      quantity,
      size: row.size ?? null,
      color: row.color ?? null,
    };
  });
}

function returnRefundCents(order, rows) {
  return calculateItemRefundPaise(
    order,
    rows.map((row) => ({
      index: row.index,
      quantity: row.quantity,
    })),
    "quantity",
  );
}

function blankRefund() {
  return {
    status: "not-requested",
    amount: 0,
    reference: "",
    requestedAt: null,
    refundedAt: null,
    submissionState: "not-started",
    submissionKey: "",
    submissionStartedAt: null,
  };
}

function deliveryTime(order) {
  const events = Array.isArray(
    order.tracking?.events,
  )
    ? order.tracking.events
    : [];

  const value =
    order.delivery?.deliveredAt ||
    [...events]
      .reverse()
      .find(
        (row) => row.status === "delivered",
      )?.timestamp;

  const time = new Date(
    value || "invalid",
  ).getTime();

  if (
    !Number.isFinite(time) ||
    time > Date.now()
  ) {
    throw problem(
      409,
      "Contact support to confirm the delivery date and return eligibility.",
      "DELIVERY_DATE_UNCONFIRMED",
    );
  }

  return time;
}

function validateEligibility(order, rows) {
  const delivered = deliveryTime(order);

  for (const row of rows) {
    const item = order.items[row.index];
    const days = item.returnWindowDays ?? 7;

    if (
      !Number.isInteger(days) ||
      days < 1 ||
      days > 7
    ) {
      throw problem(
        409,
        `${item.name}: the return window needs review.`,
        "RETURN_POLICY_UNCONFIRMED",
      );
    }

    if (item.returnsEligible === "no") {
      throw problem(
        409,
        `${item.name}: this purchase is not eligible for a standard return or exchange. Contact support for help.`,
        "ITEM_NOT_RETURNABLE",
      );
    }

    if (
      Date.now() >
      delivered + days * 86400000
    ) {
      throw problem(
        409,
        `${item.name}: the ${days}-day request window has ended. Contact support for help.`,
        "RETURN_WINDOW_ENDED",
      );
    }
  }
}

async function reserveReplacements(
  order,
  rows,
  session,
  cache,
) {
  for (const row of rows) {
    const item = order.items[row.index];

    const product = await inventoryProduct(
      item,
      session,
      cache,
    );

    if (
      product.isActive === false ||
      product.delivery?.available === false
    ) {
      throw problem(
        409,
        `${item.name}: this replacement is unavailable.`,
        "REPLACEMENT_UNAVAILABLE",
      );
    }

    if (
      (row.size ?? null) ===
        (item.selectedSize ?? null) &&
      (row.color ?? null) ===
        (item.selectedColor ?? null)
    ) {
      throw problem(
        409,
        "Choose a different available variant for the exchange.",
        "UNCHANGED_EXCHANGE_VARIANT",
      );
    }

    if (
      getVariantStock(
        product,
        row.size,
        row.color,
      ) < row.quantity
    ) {
      throw problem(
        409,
        `${item.name}: not enough stock for the requested replacement.`,
        "REPLACEMENT_OUT_OF_STOCK",
      );
    }

    reserveVariantStock(
      product,
      row.quantity,
      row.size,
      row.color,
    );
  }
}

// New orders are created by paymentController.
// This endpoint only retrieves an existing checkout.
const createOrder = handler(
  async (req, res) => {
    const token = inputText(
      bodyOf(req).checkoutToken,
      "Checkout token",
      200,
      1,
    );

    const existing =
      await Order.findOne({
        ...customerFilter(req),
        checkoutToken: token,
      });

    if (!existing) {
      throw problem(
        409,
        "Complete payment through GymDrobe checkout first.",
        "PAYMENT_REQUIRED",
        { paymentRequired: true },
      );
    }

    return res.json({
      success: true,
      existing: true,
      order: safeOrder(existing),
    });
  },
);

const getOrders = handler(
  async (req, res) => {
    const orders = await Order.find(
      customerFilter(req),
    ).sort({
      createdAt: -1,
    });

    return res.json({
      success: true,
      count: orders.length,
      orders: orders.map(safeOrder),
    });
  },
);

const getOrderById = handler(
  async (req, res) => {
    const order = await loadOrder(
      orderId(req),
      null,
      customerFilter(req),
    );

    return res.json({
      success: true,
      order: safeOrder(order),
    });
  },
);

// Gateway requests run after the cancellation transaction.
// An uncertain submission is never automatically sent again.
async function submitCancellationRefund(id) {
  const claim = await transaction(
    async (session) => {
      const order =
        await Order.findById(id)
          .session(session);

      if (
        !order ||
        order.status !== "cancelled" ||
        order.refund?.status !== "pending" ||
        order.refund.reference ||
        (
          order.refund.submissionState &&
          order.refund.submissionState !==
            "not-started"
        )
      ) {
        return null;
      }

      order.refund.submissionState =
        "submitting";

      order.refund.submissionStartedAt =
        new Date();

      order.refund.submissionKey =
        `GD-CANCEL-${crypto
          .createHash("sha256")
          .update(String(id))
          .digest("hex")
          .slice(0, 40)}`;

      await order.save({ session });

      return order;
    },
  );

  if (!claim) {
    return;
  }

  const paymentId =
    claim.payment.razorpayPaymentId ||
    claim.payment.transactionId;

  const amount = cents(
    claim.refund.amount,
    "Cancellation refund",
  );

  let result;

  try {
    if (
      !/^pay_[A-Za-z0-9]+$/.test(
        paymentId || "",
      ) ||
      amount < 100
    ) {
      throw new Error(
        "Refund requires manual review",
      );
    }

    const keyId = String(
      process.env.RAZORPAY_KEY_ID || "",
    ).trim();

    const secret = String(
      process.env.RAZORPAY_KEY_SECRET || "",
    ).trim();

    if (
      !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId) ||
      !secret ||
      typeof claim.metadata?.demo !== "boolean" ||
      claim.metadata.demo !==
        keyId.startsWith("rzp_test_")
    ) {
      throw new Error(
        "Payment service unavailable or mode mismatch",
      );
    }

    const authorization =
      `Basic ${Buffer.from(
        `${keyId}:${secret}`,
      ).toString("base64")}`;

    const paymentResponse = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: authorization,
        },

        signal: AbortSignal.timeout(25000),
      },
    );

    if (!paymentResponse.ok) {
      throw new Error(
        "Payment could not be verified",
      );
    }

    const payment =
      await paymentResponse.json();

    if (
      payment.id !== paymentId ||
      payment.status !== "captured" ||
      payment.currency !== "INR" ||
      Number(payment.amount) !== amount ||
      Number(payment.amount_refunded || 0) !== 0 ||
      (
        claim.payment.razorpayOrderId &&
        payment.order_id !==
          claim.payment.razorpayOrderId
      )
    ) {
      throw new Error(
        "Payment requires reconciliation",
      );
    }

    const response = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        method: "POST",
        signal: AbortSignal.timeout(25000),

        headers: {
          "Content-Type": "application/json",

          "X-Refund-Idempotency":
            claim.refund.submissionKey,

          Authorization: authorization,
        },

        body: JSON.stringify({
          amount,
          speed: "normal",

          notes: {
            reason: "customer_cancellation",
            gymdrobe_order: claim.orderNumber,
          },
        }),
      },
    );

    result = await response.json();

    if (
      !response.ok ||
      typeof result.id !== "string" ||
      !/^rfnd_[A-Za-z0-9]+$/.test(result.id) ||
      result.payment_id !== paymentId ||
      result.currency !== "INR" ||
      Number(result.amount) !== amount ||
      !["pending", "processed"].includes(
        result.status,
      )
    ) {
      throw new Error(
        "Refund outcome requires review",
      );
    }
  } catch {
    await transaction(async (session) => {
      const order =
        await Order.findById(id)
          .session(session);

      if (
        !order ||
        order.refund.status === "refunded" ||
        order.refund.submissionKey !==
          claim.refund.submissionKey ||
        order.refund.reference
      ) {
        return;
      }

      order.refund.status =
        "manual-required";

      order.refund.submissionState =
        "uncertain";

      event(
        order,
        "refund-manual-required",
        "The automatic refund outcome requires payment-provider review. Do not send another refund without checking it.",
      );

      await order.save({ session });
    });

    return;
  }

  await transaction(async (session) => {
    const order =
      await Order.findById(id)
        .session(session);

    if (
      !order ||
      order.refund.status === "refunded" ||
      order.refund.submissionKey !==
        claim.refund.submissionKey
    ) {
      return;
    }

    if (
      order.refund.reference &&
      order.refund.reference !== result.id
    ) {
      throw problem(
        409,
        "The refund reference changed. Reconcile it with the payment provider.",
        "REFUND_CHANGED",
      );
    }

    order.refund.reference = result.id;

    order.refund.submissionState =
      "submitted";

    if (result.status === "processed") {
      recordRefund(
        order,
        amount,
        result.id,
        new Date(),
      );
    } else {
      order.refund.status = "pending";
    }

    event(
      order,
      result.status === "processed"
        ? "refund-completed"
        : "refund-requested",

      result.status === "processed"
        ? "Cancellation refund completed through Razorpay."
        : "Cancellation refund submitted to Razorpay; completion is pending.",
    );

    await order.save({ session });
  });
}

const cancelOrder = handler(
  async (req, res) => {
    const id = orderId(req);

    const reason = inputText(
      bodyOf(req).reason,
      "Cancellation reason",
      500,
      5,
      true,
    );

    const result = await transaction(
      async (session) => {
        const order = await loadOrder(
          id,
          session,
          customerFilter(req),
        );

        if (
          order.status === "cancelled" ||
          order.cancellation?.status ===
            "cancelled"
        ) {
          return {
            order,
            existing: true,
          };
        }

        if (
          !["confirmed", "processing"].includes(
            order.status,
          )
        ) {
          throw problem(
            409,
            "This order cannot be cancelled at its current fulfilment step.",
            "CANCELLATION_UNAVAILABLE",
          );
        }

        const {
          method,
          ...amounts
        } = paymentState(order);

        if (
          amounts.refunded > 0 ||
          ![
            "not-requested",
            "not-applicable",
          ].includes(
            order.refund?.status ||
              "not-requested",
          )
        ) {
          throw problem(
            409,
            "An existing refund needs review before cancellation.",
            "REFUND_REVIEW_REQUIRED",
          );
        }

        const now = new Date();

        if (!order.cancellation) {
          order.cancellation = {};
        }

        if (
          order.metadata?.inventoryReserved === true &&
          !order.cancellation.inventoryRestoredAt
        ) {
          const cache = new Map();

          for (const item of order.items || []) {
            const product = await inventoryProduct(
              item,
              session,
              cache,
            );

            restorePurchasedStock(
              product,
              item,
              item.quantity,
            );
          }

          await saveProducts(cache, session);

          order.metadata.inventoryReserved =
            false;

          order.cancellation.inventoryRestoredAt =
            now;
        }

        order.status = "cancelled";

        order.cancellation.status =
          "cancelled";

        order.cancellation.reason = reason;
        order.cancellation.cancelledAt = now;

        if (!order.delivery) {
          order.delivery = {};
        }

        order.delivery.status = "cancelled";
        order.payment.amountDue = 0;

        order.payment.balanceStatus =
          "not-applicable";

        order.refund = blankRefund();

        if (amounts.retained > 0) {
          order.refund.status =
            method === "cod"
              ? "manual-required"
              : "pending";

          order.refund.amount =
            amounts.retained / 100;

          order.refund.requestedAt = now;

          if (method === "cod") {
            order.refund.submissionState =
              "manual";
          }
        }

        event(
          order,
          "cancelled",

          amounts.retained > 0
            ? "Order cancelled. Refund of recorded money paid requested."
            : "Order cancelled by customer.",

          now,
        );

        await order.save({ session });

        return {
          order,
          existing: false,
        };
      },
    );

    if (
      result.order.refund.status === "pending"
    ) {
      await submitCancellationRefund(
        result.order._id,
      );
    }

    const latest = await loadOrder(
      id,
      null,
      customerFilter(req),
    );

    const status =
      latest.refund?.status ||
      "not-requested";

    const message =
      status === "refunded"
        ? "Order cancelled. The refund is recorded as completed."
        : status === "manual-required"
          ? "Order cancelled. The refund requires payment-provider review."
          : status === "pending"
            ? "Order cancelled. Refund confirmation is pending."
            : result.existing
              ? "This order is already cancelled."
              : "Order cancelled successfully.";

    return res.json({
      success: true,
      existing: result.existing,
      message,
      refundStatus: status,
      refundAmount: latest.refund?.amount || 0,

      manualReviewRequired:
        status === "manual-required",

      order: safeOrder(latest),
    });
  },
);

const requestReturn = handler(
  async (req, res) => {
    const id = orderId(req);
    const body = bodyOf(req);

    const type = inputText(
      body.type,
      "Request type",
      20,
      1,
    ).toLowerCase();

    if (
      !["return", "exchange"].includes(type)
    ) {
      throw problem(
        400,
        "Choose return or exchange.",
        "INVALID_RETURN_TYPE",
      );
    }

    const reason = inputText(
      body.reason,
      "Request reason",
      1000,
      5,
      true,
    );

    if (
      !Array.isArray(body.items) ||
      !body.items.length ||
      body.items.length > 50
    ) {
      throw problem(
        400,
        "Select 1–50 valid return items.",
        "INVALID_RETURN_ITEMS",
      );
    }

    const order = await transaction(
      async (session) => {
        const order = await loadOrder(
          id,
          session,
          customerFilter(req),
        );

        if (order.status !== "delivered") {
          throw problem(
            409,
            "Returns and exchanges open after delivery.",
            "ORDER_NOT_DELIVERED",
          );
        }

        paymentState(order, true);

        if (
          ![
            "not-requested",
            "rejected",
          ].includes(
            order.returnRequest?.status ||
              "not-requested",
          )
        ) {
          throw problem(
            409,
            "A request is already recorded for this order.",
            "RETURN_ALREADY_RECORDED",
          );
        }

        if (
          ![
            "not-requested",
            "not-applicable",
          ].includes(
            order.refund?.status ||
              "not-requested",
          )
        ) {
          throw problem(
            409,
            "An existing refund needs review.",
            "REFUND_REVIEW_REQUIRED",
          );
        }

        const seen = new Set();
        const rows = [];

        for (const raw of body.items) {
          const index = numberOf(
            raw?.index,
            "item index",
          );

          const quantity = numberOf(
            raw?.quantity,
            "quantity",
            1,
          );

          const item = order.items[index];

          if (
            !item ||
            seen.has(index) ||
            quantity > item.quantity
          ) {
            throw problem(
              400,
              "Choose valid item quantities.",
              "INVALID_RETURN_ITEMS",
            );
          }

          let size =
            raw.size == null
              ? null
              : inputText(
                  raw.size,
                  "Replacement size",
                  50,
                  1,
                );

          let color =
            raw.color == null
              ? null
              : inputText(
                  raw.color,
                  "Replacement colour",
                  50,
                  1,
                );

          if (type === "exchange") {
            const product =
              await Product.findById(
                item.product,
              ).session(session);

            if (
              !product ||
              product.isActive === false
            ) {
              throw problem(
                409,
                `${item.name}: the replacement is unavailable.`,
                "REPLACEMENT_UNAVAILABLE",
              );
            }

            size = product.sizes?.length
              ? size
              : null;

            color = product.colors?.length
              ? color
              : null;

            if (
              getVariantStock(
                product,
                size,
                color,
              ) < quantity
            ) {
              throw problem(
                409,
                `${item.name}: the requested replacement is out of stock.`,
                "REPLACEMENT_OUT_OF_STOCK",
              );
            }

            if (
              size ===
                (item.selectedSize ?? null) &&
              color ===
                (item.selectedColor ?? null)
            ) {
              throw problem(
                400,
                "Choose a different size or colour for an exchange.",
                "UNCHANGED_EXCHANGE_VARIANT",
              );
            }
          } else {
            size = null;
            color = null;
          }

          rows.push({
            index,
            quantity,
            size,
            color,
          });

          seen.add(index);
        }

        validateEligibility(order, rows);

        // Validate combined replacement quantities
        // without saving or reserving stock yet.
        if (type === "exchange") {
          await reserveReplacements(
            order,
            rows,
            session,
            new Map(),
          );
        }

        const now = new Date();

        order.returnRequest = {
          id:
            `RET-${Date.now()
              .toString(36)
              .toUpperCase()}-` +
            crypto
              .randomBytes(6)
              .toString("hex")
              .toUpperCase(),

          type,
          status: "requested",
          items: rows,
          reason,
          requestedAt: now,
          response: "",
          respondedAt: null,
          approvedAt: null,
          rejectedAt: null,
          completedAt: null,
          originalInventoryRestoredAt: null,
          exchangeInventoryReservedAt: null,
        };

        order.refund = blankRefund();

        event(
          order,
          `${type}-requested`,
          "Customer request submitted for review.",
          now,
        );

        await order.save({ session });

        return order;
      },
    );

    return res.status(201).json({
      success: true,

      message:
        "Request submitted successfully for review.",

      order: safeOrder(order),
      returnRequest: order.returnRequest,
    });
  },
);

const getAdminReturnRequests = handler(
  async (req, res) => {
    const status = inputText(
      req.query?.status ?? "",
      "Return status",
      30,
    ).toLowerCase();

    if (
      status &&
      status !== "all" &&
      !RETURNS.includes(status)
    ) {
      throw problem(
        400,
        "Choose a valid return status.",
        "INVALID_RETURN_STATUS",
      );
    }

    const orders = await Order.find({
      "returnRequest.status":
        status && status !== "all"
          ? status
          : { $in: RETURNS },
    })
      .populate(
        "user",
        "name email phone role",
      )
      .sort({
        "returnRequest.requestedAt": -1,
        createdAt: -1,
      });

    return res.json({
      success: true,
      count: orders.length,
      orders: orders.map(safeOrder),
    });
  },
  true,
);

const getAdminOrders = handler(
  async (req, res) => {
    const status = inputText(
      req.query?.status ?? "",
      "Order status",
      40,
    ).toLowerCase();

    const search = inputText(
      req.query?.search ?? "",
      "Search",
      150,
    );

    if (
      status &&
      status !== "all" &&
      ![
        "payment-pending",
        ...FLOW,
        "cancelled",
      ].includes(status)
    ) {
      throw problem(
        400,
        "Choose a valid order status.",
        "INVALID_ORDER_STATUS",
      );
    }

    const page = Math.min(
      1000000,
      numberOf(
        req.query?.page ?? 1,
        "page",
        1,
      ),
    );

    const limit = Math.min(
      100,
      numberOf(
        req.query?.limit ?? 25,
        "page size",
        1,
      ),
    );

    const query = {};

    if (status && status !== "all") {
      query.status = status;
    }

    if (search) {
      const pattern = new RegExp(
        search.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        ),
        "i",
      );

      query.$or = [
        "orderNumber",
        "customer.name",
        "customer.email",
        "customer.phone",
        "shippingAddress.phone",
        "shippingAddress.city",
        "shippingAddress.pincode",
        "tracking.trackingNumber",
      ].map((field) => ({
        [field]: pattern,
      }));
    }

    const [orders, total] =
      await Promise.all([
        Order.find(query)
          .populate(
            "user",
            "name email phone role",
          )
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),

        Order.countDocuments(query),
      ]);

    return res.json({
      success: true,
      count: orders.length,
      total,
      page,

      pages: Math.max(
        1,
        Math.ceil(total / limit),
      ),

      limit,
      orders: orders.map(safeOrder),
    });
  },
  true,
);

async function serializeAdminOrder(
  order,
  user,
) {
  const result = await withAdminSourcing(
    order,
    safeOrder(order),
    user,
  );

  if (order.kitSnapshots?.length) {
    result.kitFulfillmentAdmin =
      adminKitFulfillmentFields(order);
  }

  return result;
}

const updateAdminKitFulfillment = handler(
  async (req, res) => {
    const id = orderId(req);
    const body = bodyOf(req);

    const updated = await transaction(
      async (session) => {
        const order = await loadOrder(
          id,
          session,
        );

        paymentState(order);

        const changed =
          applyKitFulfillmentAction(
            order,
            body,
            String(req.user._id),
          );

        order.fulfillmentProgress =
          changed.progress;

        order.set(
          "payment",
          changed.payment,
        );

        order.set(
          "delivery",
          changed.delivery,
        );

        order.status = changed.status;

        event(
          order,
          body.action === "cod"
            ? "cod-parcel-collected"
            : `kit-${body.action}`,
          changed.description,
        );

        await order.save({ session });

        return order;
      },
    );

    return res.json({
      success: true,
      message: "Kit fulfillment saved.",

      order: await serializeAdminOrder(
        updated,
        req.user,
      ),
    });
  },
  true,
);

const getAdminOrderById = handler(
  async (req, res) => {
    const order = await Order.findOne(
      lookup(orderId(req)),
    )
      .select("+items.sourcing")
      .populate(
        "user",
        "name email phone role",
      );

    if (!order) {
      throw problem(
        404,
        "Order not found.",
        "ORDER_NOT_FOUND",
      );
    }

    return res.json({
      success: true,

      order: await serializeAdminOrder(
        order,
        req.user,
      ),
    });
  },
  true,
);

const updateAdminOrderStatus = handler(
  async (req, res) => {
    const id = orderId(req);
    const body = bodyOf(req);
    const extras = parseTrackingExtras(body);

    const status = inputText(
      body.status,
      "Order status",
      40,
      1,
    ).toLowerCase();

    if (!FLOW.includes(status)) {
      throw problem(
        400,
        "Choose a valid fulfilment status.",
        "INVALID_ORDER_STATUS",
      );
    }

    if (
      own(body, "codBalanceCollected") &&
      typeof body.codBalanceCollected !==
        "boolean"
    ) {
      throw problem(
        400,
        "COD collection confirmation must be true or false.",
        "INVALID_COD_CONFIRMATION",
      );
    }

    const collect =
      body.codBalanceCollected === true;

    if (
      collect &&
      status !== "delivered"
    ) {
      throw problem(
        400,
        "Record COD collection only when confirming delivery.",
        "INVALID_COD_CONFIRMATION",
      );
    }

    const tracking = {};

    if (own(body, "carrier")) {
      tracking.carrier = inputText(
        body.carrier ?? "",
        "Courier name",
        100,
      ) || null;
    }

    if (own(body, "trackingNumber")) {
      tracking.trackingNumber = inputText(
        body.trackingNumber ?? "",
        "Tracking number",
        150,
      ) || null;
    }

    if (own(body, "estimatedDelivery")) {
      const raw = inputText(
        body.estimatedDelivery ?? "",
        "Estimated delivery",
        10,
      );

      const parsed = new Date(
        `${raw}T00:00:00Z`,
      );

      if (
        raw &&
        (
          !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
          Number.isNaN(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== raw
        )
      ) {
        throw problem(
          400,
          "Enter a valid estimated delivery date in YYYY-MM-DD format.",
          "INVALID_DELIVERY_DATE",
        );
      }

      tracking.estimatedDelivery =
        raw ? parsed : null;
    }

    const result = await transaction(
      async (session) => {
        const order = await loadOrder(
          id,
          session,
        );

        if (
          order.status === "cancelled" ||
          order.cancellation?.status ===
            "cancelled"
        ) {
          throw problem(
            409,
            "A cancelled order cannot move through fulfilment.",
            "ORDER_CANCELLED",
          );
        }

        if (order.kitSnapshots?.length) {
          throw problem(
            409,
            "Use the kit parcel controls to record dispatch, delivery and COD collection.",
            "KIT_PARCEL_CONTROLS_REQUIRED",
          );
        }

        const current = FLOW.indexOf(
          order.status,
        );

        const next = FLOW.indexOf(status);

        if (current < 0) {
          throw problem(
            409,
            "This order is awaiting verified payment or has an unsupported status.",
            "ORDER_NOT_READY",
          );
        }

        if (
          next < current ||
          next > current + 1
        ) {
          throw problem(
            409,
            "Complete fulfilment steps in order without skipping or moving backwards.",
            "INVALID_STATUS_TRANSITION",
          );
        }

        if (
          order.returnRequest?.status &&
          ![
            "not-requested",
            "rejected",
          ].includes(
            order.returnRequest.status,
          )
        ) {
          throw problem(
            409,
            "This order has a return or exchange under management. Use the returns section.",
            "RETURN_IN_PROGRESS",
          );
        }

        if (
          order.metadata?.inventoryReserved !== true
        ) {
          throw problem(
            409,
            "Stock deduction is not confirmed. Reconcile inventory before fulfilment.",
            "INVENTORY_RECONCILIATION_REQUIRED",
          );
        }

        const payment = paymentState(order);

        if (
          collect &&
          payment.method !== "cod-partial"
        ) {
          throw problem(
            409,
            "This collection action is only for configured advance-plus-COD orders.",
            "INVALID_COD_CONFIRMATION",
          );
        }

        if (
          status === "delivered" &&
          payment.due > 0 &&
          (
            payment.method !== "cod-partial" ||
            !collect
          )
        ) {
          throw problem(
            409,

            payment.method === "cod-partial"
              ? `Confirm that the remaining ₹${(payment.due / 100).toFixed(2)} COD balance was collected before confirming delivery.`
              : "Reconcile the legacy COD balance before confirming delivery.",

            "COD_COLLECTION_REQUIRED",

            {
              requiresCodBalanceConfirmation:
                payment.method === "cod-partial",

              amountDue: payment.due / 100,
            },
          );
        }

        if (!order.tracking) {
          order.tracking = {};
        }

        Object.assign(
          order.tracking,
          tracking,
        );

        if (
          next >= FLOW.indexOf("shipped") &&
          (
            !String(
              order.tracking.carrier || "",
            ).trim() ||
            !String(
              order.tracking.trackingNumber || "",
            ).trim()
          )
        ) {
          throw problem(
            409,
            "Record the courier and tracking number before shipping or confirming delivery.",
            "TRACKING_REQUIRED",
          );
        }

        const now = new Date();

        const packingNew =
          extras.packingConfirmed === true &&
          !order.tracking.packedAt;

        if (
          packingNew &&
          !["processing", "shipped"].includes(status)
        ) {
          throw problem(
            409,
            "Record packing while preparing the order or confirming its dispatch.",
            "PACKING_NOT_READY",
          );
        }

        if (packingNew) {
          order.tracking.packedAt = now;

          event(
            order,
            "packed",
            "Your items are packed and ready for pickup.",
            now,
          );
        }

        if (
          order.status === "processing" &&
          status === "shipped" &&
          !order.tracking.packedAt
        ) {
          throw problem(
            409,
            "Confirm the items are physically packed before dispatch.",
            "PACKING_CONFIRMATION_REQUIRED",
          );
        }

        const noticeChanged =
          extras.exception &&
          (
            (
              order.tracking.exception?.type ||
              "none"
            ) !== extras.exception.type ||
            (
              order.tracking.exception?.message ||
              ""
            ) !== extras.exception.message
          );

        const extrasChanged =
          applyTrackingExtras(
            order.tracking,
            extras,
            now,
          );

        if (noticeChanged) {
          event(
            order,

            extras.exception.type === "none"
              ? "delivery-update-resolved"
              : extras.exception.type,

            extras.exception.message ||
              "The previous delivery notice has been resolved.",

            now,
          );
        }

        const collected =
          status === "delivered" &&
          payment.method === "cod-partial" &&
          payment.due > 0 &&
          collect;

        if (collected) {
          order.payment.amountPaid =
            payment.total / 100;

          order.payment.amountDue = 0;

          order.payment.grossCollected =
            payment.total / 100;

          order.payment.refundedAmount = 0;
          order.payment.amountsReconciled = true;

          order.payment.balanceStatus =
            "collected";

          order.payment.balanceCollectedAt =
            now;

          order.payment.status = "paid";
          order.payment.paidAt = now;

          event(
            order,
            "cod-balance-collected",
            `Remaining COD balance of ₹${(payment.due / 100).toFixed(2)} recorded as collected.`,
            now,
          );
        }

        const changed =
          order.status !== status;

        order.status = status;

        if (!order.delivery) {
          order.delivery = {};
        }

        order.delivery.status =
          status === "confirmed"
            ? "pending"
            : status;

        if (
          status === "delivered" &&
          !order.delivery.deliveredAt
        ) {
          order.delivery.deliveredAt = now;
        }

        if (changed) {
          event(
            order,
            status,

            status === "delivered"
              ? "Order delivered. Recorded payment is completed."
              : `Order moved to ${status}.`,

            now,
          );
        } else if (
          Object.keys(tracking).length
        ) {
          event(
            order,
            "tracking-updated",
            "Tracking information updated by GymDrobe.",
            now,
          );
        }

        if (
          changed ||
          collected ||
          packingNew ||
          extrasChanged ||
          Object.keys(tracking).length
        ) {
          await order.save({ session });
        }

        return {
          order,
          collected,
        };
      },
    );

    return res.json({
      success: true,
      codBalanceCollected: result.collected,

      message: result.collected
        ? "Order delivered and COD balance recorded as collected."
        : "Order information confirmed.",

      order: await serializeAdminOrder(
        result.order,
        req.user,
      ),
    });
  },
  true,
);

const reviewReturnRequest = handler(
  async (req, res) => {
    const id = orderId(req);
    const body = bodyOf(req);

    const decision = inputText(
      body.decision,
      "Decision",
      20,
      1,
    ).toLowerCase();

    const response = inputText(
      body.response ?? "",
      "Customer response",
      1000,
      0,
      true,
    );

    if (
      !["approve", "reject"].includes(decision)
    ) {
      throw problem(
        400,
        "Choose approve or reject.",
        "INVALID_RETURN_DECISION",
      );
    }

    const result = await transaction(
      async (session) => {
        const order = await loadOrder(
          id,
          session,
        );

        const target =
          decision === "approve"
            ? "approved"
            : "rejected";

        if (
          order.returnRequest?.status === target
        ) {
          return {
            order,
            existing: true,
          };
        }

        if (
          order.status !== "delivered" ||
          order.returnRequest?.status !==
            "requested"
        ) {
          throw problem(
            409,
            "This request is no longer waiting for review.",
            "RETURN_NOT_REVIEWABLE",
          );
        }

        const type =
          order.returnRequest.type;

        if (
          !["return", "exchange"].includes(type)
        ) {
          throw problem(
            409,
            "This return request needs review.",
            "RETURN_ITEMS_INVALID",
          );
        }

        if (
          ![
            "not-requested",
            "not-applicable",
          ].includes(
            order.refund?.status ||
              "not-requested",
          ) ||
          Number(order.refund?.amount || 0) > 0 ||
          order.refund?.reference
        ) {
          throw problem(
            409,
            "An existing refund needs reconciliation before reviewing this request.",
            "REFUND_REVIEW_REQUIRED",
          );
        }

        const rows = storedReturnRows(order);
        const now = new Date();

        if (decision === "approve") {
          const paid = paymentState(
            order,
            true,
          );

          if (
            rows.some(
              (row) =>
                order.items[row.index]
                  .returnsEligible !== "yes",
            )
          ) {
            throw problem(
              409,
              "A purchased item has an unconfirmed or ineligible return policy. Resolve it with support before approval.",
              "RETURN_POLICY_UNCONFIRMED",
            );
          }

          if (type === "exchange") {
            const cache = new Map();

            await reserveReplacements(
              order,
              rows,
              session,
              cache,
            );

            await saveProducts(
              cache,
              session,
            );

            order.returnRequest
              .exchangeInventoryReservedAt = now;

            order.refund = {
              ...blankRefund(),
              status: "not-applicable",
            };
          } else {
            const amount = returnRefundCents(
              order,
              rows,
            );

            if (amount > paid.retained) {
              throw problem(
                409,
                "The calculated refund exceeds recorded money paid. Reconcile the payment first.",
                "REFUND_AMOUNT_INVALID",
              );
            }

            order.refund = {
              ...blankRefund(),

              status:
                amount > 0
                  ? "pending"
                  : "not-applicable",

              amount: amount / 100,

              requestedAt:
                amount > 0 ? now : null,
            };
          }
        } else {
          order.refund = blankRefund();
        }

        order.returnRequest.status = target;

        order.returnRequest.response =
          response;

        order.returnRequest.respondedAt =
          now;

        order.returnRequest.approvedAt =
          decision === "approve"
            ? now
            : null;

        order.returnRequest.rejectedAt =
          decision === "reject"
            ? now
            : null;

        order.returnRequest.completedAt =
          null;

        order.returnRequest
          .originalInventoryRestoredAt = null;

        event(
          order,
          `${type}-${target}`,

          type === "exchange" &&
          target === "approved"
            ? "Exchange approved. Replacement stock reserved."
            : `Customer ${type} request ${target}.`,

          now,
        );

        await order.save({ session });

        return {
          order,
          existing: false,
        };
      },
    );

    return res.json({
      success: true,
      existing: result.existing,

      message: result.existing
        ? "This decision is already recorded."
        : "Request reviewed successfully.",

      order: safeOrder(result.order),
    });
  },
  true,
);

const completeReturnRequest = handler(
  async (req, res) => {
    const id = orderId(req);

    const response = inputText(
      bodyOf(req).response ?? "",
      "Customer response",
      1000,
      0,
      true,
    );

    const result = await transaction(
      async (session) => {
        const order = await loadOrder(
          id,
          session,
        );

        if (
          order.returnRequest?.status ===
            "completed"
        ) {
          return {
            order,
            existing: true,
          };
        }

        if (
          order.status !== "delivered" ||
          order.returnRequest?.status !==
            "approved"
        ) {
          throw problem(
            409,
            "Only an approved return or exchange can be completed.",
            "RETURN_NOT_APPROVED",
          );
        }

        const type =
          order.returnRequest.type;

        if (
          !["return", "exchange"].includes(type)
        ) {
          throw problem(
            409,
            "This return request needs review.",
            "RETURN_ITEMS_INVALID",
          );
        }

        const rows = storedReturnRows(order);

        const paid = paymentState(
          order,
          true,
        );

        const now = new Date();
        const cache = new Map();

        if (
          order.metadata?.inventoryReserved !== true
        ) {
          throw problem(
            409,
            "The original stock deduction is not confirmed. Reconcile inventory before adding returned stock.",
            "INVENTORY_RECONCILIATION_REQUIRED",
          );
        }

        if (
          type === "exchange" &&
          !order.returnRequest
            .exchangeInventoryReservedAt
        ) {
          await reserveReplacements(
            order,
            rows,
            session,
            cache,
          );

          order.returnRequest
            .exchangeInventoryReservedAt = now;
        }

        // Completion means the administrator received,
        // inspected and accepted the original products
        // as saleable inventory.
        if (
          !order.returnRequest
            .originalInventoryRestoredAt
        ) {
          for (const row of rows) {
            const item =
              order.items[row.index];

            const product =
              await inventoryProduct(
                item,
                session,
                cache,
              );

            restorePurchasedStock(
              product,
              item,
              row.quantity,
            );
          }

          order.returnRequest
            .originalInventoryRestoredAt = now;
        }

        await saveProducts(cache, session);

        if (type === "return") {
          const amount = returnRefundCents(
            order,
            rows,
          );

          if (
            amount > paid.retained ||
            cents(
              order.refund?.amount,
              "Approved refund",
            ) !== amount ||
            ![
              "pending",
              "not-applicable",
            ].includes(
              order.refund?.status,
            )
          ) {
            throw problem(
              409,
              "The approved refund changed. Reconcile it before completing the return.",
              "REFUND_CHANGED",
            );
          }

          order.refund.status =
            amount > 0
              ? "manual-required"
              : "not-applicable";

          order.refund.submissionState =
            "manual";
        }

        order.returnRequest.status =
          "completed";

        order.returnRequest.completedAt =
          now;

        order.returnRequest.respondedAt =
          now;

        if (response) {
          order.returnRequest.response =
            response;
        }

        event(
          order,
          `${type}-completed`,

          type === "return"
            ? "Returned items received and inspected. Any due refund requires separate processing."
            : "Exchange completed after inspecting returned items.",

          now,
        );

        await order.save({ session });

        return {
          order,
          existing: false,
        };
      },
    );

    return res.json({
      success: true,
      existing: result.existing,

      message: result.existing
        ? "This request is already completed."
        : "Request completed. Check the recorded refund progress.",

      order: safeOrder(result.order),
    });
  },
  true,
);

// Records an already-transferred return refund.
// This endpoint does not transfer money.
const recordReturnRefund = handler(
  async (req, res) => {
    const id = orderId(req);

    const reference = inputText(
      bodyOf(req).reference,
      "Refund reference",
      200,
      3,
    );

    const result = await transaction(
      async (session) => {
        const order = await loadOrder(
          id,
          session,
        );

        if (
          order.status !== "delivered" ||
          order.returnRequest?.type !== "return" ||
          order.returnRequest.status !==
            "completed"
        ) {
          throw problem(
            409,
            "Complete the return before recording its refund.",
            "RETURN_NOT_COMPLETED",
          );
        }

        if (
          order.refund?.status === "refunded"
        ) {
          if (
            order.refund.reference !== reference
          ) {
            throw problem(
              409,
              "A different refund reference is already recorded. Reload the order.",
              "REFUND_ALREADY_RECORDED",
            );
          }

          return {
            order,
            existing: true,
          };
        }

        if (
          ![
            "pending",
            "manual-required",
          ].includes(
            order.refund?.status,
          ) ||
          [
            "submitting",
            "submitted",
            "uncertain",
          ].includes(
            order.refund.submissionState,
          )
        ) {
          throw problem(
            409,
            "This refund needs provider reconciliation before manual recording.",
            "REFUND_REVIEW_REQUIRED",
          );
        }

        const rows = storedReturnRows(order);

        const amount = returnRefundCents(
          order,
          rows,
        );

        if (
          amount !==
          cents(
            order.refund.amount,
            "Approved refund",
          )
        ) {
          throw problem(
            409,
            "The approved refund does not match purchased items.",
            "REFUND_AMOUNT_INVALID",
          );
        }

        const now = new Date();

        recordRefund(
          order,
          amount,
          reference,
          now,
        );

        order.refund.submissionState =
          "manual";

        event(
          order,
          "refund-recorded",
          "Return refund already transferred and recorded by GymDrobe.",
          now,
        );

        await order.save({ session });

        return {
          order,
          existing: false,
        };
      },
    );

    return res.json({
      success: true,
      existing: result.existing,

      message: result.existing
        ? "This refund is already recorded."
        : "Refund recorded successfully.",

      order: safeOrder(result.order),
    });
  },
  true,
);

module.exports = {
  updateAdminKitFulfillment,
  serializeAdminOrder,
  createOrder,
  getOrders,
  getOrderById,
  cancelOrder,
  requestReturn,
  getAdminOrders,
  getAdminOrderById,
  updateAdminOrderStatus,
  getAdminReturnRequests,
  reviewReturnRequest,
  completeReturnRequest,
  recordReturnRefund,
};