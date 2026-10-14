const express = require("express");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  getCustomers,
  getCustomer,
  setCustomerStatus,
} = require("../middleware/controllers/customerAdminController");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use(protect, adminOnly);

router.get("/", getCustomers);

router.get("/:id", getCustomer);

router.patch(
  "/:id/status",
  setCustomerStatus
);

module.exports = router;