const crypto = require("crypto");
const mongoose = require("mongoose");

const Order = require("../models/Order");
const Product = require("../models/Product");

const {
  roundMoney,
} = require("../utils/orderPricing");

const {
  getVariantStock,
  reserveVariantStock,
  restoreVariantStock,
} = require("../utils/orderInventory");

// ======================================================
// HELPERS
// ======================================================

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function generateReturnNumber() {
  const time = Date.now()
    .toString(36)
    .toUpperCase();

  const random = crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();

  return `RET-${time}-${random}`;
}

function cleanString(value, maxLength = 300) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function orderLookupConditions(id) {
  const conditions = [
    {
      orderNumber: id,
    },
  ];

  if (mongoose.Types.ObjectId.isValid(id)) {
    conditions.push({
      _id: id,
    });
  }

  return conditions;
}

function getDeliveredAt(order) {
  if (order?.delivery?.deliveredAt) {
    return order.delivery.deliveredAt;
  }

  const events = Array.isArray(
    order?.tracking?.events
  )
    ? order.tracking.events
    : [];

  for (
    let index = events.length - 1;
    index >= 0;
    index--
  ) {
    if (events[index]?.status === "delivered") {
      return events[index].timestamp || null;
    }
  }

  return null;
}

// Preserve the existing frontend order response format.
function safeOrder(order) {
  const value =
    typeof order.toObject === "function"
      ? order.toObject()
      : order;

  const rawUser = value.user;

  const userId =
    rawUser &&
    typeof rawUser === "object" &&
    rawUser._id
      ? rawUser._id
      : rawUser;

  const safeUser = {
    id: String(userId || ""),
  };

  if (rawUser && typeof rawUser === "object") {
    if (rawUser.name) {
      safeUser.name = rawUser.name;
    }

    if (rawUser.email) {
      safeUser.email = rawUser.email;
    }

    if (rawUser.role) {
      safeUser.role = rawUser.role;
    }
  }

  return {
    id: value.orderNumber,
    orderNumber: value.orderNumber,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: value.status,
    source: value.source,
    giftMessage: value.giftMessage || "",
    orderNote: value.orderNote || "",
    user: safeUser,
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

function ensureTracking(order) {
  if (!order.tracking) {
    order.tracking = {
      carrier: null,
      trackingNumber: null,
      estimatedDelivery: null,
      events: [],
    };
  }

  if (!Array.isArray(order.tracking.events)) {
    order.tracking.events = [];
  }
}

// Validate persisted request data before changing
// inventory or refund records.
function validatedRows(order) {
  const rows = order.returnRequest?.items;

  if (!Array.isArray(rows) || !rows.length) {
    throw httpError(
      409,
      "This request has no valid items. Contact support."
    );
  }

  const seen = new Set();

  for (const row of rows) {
    const item = order.items[row.index];

    if (
      !Number.isSafeInteger(row.index) ||
      row.index < 0 ||
      seen.has(row.index) ||
      !item ||
      !Number.isSafeInteger(row.quantity) ||
      row.quantity < 1 ||
      row.quantity > item.quantity
    ) {
      throw httpError(
        409,
        "This request contains invalid item quantities. Contact support."
      );
    }

    seen.add(row.index);
  }

  return rows;
}

// Allocate coupon savings proportionally.
// Shipping is excluded, matching the existing calculation.
// Refunds cannot exceed recorded payment collected.
function calculateReturnRefund(
  order,
  requestedItems
) {
  const subtotal = Number(
    order.pricing?.subtotal
  );

  const coupon = Number(
    order.pricing?.couponDiscount ?? 0
  );

  const paid = Number(
    order.payment?.amountPaid
  );

  if (
    order.payment?.amountPaid == null ||
    !Number.isFinite(paid) ||
    paid < 0 ||
    !Number.isFinite(subtotal) ||
    subtotal <= 0 ||
    !Number.isFinite(coupon) ||
    coupon < 0 ||
    coupon > subtotal
  ) {
    throw httpError(
      409,
      "Reconcile this order's payment and pricing records before processing its refund."
    );
  }

  const returnedSubtotal =
    requestedItems.reduce((total, row) => {
      const price = Number(
        order.items[row.index]?.price
      );

      if (
        !Number.isFinite(price) ||
        price < 0
      ) {
        throw httpError(
          409,
          "An item price is invalid. Reconcile the order before refunding."
        );
      }

      return total + price * row.quantity;
    }, 0);

  if (
    roundMoney(returnedSubtotal) >
    roundMoney(subtotal)
  ) {
    throw httpError(
      409,
      "Returned items exceed the recorded subtotal. Reconcile the order before refunding."
    );
  }

  const proportionalCoupon = roundMoney(
    coupon * returnedSubtotal / subtotal
  );

  const merchandiseRefund = Math.max(
    0,
    roundMoney(
      returnedSubtotal - proportionalCoupon
    )
  );

  return roundMoney(
    Math.min(merchandiseRefund, paid)
  );
}

function blankRefund() {
  return {
    status: "not-requested",
    amount: 0,
    requestedAt: null,
    reference: "",
    refundedAt: null,
  };
}

async function loadProductForInventory(
  item,
  session,
  cache
) {
  const key = String(item.product);

  let product = cache.get(key);

  if (!product) {
    product = await Product
      .findById(item.product)
      .session(session);

    if (!product) {
      throw httpError(
        409,
        `Unable to update inventory for ${item.name}. The product no longer exists.`
      );
    }

    cache.set(key, product);
  }

  return product;
}

// ======================================================
// CUSTOMER — REQUEST RETURN OR EXCHANGE
// ======================================================

async function requestReturn(req, res) {
  const userId = req.user._id;

  const id = cleanString(
    req.params.id,
    150
  );

  const type = cleanString(
    req.body?.type,
    20
  ).toLowerCase();

  const reason = cleanString(
    req.body?.reason,
    1000
  );

  const requestedItems =
    Array.isArray(req.body?.items)
      ? req.body.items
      : [];

  if (!["return", "exchange"].includes(type)) {
    return res.status(400).json({
      success: false,
      message: "Choose return or exchange.",
    });
  }

  if (reason.length < 5) {
    return res.status(400).json({
      success: false,
      message:
        "Please describe the reason in at least 5 characters.",
    });
  }

  if (!requestedItems.length) {
    return res.status(400).json({
      success: false,
      message: "Select at least one item.",
    });
  }

  if (requestedItems.length > 50) {
    return res.status(400).json({
      success: false,
      message: "Too many return items.",
    });
  }

  const session =
    await mongoose.startSession();

  let savedOrder = null;

  try {
    await session.withTransaction(async () => {
      savedOrder = null;

      const order = await Order.findOne({
        user: userId,
        $or: orderLookupConditions(id),
      }).session(session);

      if (!order) {
        throw httpError(
          404,
          "Order not found."
        );
      }

      if (order.status !== "delivered") {
        throw httpError(
          409,
          "Returns and exchanges open after delivery."
        );
      }

      const currentStatus =
        order.returnRequest?.status ||
        "not-requested";

      if (
        currentStatus !== "not-requested" &&
        currentStatus !== "rejected"
      ) {
        throw httpError(
          409,
          "A return or exchange request is already recorded for this order."
        );
      }

      const deliveredAt =
        getDeliveredAt(order);

      const deliveryTime =
        Date.parse(deliveredAt);

      const nowMs = Date.now();

      if (
        !Number.isFinite(deliveryTime) ||
        deliveryTime > nowMs
      ) {
        throw httpError(
          409,
          "Contact support to confirm the delivery date and return eligibility."
        );
      }

      const deadline =
        deliveryTime + 7 * 86400000;

      if (nowMs > deadline) {
        throw httpError(
          409,
          "The 7-day request window has ended. Contact support for help."
        );
      }

      const seen = new Set();
      const cleanItems = [];

      for (const raw of requestedItems) {
        const index = Number(raw?.index);
        const quantity = Number(raw?.quantity);

        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          seen.has(index)
        ) {
          throw httpError(
            400,
            "Choose valid item quantities."
          );
        }

        const item = order.items[index];

        if (
          !item ||
          !Number.isSafeInteger(quantity) ||
          quantity < 1 ||
          quantity > item.quantity
        ) {
          throw httpError(
            400,
            "Choose valid item quantities."
          );
        }

        let size =
          raw?.size == null
            ? null
            : cleanString(raw.size, 50);

        let color =
          raw?.color == null
            ? null
            : cleanString(raw.color, 50);

        if (type === "exchange") {
          const product = await Product
            .findById(item.product)
            .session(session);

          if (
            !product ||
            product.isActive === false
          ) {
            throw httpError(
              409,
              `${item.name}: This product is no longer available.`
            );
          }

          const sizes =
            (product.sizes || []).map(String);

          const colors =
            (product.colors || []).map(String);

          size = sizes.length ? size : null;
          color = colors.length ? color : null;

          const available = getVariantStock(
            product,
            size,
            color
          );

          if (available < quantity) {
            throw httpError(
              409,
              available > 0
                ? `${item.name}: Only ${available} available for this selection.`
                : `${item.name}: This selection is out of stock.`
            );
          }

          const sameSize =
            (size ?? null) ===
            (item.selectedSize ?? null);

          const sameColor =
            (color ?? null) ===
            (item.selectedColor ?? null);

          if (sameSize && sameColor) {
            throw httpError(
              400,
              "Choose a different size or colour for an exchange."
            );
          }
        } else {
          size = null;
          color = null;
        }

        cleanItems.push({
          index,
          quantity,
          size,
          color,
        });

        seen.add(index);
      }

      const requestedAt = new Date();

      order.returnRequest = {
        id: generateReturnNumber(),
        type,
        status: "requested",
        items: cleanItems,
        reason,
        requestedAt,
        response: "",
        respondedAt: null,
        approvedAt: null,
        rejectedAt: null,
        completedAt: null,
        originalInventoryRestoredAt: null,
        exchangeInventoryReservedAt: null,
      };

      order.refund = blankRefund();

      ensureTracking(order);

      order.tracking.events.push({
        status:
          type === "exchange"
            ? "exchange-requested"
            : "return-requested",

        description:
          type === "exchange"
            ? "Exchange request submitted by customer."
            : "Return request submitted by customer.",

        timestamp: requestedAt,
      });

      await order.save({ session });

      savedOrder = order;
    });

    if (!savedOrder) {
      throw new Error(
        "Return request was not created."
      );
    }

    return res.status(201).json({
      success: true,

      message:
        type === "exchange"
          ? "Exchange request submitted successfully."
          : "Return request submitted successfully.",

      order: safeOrder(savedOrder),
      returnRequest: savedOrder.returnRequest,
    });
  } catch (error) {
    console.error(
      "Return request error:",
      error
    );

    return res.status(
      error.status || 500
    ).json({
      success: false,
      message:
        error.message ||
        "Unable to submit return request.",
    });
  } finally {
    await session.endSession();
  }
}

// ======================================================
// ADMIN — LIST RETURN AND EXCHANGE REQUESTS
// ======================================================

async function getAdminReturnRequests(
  req,
  res
) {
  try {
    const requestedStatus = cleanString(
      req.query?.status,
      30
    ).toLowerCase();

    const allowedStatuses = [
      "requested",
      "approved",
      "rejected",
      "completed",
    ];

    if (
      requestedStatus &&
      !allowedStatuses.includes(requestedStatus)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid return request status.",
      });
    }

    const query = {
      "returnRequest.status":
        requestedStatus || {
          $in: allowedStatuses,
        },
    };

    const orders = await Order.find(query)
      .populate("user", "name email role")
      .sort({
        "returnRequest.requestedAt": -1,
        createdAt: -1,
      });

    return res.status(200).json({
      success: true,
      count: orders.length,
      orders: orders.map(safeOrder),
    });
  } catch (error) {
    console.error(
      "Admin return list error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load return and exchange requests.",
    });
  }
}

// ======================================================
// ADMIN — APPROVE OR REJECT
// ======================================================

async function reviewReturnRequest(req, res) {
  const id = cleanString(
    req.params.id,
    150
  );

  const decision = cleanString(
    req.body?.decision,
    20
  ).toLowerCase();

  const responseText = cleanString(
    req.body?.response,
    1000
  );

  if (
    !["approve", "reject"].includes(decision)
  ) {
    return res.status(400).json({
      success: false,
      message: "Choose approve or reject.",
    });
  }

  const session =
    await mongoose.startSession();

  let savedOrder = null;
  let existingDecision = false;

  try {
    await session.withTransaction(async () => {
      savedOrder = null;

      const order = await Order.findOne({
        $or: orderLookupConditions(id),
      }).session(session);

      if (!order) {
        throw httpError(
          404,
          "Order not found."
        );
      }

      const currentStatus =
        order.returnRequest?.status;

      if (
        decision === "approve" &&
        currentStatus === "approved"
      ) {
        existingDecision = true;
        savedOrder = order;
        return;
      }

      if (
        decision === "reject" &&
        currentStatus === "rejected"
      ) {
        existingDecision = true;
        savedOrder = order;
        return;
      }

      if (currentStatus !== "requested") {
        throw httpError(
          409,
          "This request is no longer waiting for review."
        );
      }

      const type =
        order.returnRequest.type;

      if (
        !["return", "exchange"].includes(type)
      ) {
        throw httpError(
          409,
          "This order does not contain a valid return request."
        );
      }

      if (order.status !== "delivered") {
        throw httpError(
          409,
          "Only a delivered order can have its return reviewed."
        );
      }

      validatedRows(order);

      const now = new Date();

      if (decision === "reject") {
        order.returnRequest.status = "rejected";
        order.returnRequest.response = responseText;
        order.returnRequest.respondedAt = now;
        order.returnRequest.approvedAt = null;
        order.returnRequest.rejectedAt = now;
        order.returnRequest.completedAt = null;

        order.returnRequest
          .originalInventoryRestoredAt = null;

        order.returnRequest
          .exchangeInventoryReservedAt = null;

        order.refund = blankRefund();

        ensureTracking(order);

        order.tracking.events.push({
          status:
            type === "exchange"
              ? "exchange-rejected"
              : "return-rejected",

          description:
            type === "exchange"
              ? "Exchange request rejected by GymDrobe."
              : "Return request rejected by GymDrobe.",

          timestamp: now,
        });

        await order.save({ session });

        savedOrder = order;
        return;
      }

      if (type === "exchange") {
        const cache = new Map();
        const touched = new Map();

        for (
          const row of
          order.returnRequest.items || []
        ) {
          const item =
            order.items[row.index];

          if (!item) {
            throw httpError(
              409,
              "An exchange item is no longer valid."
            );
          }

          const product =
            await loadProductForInventory(
              item,
              session,
              cache
            );

          if (product.isActive === false) {
            throw httpError(
              409,
              `${item.name}: This product is no longer available.`
            );
          }

          const available = getVariantStock(
            product,
            row.size ?? null,
            row.color ?? null
          );

          if (available < row.quantity) {
            throw httpError(
              409,
              available > 0
                ? `${item.name}: Only ${available} available for the requested replacement.`
                : `${item.name}: The requested replacement is out of stock.`
            );
          }

          reserveVariantStock(
            product,
            row.quantity,
            row.size ?? null,
            row.color ?? null
          );

          touched.set(
            String(product._id),
            product
          );
        }

        for (
          const product of touched.values()
        ) {
          await product.save({ session });
        }

        order.returnRequest
          .exchangeInventoryReservedAt = now;

        order.refund = {
          status: "not-applicable",
          amount: 0,
          requestedAt: null,
          reference: "",
          refundedAt: null,
        };
      } else {
        const refundAmount =
          calculateReturnRefund(
            order,
            order.returnRequest.items || []
          );

        order.refund = {
          status:
            refundAmount > 0
              ? "pending"
              : "not-applicable",

          amount: refundAmount,

          requestedAt:
            refundAmount > 0 ? now : null,

          reference: "",
          refundedAt: null,
        };
      }

      order.returnRequest.status = "approved";
      order.returnRequest.response = responseText;
      order.returnRequest.respondedAt = now;
      order.returnRequest.approvedAt = now;
      order.returnRequest.rejectedAt = null;
      order.returnRequest.completedAt = null;

      order.returnRequest
        .originalInventoryRestoredAt = null;

      ensureTracking(order);

      order.tracking.events.push({
        status:
          type === "exchange"
            ? "exchange-approved"
            : "return-approved",

        description:
          type === "exchange"
            ? "Exchange request approved by GymDrobe. Replacement stock has been reserved."
            : "Return request approved by GymDrobe.",

        timestamp: now,
      });

      await order.save({ session });

      savedOrder = order;
    });

    if (!savedOrder) {
      throw new Error(
        "Return request review failed."
      );
    }

    return res.status(200).json({
      success: true,
      existing: existingDecision,

      message: existingDecision
        ? `This request is already ${savedOrder.returnRequest.status}.`
        : decision === "approve"
          ? "Request approved successfully."
          : "Request rejected successfully.",

      order: safeOrder(savedOrder),
    });
  } catch (error) {
    console.error(
      "Admin return review error:",
      error
    );

    return res.status(
      error.status || 500
    ).json({
      success: false,
      message:
        error.message ||
        "Unable to review this request.",
    });
  } finally {
    await session.endSession();
  }
}

// ======================================================
// ADMIN — COMPLETE APPROVED RETURN OR EXCHANGE
// ======================================================

async function completeReturnRequest(
  req,
  res
) {
  const id = cleanString(
    req.params.id,
    150
  );

  const responseText = cleanString(
    req.body?.response,
    1000
  );

  const session =
    await mongoose.startSession();

  let savedOrder = null;
  let alreadyCompleted = false;

  try {
    await session.withTransaction(async () => {
      savedOrder = null;

      const order = await Order.findOne({
        $or: orderLookupConditions(id),
      }).session(session);

      if (!order) {
        throw httpError(
          404,
          "Order not found."
        );
      }

      if (
        order.returnRequest?.status ===
        "completed"
      ) {
        alreadyCompleted = true;
        savedOrder = order;
        return;
      }

      if (
        !order.returnRequest ||
        order.returnRequest.status !==
          "approved"
      ) {
        throw httpError(
          409,
          "Only an approved return or exchange can be completed."
        );
      }

      const type =
        order.returnRequest.type;

      if (
        !["return", "exchange"].includes(type)
      ) {
        throw httpError(
          409,
          "This order does not contain a valid return request."
        );
      }

      if (order.status !== "delivered") {
        throw httpError(
          409,
          "Only a delivered order can have its return completed."
        );
      }

      validatedRows(order);

      const now = new Date();
      const cache = new Map();
      const touched = new Map();

      // Support older approved exchanges where replacement
      // stock has not yet been reserved.
      if (
        type === "exchange" &&
        !order.returnRequest
          .exchangeInventoryReservedAt
      ) {
        for (
          const row of
          order.returnRequest.items || []
        ) {
          const item =
            order.items[row.index];

          if (!item) {
            throw httpError(
              409,
              "An exchange item is no longer valid."
            );
          }

          const product =
            await loadProductForInventory(
              item,
              session,
              cache
            );

          if (product.isActive === false) {
            throw httpError(
              409,
              `${item.name}: This product is no longer available.`
            );
          }

          const available = getVariantStock(
            product,
            row.size ?? null,
            row.color ?? null
          );

          if (available < row.quantity) {
            throw httpError(
              409,
              available > 0
                ? `${item.name}: Only ${available} available for the requested replacement.`
                : `${item.name}: The requested replacement is out of stock.`
            );
          }

          reserveVariantStock(
            product,
            row.quantity,
            row.size ?? null,
            row.color ?? null
          );

          touched.set(
            String(product._id),
            product
          );
        }

        order.returnRequest
          .exchangeInventoryReservedAt = now;
      }

      // Completing the request retains your existing
      // behaviour of restoring returned original stock.
      if (
        !order.returnRequest
          .originalInventoryRestoredAt
      ) {
        for (
          const row of
          order.returnRequest.items || []
        ) {
          const item =
            order.items[row.index];

          if (!item) {
            throw httpError(
              409,
              "A return item is no longer valid."
            );
          }

          const product =
            await loadProductForInventory(
              item,
              session,
              cache
            );

          restoreVariantStock(
            product,
            row.quantity,
            item.selectedSize ?? null,
            item.selectedColor ?? null
          );

          touched.set(
            String(product._id),
            product
          );
        }

        order.returnRequest
          .originalInventoryRestoredAt = now;
      }

      for (
        const product of touched.values()
      ) {
        await product.save({ session });
      }

      order.returnRequest.status = "completed";
      order.returnRequest.completedAt = now;
      order.returnRequest.respondedAt = now;

      if (responseText) {
        order.returnRequest.response =
          responseText;
      }

      if (type === "return") {
        // Recalculate instead of trusting an older,
        // potentially excessive approved amount.
        const amount = calculateReturnRefund(
          order,
          validatedRows(order)
        );

        if (!order.refund) {
          order.refund = blankRefund();
        }

        order.refund.amount = amount;

        order.refund.requestedAt =
          order.refund?.requestedAt ||
          order.returnRequest?.approvedAt ||
          now;

        order.refund.reference =
          order.refund?.reference || "";

        order.refund.refundedAt = null;

        order.refund.status =
          amount > 0
            ? "manual-required"
            : "not-applicable";
      } else {
        order.refund = {
          status: "not-applicable",
          amount: 0,
          requestedAt: null,
          reference: "",
          refundedAt: null,
        };
      }

      ensureTracking(order);

      order.tracking.events.push({
        status:
          type === "exchange"
            ? "exchange-completed"
            : "return-completed",

        description:
          type === "exchange"
            ? "Exchange completed by GymDrobe."
            : order.refund.status ===
                "manual-required"
              ? "Return completed by GymDrobe. Refund requires manual processing."
              : "Return completed by GymDrobe. No refund amount is due.",

        timestamp: now,
      });

      await order.save({ session });

      savedOrder = order;
    });

    if (!savedOrder) {
      throw new Error(
        "Return request completion failed."
      );
    }

    return res.status(200).json({
      success: true,
      existing: alreadyCompleted,

      message: alreadyCompleted
        ? "This request is already completed."
        : savedOrder.returnRequest?.type ===
            "exchange"
          ? "Exchange completed successfully."
          : savedOrder.refund?.status ===
              "manual-required"
            ? "Return completed. The refund now requires manual processing."
            : "Return completed successfully.",

      order: safeOrder(savedOrder),
    });
  } catch (error) {
    console.error(
      "Admin return completion error:",
      error
    );

    return res.status(
      error.status || 500
    ).json({
      success: false,
      message:
        error.message ||
        "Unable to complete this request.",
    });
  } finally {
    await session.endSession();
  }
}

// ======================================================
// ADMIN — RECORD A MANUALLY PROCESSED REFUND
//
// This records a completed refund.
// It does not send money through Razorpay.
// ======================================================

async function recordReturnRefund(req, res) {
  const id = cleanString(
    req.params.id,
    150
  );

  const reference = cleanString(
    req.body?.reference,
    200
  );

  if (reference.length < 3) {
    return res.status(400).json({
      success: false,
      message:
        "Enter a valid refund reference.",
    });
  }

  const session =
    await mongoose.startSession();

  let savedOrder = null;
  let alreadyRefunded = false;

  try {
    await session.withTransaction(async () => {
      savedOrder = null;

      const order = await Order.findOne({
        $or: orderLookupConditions(id),
      }).session(session);

      if (!order) {
        throw httpError(
          404,
          "Order not found."
        );
      }

      if (
        order.returnRequest?.type !==
        "return"
      ) {
        throw httpError(
          409,
          "Refund recording is only available for return requests."
        );
      }

      if (
        order.returnRequest?.status !==
        "completed"
      ) {
        throw httpError(
          409,
          "Complete the return before recording its refund."
        );
      }

      if (
        order.refund?.status === "refunded"
      ) {
        alreadyRefunded = true;
        savedOrder = order;
        return;
      }

      const amount = Number(
        order.refund?.amount || 0
      );

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        throw httpError(
          409,
          "There is no refund amount to record for this return."
        );
      }

      if (
        ![
          "pending",
          "manual-required",
        ].includes(order.refund?.status)
      ) {
        throw httpError(
          409,
          "This refund is not waiting for manual processing."
        );
      }

      const maximumRefund =
        calculateReturnRefund(
          order,
          validatedRows(order)
        );

      if (
        roundMoney(amount) > maximumRefund
      ) {
        throw httpError(
          409,
          "The refund exceeds the returned-item value or recorded amount paid. Reconcile it before recording payment."
        );
      }

      const now = new Date();

      order.refund.status = "refunded";
      order.refund.reference = reference;
      order.refund.refundedAt = now;

      ensureTracking(order);

      order.tracking.events.push({
        status: "refund-recorded",
        description:
          "Return refund recorded by GymDrobe.",
        timestamp: now,
      });

      await order.save({ session });

      savedOrder = order;
    });

    if (!savedOrder) {
      throw new Error(
        "Refund recording failed."
      );
    }

    return res.status(200).json({
      success: true,
      existing: alreadyRefunded,

      message: alreadyRefunded
        ? "This refund has already been recorded."
        : "Refund recorded successfully.",

      order: safeOrder(savedOrder),
    });
  } catch (error) {
    console.error(
      "Admin refund record error:",
      error
    );

    return res.status(
      error.status || 500
    ).json({
      success: false,
      message:
        error.message ||
        "Unable to record this refund.",
    });
  } finally {
    await session.endSession();
  }
}

module.exports = {
  requestReturn,
  getAdminReturnRequests,
  reviewReturnRequest,
  completeReturnRequest,
  recordReturnRefund,
};