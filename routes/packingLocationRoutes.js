const express = require("express");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  getPackingLocations,
  getPackingLocation,
  createPackingLocation,
  updatePackingLocation,
  confirmPackingLocation,
  confirmSupplierArrangement,
  confirmGymDrobeStockTransfer,
} = require("../middleware/controllers/packingLocationController");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Every packing-location route requires an admin session.
router.use(protect, adminOnly);

// List and create locations.
router.get("/", getPackingLocations);
router.post("/", createPackingLocation);

// Read and update a location.
// Updates must include its current version.
router.get("/:id", getPackingLocation);
router.put("/:id", updatePackingLocation);

// Confirm the real packing arrangement.
router.post(
  "/:id/confirm",
  confirmPackingLocation,
);

// Confirm a supplier-to-location agreement.
router.post(
  "/:id/suppliers/:supplierId/confirm",
  confirmSupplierArrangement,
);

// Confirm the GymDrobe-held stock transfer arrangement.
// The controller checks the saved products and records
// the signed-in admin and server confirmation time.
router.post(
  "/:id/gymdrobe-stock-transfer/confirm",
  confirmGymDrobeStockTransfer,
);

module.exports = router;