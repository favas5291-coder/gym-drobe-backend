const express =
  require("express");

const {
  createRazorpayOrder,
  verifyRazorpayPayment,
} =
  require(
    "../controllers/paymentController"
  );

const {
  protect,
} =
  require(
    "../middleware/authMiddleware"
  );


const router =
  express.Router();


// ======================================================
// ALL PAYMENT ROUTES REQUIRE LOGIN
// ======================================================

router.use(
  protect
);


// ======================================================
// CREATE RAZORPAY PAYMENT ORDER
//
// POST /api/payments/razorpay/order
//
// Supports:
//
// paymentMethod = "razorpay"
// → full online payment
//
// paymentMethod = "cod-partial"
// → 10% advance payment
// ======================================================

router.post(
  "/razorpay/order",
  createRazorpayOrder
);


// ======================================================
// VERIFY RAZORPAY PAYMENT
//
// POST /api/payments/razorpay/verify
//
// Verifies:
// - Razorpay order ID
// - payment ID
// - signature
// - amount
// - currency
//
// Then:
// full online → payment becomes paid
// COD partial → payment becomes partially-paid
// ======================================================

router.post(
  "/razorpay/verify",
  verifyRazorpayPayment
);


// ======================================================
// EXPORT
// ======================================================

module.exports =
  router;