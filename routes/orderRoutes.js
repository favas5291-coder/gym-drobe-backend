const express = require("express");

const {
  createOrder,
  getOrders,
  getOrderById,
  cancelOrder,
  getAdminOrders,
  getAdminOrderById,
  updateAdminOrderStatus,
} = require("../controllers/orderController");

const {
  requestReturn,
  getAdminReturnRequests,
  reviewReturnRequest,
  completeReturnRequest,
  recordReturnRefund,
} = require("../controllers/returnController");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const router = express.Router();

// All order routes require authentication.
router.use(protect);

// Customer orders.
router
  .route("/")
  .get(getOrders)
  .post(createOrder);

// Admin order routes.
router.get(
  "/admin/orders",
  adminOnly,
  getAdminOrders
);

router.put(
  "/admin/orders/:id/status",
  adminOnly,
  updateAdminOrderStatus
);

router.get(
  "/admin/orders/:id",
  adminOnly,
  getAdminOrderById
);

// Admin return and exchange routes.
router.get(
  "/admin/returns",
  adminOnly,
  getAdminReturnRequests
);

router.put(
  "/admin/returns/:id/review",
  adminOnly,
  reviewReturnRequest
);

router.put(
  "/admin/returns/:id/complete",
  adminOnly,
  completeReturnRequest
);

router.put(
  "/admin/returns/:id/refund",
  adminOnly,
  recordReturnRefund
);

// Customer cancellation.
router.put(
  "/:id/cancel",
  cancelOrder
);

// Customer return or exchange request.
router.post(
  "/:id/return",
  requestReturn
);

// Keep this route after the admin routes.
router.get(
  "/:id",
  getOrderById
);

module.exports = router;