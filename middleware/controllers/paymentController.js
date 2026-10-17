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

function containsPurchasedKitData(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  const named = [
    "kits",
    "kitGroups",
    "kitSnapshots",
  ].some(
    (key) =>
      Object.prototype.hasOwnProperty.call(
        body,
        key,
      ),
  );

  const purchasedItems =
    Array.isArray(body.items) &&
    body.items.some(
      (row) =>
        row &&
        Object.prototype.hasOwnProperty.call(
          row,
          "kit",
        ),
    );

  return named || purchasedItems;
}

// Payment routes authenticate an account or a private guest session.
// Kit selections use item.kitGroup; purchased snapshots are server-owned.
// Razorpay controller reloads prices, stock and shipping before purchase.
function createRazorpayOrder(req, res) {
  res.set("Cache-Control", "no-store");

  if (containsPurchasedKitData(req.body)) {
    return errorResponse(
      res,
      400,
      "INVALID_CHECKOUT",
      "Send kit selections from your bag. Purchased kit snapshots cannot be submitted to checkout.",
    );
  }

  return razorpay.createRazorpayOrder(req, res);
}

// Public, rate-limited, read-only preview configured in paymentRoutes.
// Prices and fulfillment details come from server-loaded records.
async function getCheckoutQuote(req, res) {
  res.set("Cache-Control", "no-store");

  try {
    const { quote } = await loadCheckoutReview(
      req.body,
    );

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
      error?.name || "Error",
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

  verifyRazorpayPayment:
    razorpay.verifyRazorpayPayment,

  finalizeCapturedPayment:
    razorpay.finalizeCapturedPayment,
};