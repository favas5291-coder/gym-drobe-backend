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
} = require("../middleware/controllers/productController");

const {
  getReviews,
  saveReview,
  deleteReview,
} = require("../middleware/controllers/reviewController");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const router = express.Router();

// Public catalogue.
router.get("/", getProducts);

// Named admin routes must come before /admin/:id.
router.get(
  "/admin/options",
  protect,
  adminOnly,
  getAdminProductOptions,
);

router.get(
  "/admin",
  protect,
  adminOnly,
  getAdminProducts,
);

router.get(
  "/admin/:id",
  protect,
  adminOnly,
  getAdminProductById,
);

// Create product.
router.post(
  "/",
  protect,
  adminOnly,
  createProduct,
);

// Update inventory.
router.put(
  "/:id/inventory",
  protect,
  adminOnly,
  updateProductInventory,
);

// Restore archived product.
router.put(
  "/:id/restore",
  protect,
  adminOnly,
  restoreProduct,
);

// Public review reading; authenticated review changes.
router.get("/:id/reviews", getReviews);

router.put(
  "/:id/reviews",
  protect,
  saveReview,
);

router.delete(
  "/:id/reviews",
  protect,
  deleteReview,
);

// Product details.
router.get("/:id", getProductById);

// Update product.
router.put(
  "/:id",
  protect,
  adminOnly,
  updateProduct,
);

// Archive product.
router.delete(
  "/:id",
  protect,
  adminOnly,
  deleteProduct,
);

module.exports = router;