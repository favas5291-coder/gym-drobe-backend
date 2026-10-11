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

  getAdminReturnRequests,
  reviewReturnRequest,
  completeReturnRequest,
  recordReturnRefund,
} = require("../middleware/controllers/orderController");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use(protect);

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

router.get(
  "/admin/orders/:id",
  adminOnly,
  getAdminOrderById,
);

// Return and exchange handlers come from orderController.
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

router.put(
  "/admin/returns/:id/complete",
  adminOnly,
  completeReturnRequest,
);

router.put(
  "/admin/returns/:id/refund",
  adminOnly,
  recordReturnRefund,
);

// Customer cancellation and returns.
router.put("/:id/cancel", cancelOrder);

router.post("/:id/return", requestReturn);

// Keep the generic lookup last.
router.get("/:id", getOrderById);

module.exports = router;