"use strict";

const express = require("express");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  getShippingSettings,
  updateShippingSettings,
} = require(
  "../middleware/controllers/shippingSettingsController"
);

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use(protect, adminOnly);

router.get("/", getShippingSettings);
router.put("/", updateShippingSettings);

module.exports = router;