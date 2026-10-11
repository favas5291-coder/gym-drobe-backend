const express = require("express");

const {
  getDashboard,
  getCustomers,
  setCustomerStatus,
} = require("../middleware/controllers/adminController");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const router = express.Router();

// Prevent caching private admin information.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Every route below requires an active admin account.
router.use(protect, adminOnly);

// Dashboard statistics.
router.get("/dashboard", getDashboard);

// Customer list.
router.get("/customers", getCustomers);

// Block or unblock a customer.
router.patch(
  "/customers/:id/status",
  setCustomerStatus,
);

module.exports = router;