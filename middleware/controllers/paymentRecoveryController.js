"use strict";

const crypto = require("node:crypto");

const Order = require("../../models/Order");

const {
  customerFilter,
} = require("../../utils/customerAccess");

const {
  recoverOrderPayment,
} = require("../../utils/paymentRecovery");

// Payment-status checks use a separate quota.
// They must not exhaust the checkout/payment-creation quota.
const buckets = new Map();

function paymentRecoveryRateLimit(req, res, next) {
  const principal = req.user?._id
    ? `user:${req.user._id}`
    : req.guestSession?._id
      ? `guest:${req.guestSession._id}`
      : "";

  if (!principal) {
    return res.status(401).json({
      success: false,
      message: "Order access is required.",
    });
  }

  const now = Date.now();

  if (buckets.size >= 5000) {
    for (const [key, row] of buckets) {
      if (row.until <= now) {
        buckets.delete(key);
      }
    }
  }

  const key = crypto
    .createHash("sha256")
    .update(principal)
    .digest("hex");

  let row = buckets.get(key);

  if (!row || row.until <= now) {
    if (buckets.size >= 10000) {
      return res.status(503).json({
        success: false,
        message:
          "Payment checks are busy. Retry shortly; do not pay again.",
      });
    }

    row = {
      count: 0,
      until: now + 60000,
    };

    buckets.set(key, row);
  }

  row.count += 1;

  if (row.count > 20) {
    const retryAfter = Math.max(
      1,
      Math.ceil((row.until - now) / 1000),
    );

    res.set("Retry-After", String(retryAfter));

    return res.status(429).json({
      success: false,
      message:
        "Please wait before checking payment again. Do not pay again.",
    });
  }

  return next();
}

async function check(req, res, admin) {
  res.set("Cache-Control", "no-store");

  try {
    const value = admin
      ? req.params.id
      : req.body?.orderId;

    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 150 ||
      /[\u0000-\u0020\u007f]/.test(value)
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_ORDER_ID",
        message: "Enter a valid order number.",
      });
    }

    const identifier = /^[a-f0-9]{24}$/i.test(value)
      ? { _id: value }
      : { orderNumber: value };

    // Customer requests remain scoped to their verified
    // account or private guest session.
    // The admin route separately requires protect + adminOnly.
    const order = await Order.findOne({
      $and: [
        identifier,
        admin ? {} : customerFilter(req),
      ],
    }).maxTimeMS(3000);

    const result = await recoverOrderPayment(order);

    return res.json({
      success: true,
      result,
    });
  } catch (error) {
    const known = error.gymdrobe === true;

    return res
      .status(known ? error.status || 409 : 503)
      .json({
        success: false,

        code: known
          ? error.code
          : "PAYMENT_CHECK_UNAVAILABLE",

        message: known
          ? error.message
          : "Payment could not be checked. Do not pay again; contact support.",

        verificationUncertain: true,
      });
  }
}

module.exports = {
  paymentRecoveryRateLimit,

  checkCustomerPayment: (req, res) =>
    check(req, res, false),

  checkAdminPayment: (req, res) =>
    check(req, res, true),
};