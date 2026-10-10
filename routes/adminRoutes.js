const express = require("express");

const {
  getDashboard,
  getCustomers,
  setCustomerStatus,
} = require("../controllers/adminController");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use(protect, adminOnly);

router.get("/dashboard", getDashboard);
router.get("/customers", getCustomers);

router.patch(
  "/customers/:id/status",
  setCustomerStatus,
);

module.exports = router;