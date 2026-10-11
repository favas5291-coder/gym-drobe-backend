const express = require("express");

const {
  getSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  setSupplierStatus,
  setSupplierVerification,
} = require("../middleware/controllers/supplierController");

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

router
  .route("/")
  .get(getSuppliers)
  .post(createSupplier);

router.patch(
  "/:id/status",
  setSupplierStatus
);

router.patch(
  "/:id/verification",
  setSupplierVerification
);

router
  .route("/:id")
  .get(getSupplierById)
  .put(updateSupplier);

module.exports = router;