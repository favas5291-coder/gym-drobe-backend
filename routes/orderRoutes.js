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
  recordReturnRefund,
} = require("../middleware/controllers/orderController");

const {
  completeInspectedReturn,
} = require("../middleware/controllers/returnCompletionController");

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

router
  .route("/")
  .get(getOrders)
  .post(createOrder);

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

// Completion now requires recorded inspection quantities.
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

router.put("/:id/cancel", cancelOrder);

router.post("/:id/return", requestReturn);

// Keep generic lookup after named routes.
router.get("/:id", getOrderById);

module.exports = router;