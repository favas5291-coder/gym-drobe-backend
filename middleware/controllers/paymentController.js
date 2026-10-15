"use strict";

const {
  loadCheckoutReview,
} = require("../../utils/checkoutReview");

const razorpay = require("./razorpayController");

function errorResponse(res, status, code, message) {
  return res.status(status).json({
    success: false,
    code,
    message,
  });
}

function includesKit(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  const named = ["kits", "kitGroups", "kitSnapshots"].some(
    (key) => Object.prototype.hasOwnProperty.call(body, key),
  );

  return (
    named ||
    (
      Array.isArray(body.items) &&
      body.items.some(
        (row) =>
          row &&
          ["kitGroup", "kit"].some(
            (key) =>
              Object.prototype.hasOwnProperty.call(row, key),
          ),
      )
    )
  );
}

// Ordinary product payments use the existing payment flow.
// Kit payments stay blocked until checkout integration is complete.
function createRazorpayOrder(req, res) {
  res.set("Cache-Control", "no-store");

  if (includesKit(req.body)) {
    return errorResponse(
      res,
      409,
      "KIT_CHECKOUT_NOT_READY",
      "Kit payment is not enabled yet. You can save and edit kits in your bag. Check My orders before retrying any previous payment.",
    );
  }

  return razorpay.createRazorpayOrder(req, res);
}

// Authenticated, read-only checkout preview.
// Prices and fulfillment details come from server-loaded records.
async function getCheckoutQuote(req, res) {
  res.set("Cache-Control", "no-store");

  if (!req.user?._id) {
    return errorResponse(
      res,
      401,
      "AUTHENTICATION_REQUIRED",
      "Please sign in to review checkout.",
    );
  }

  try {
    const { quote } = await loadCheckoutReview(req.body);

    return res.json({
      success: true,
      quote,
    });
  } catch (error) {
    if (error?.gymdrobe === true) {
      return errorResponse(
        res,
        error.status || 400,
        error.code || "INVALID_CHECKOUT",
        error.message,
      );
    }

    console.error(
      "Checkout preview failed:",
      error.name || "Error",
    );

    return errorResponse(
      res,
      503,
      "CHECKOUT_PREVIEW_UNAVAILABLE",
      "Checkout prices could not be checked. Please retry. No payment was started.",
    );
  }
}

module.exports = {
  getCheckoutQuote,
  createRazorpayOrder,
  verifyRazorpayPayment: razorpay.verifyRazorpayPayment,
  finalizeCapturedPayment: razorpay.finalizeCapturedPayment,
};