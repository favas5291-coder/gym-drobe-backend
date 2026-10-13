const express = require("express");

const {
  getCheckoutQuote,
  createRazorpayOrder,
  verifyRazorpayPayment,
} = require("../middleware/controllers/paymentController");

const {
  protect,
} = require("../middleware/authMiddleware");

const router = express.Router();

// Checkout and payment responses must not be cached.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// All routes require login.
router.use(protect);

// POST /api/payments/checkout/quote
// Calculates a pricing preview.
// Does not create an order, reserve stock or start payment.
router.post(
  "/checkout/quote",
  getCheckoutQuote,
);

// POST /api/payments/razorpay/order
// Existing online payment and COD advance flow.
router.post(
  "/razorpay/order",
  createRazorpayOrder,
);

// POST /api/payments/razorpay/verify
// Existing Razorpay payment verification.
router.post(
  "/razorpay/verify",
  verifyRazorpayPayment,
);

module.exports = router;