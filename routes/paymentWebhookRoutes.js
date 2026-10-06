const express =
  require("express");

const {
  razorpayWebhook,
} =
  require(
    "../controllers/paymentWebhookController"
  );


const router =
  express.Router();


// ======================================================
// RAZORPAY WEBHOOK
//
// FINAL URL:
//
// POST /api/payment-webhooks/razorpay
//
// IMPORTANT:
//
// Do NOT add:
// - protect middleware
// - express.json()
// - authentication
//
// Razorpay calls this route directly.
//
// The raw request body is provided by server.js so the
// webhook signature can be verified correctly.
// ======================================================

router.post(
  "/razorpay",
  razorpayWebhook
);


// ======================================================
// EXPORT
// ======================================================

module.exports =
  router;