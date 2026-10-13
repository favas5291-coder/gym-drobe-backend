const express = require("express");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  getAdminKits,
  createKitDrafts,
  getAdminKit,
  updateAdminKit,
} = require("../middleware/controllers/kitAdminController");

const {
  previewKitQuote,
} = require("../middleware/controllers/kitQuoteController");

const {
  getCustomerKits,
  getCustomerKit,
  quoteCustomerKit,
} = require("../middleware/controllers/kitCustomerController");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Protect every admin endpoint.
router.use("/admin", protect, adminOnly);

// Named admin routes must precede public "/:id".
router.get("/admin", getAdminKits);

router.post(
  "/admin/defaults",
  createKitDrafts,
);

router.post(
  "/admin/:id/quote",
  previewKitQuote,
);

router.get(
  "/admin/:id",
  getAdminKit,
);

router.put(
  "/admin/:id",
  updateAdminKit,
);

// Public builder endpoints.
// Only published templates are available here.
router.get("/", getCustomerKits);

router.post(
  "/:id/quote",
  quoteCustomerKit,
);

router.get(
  "/:id",
  getCustomerKit,
);

module.exports = router;