const express = require("express");

const {
  getDashboard,
  getCustomers,
  setCustomerStatus,
} = require("../middleware/controllers/adminController");

const {
  getCustomer,
  getCustomers: getFilteredCustomers,
} = require("../middleware/controllers/customerAdminController");

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
router.use("/automation", require("./adminAutomationRoutes"));

// Dashboard statistics.
router.get("/dashboard", getDashboard);
router.get("/reports/daily-operations", require("../middleware/controllers/dailyOperationsController"));

// Customer list.
router.get("/customers", (req, res) => {
  // The current directory requests these controls. Legacy callers keep their original list.
  if (["activity", "sort", "from", "to"].some(key => Object.hasOwn(req.query, key))) {
    return getFilteredCustomers(req, res);
  }
  return getCustomers(req, res);
});
router.get("/customers/:id", getCustomer);

// Block or unblock a customer.
router.patch(
  "/customers/:id/status",
  setCustomerStatus,
);

module.exports = router;