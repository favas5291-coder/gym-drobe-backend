const express = require("express");

const {
  getCheckoutQuote,
  createRazorpayOrder,
  verifyRazorpayPayment,
} = require("../middleware/controllers/paymentController");

const {
  customerAccess,
  checkoutRateLimit,
  createGuestSession,
  checkGuestSession,
} = require("../middleware/customerAccess");

const router = express.Router();

// Checkout and payment responses must not be cached.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use(checkoutRateLimit);

// POST /api/payments/guest-session
// Create or reuse a private guest checkout session.
router.post(
  "/guest-session",
  createGuestSession,
);

// GET /api/payments/guest-session
// Check a private guest access code.
router.get(
  "/guest-session",
  checkGuestSession,
);

// POST /api/payments/checkout/quote
// Login is optional; prices come from backend records.
// Does not create an order, reserve stock or start payment.
router.post(
  "/checkout/quote",
  getCheckoutQuote,
);

// POST /api/payments/razorpay/order
// Full online payment or COD with a 10% advance.
// Requires a verified account or private guest session.
router.post(
  "/razorpay/order",
  customerAccess,
  createRazorpayOrder,
);

// POST /api/payments/razorpay/verify
// Verify the signature and actual provider payment details.
// Requires a verified account or private guest session.
router.post(
  "/razorpay/verify",
  customerAccess,
  verifyRazorpayPayment,
);

module.exports = router;