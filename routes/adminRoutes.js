const express = require("express");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  getDashboard,
  getCustomers,
} = require("../controllers/adminController");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use(protect, adminOnly);

router.get("/dashboard", getDashboard);
router.get("/customers", getCustomers);

module.exports = router;