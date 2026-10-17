const express = require("express");

const {
  createOrder,
  getOrders,
  getOrderById,
  cancelOrder,
  requestReturn,

  getAdminOrders,
  getAdminOrderById,
  updateAdminOrderStatus,
  updateAdminKitFulfillment,

  getAdminReturnRequests,
  reviewReturnRequest,
  recordReturnRefund,
} = require("../middleware/controllers/orderController");

const {
  completeInspectedReturn,
} = require("../middleware/controllers/returnCompletionController");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  customerAccess,
} = require("../middleware/customerAccess");

const router = express.Router();

// Order responses must not be cached.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use((req, res, next) => {
  const adminPath =
    req.path === "/admin" ||
    req.path.startsWith("/admin/");

  // Admin routes require account authentication.
  // Each admin route also checks the account role.
  if (adminPath) {
    return protect(req, res, next);
  }

  // Customer routes accept a verified account
  // or a verified private guest session.
  return customerAccess(req, res, next);
});

// Customer orders.
router
  .route("/")
  .get(getOrders)
  .post(createOrder);

// Admin order management.
router.get(
  "/admin/orders",
  adminOnly,
  getAdminOrders,
);

router.put(
  "/admin/orders/:id/status",
  adminOnly,
  updateAdminOrderStatus,
);

router.put(
  "/admin/orders/:id/kit-fulfillment",
  adminOnly,
  updateAdminKitFulfillment,
);

router.get(
  "/admin/orders/:id",
  adminOnly,
  getAdminOrderById,
);

// Admin returns and exchanges.
router.get(
  "/admin/returns",
  adminOnly,
  getAdminReturnRequests,
);

router.put(
  "/admin/returns/:id/review",
  adminOnly,
  reviewReturnRequest,
);

// Preserve inspection-based return completion.
router.put(
  "/admin/returns/:id/complete",
  adminOnly,
  completeInspectedReturn,
);

router.put(
  "/admin/returns/:id/refund",
  adminOnly,
  recordReturnRefund,
);

// Customer cancellation.
router.put(
  "/:id/cancel",
  cancelOrder,
);

// Customer return or exchange request.
router.post(
  "/:id/return",
  requestReturn,
);

// Keep generic lookup after named routes.
router.get(
  "/:id",
  getOrderById,
);

module.exports = router;