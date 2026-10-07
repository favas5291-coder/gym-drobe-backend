const express = require("express");

const {
  getProducts,
  getProductById,
  getAdminProducts,
  getAdminProductById,
  getAdminProductOptions,
  createProduct,
  updateProduct,
  updateProductInventory,
  deleteProduct,
  restoreProduct,
} = require("../controllers/productController");

const {
  getReviews,
  saveReview,
  deleteReview,
} = require("../controllers/reviewController");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", getProducts);

// Named admin routes must come before /admin/:id.
router.get(
  "/admin/options",
  protect,
  adminOnly,
  getAdminProductOptions
);

router.get("/admin", protect, adminOnly, getAdminProducts);

router.get(
  "/admin/:id",
  protect,
  adminOnly,
  getAdminProductById
);

router.post("/", protect, adminOnly, createProduct);

router.put(
  "/:id/inventory",
  protect,
  adminOnly,
  updateProductInventory
);

router.put(
  "/:id/restore",
  protect,
  adminOnly,
  restoreProduct
);

router.get("/:id/reviews", getReviews);
router.put("/:id/reviews", protect, saveReview);
router.delete("/:id/reviews", protect, deleteReview);

router.get("/:id", getProductById);
router.put("/:id", protect, adminOnly, updateProduct);
router.delete("/:id", protect, adminOnly, deleteProduct);

module.exports = router;