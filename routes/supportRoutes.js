const router =
  require("express").Router();

const {
  protect,
  adminOnly,
} = require(
  "../middleware/authMiddleware",
);

const controller = require(
  "../controllers/supportController",
);

router.use(protect);

// Keep admin routes before "/:id".
router.get(
  "/admin/tickets",
  adminOnly,
  controller.listTickets,
);

router.get(
  "/admin/tickets/:id",
  adminOnly,
  controller.getTicket,
);

router.post(
  "/admin/tickets/:id/replies",
  adminOnly,
  controller.reply,
);

router.put(
  "/admin/tickets/:id/status",
  adminOnly,
  controller.updateStatus,
);

// Customer routes.
router.get(
  "/",
  controller.listTickets,
);

router.post(
  "/",
  controller.createTicket,
);

router.get(
  "/:id",
  controller.getTicket,
);

router.post(
  "/:id/replies",
  controller.reply,
);

module.exports = router;