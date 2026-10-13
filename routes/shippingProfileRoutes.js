const express = require("express");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  getShippingProfiles,
  getShippingProfile,
  createShippingProfile,
  updateShippingProfile,
  confirmShippingProfile,
} = require("../middleware/controllers/shippingProfileController");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// All shipping-profile routes require an admin session.
router.use(protect, adminOnly);

router.get("/", getShippingProfiles);
router.post("/", createShippingProfile);

router.get("/:id", getShippingProfile);
router.put("/:id", updateShippingProfile);

router.post(
  "/:id/confirm",
  confirmShippingProfile,
);

module.exports = router;