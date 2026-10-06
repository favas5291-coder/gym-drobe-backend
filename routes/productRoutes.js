const express = require("express");

const {
  getProducts,
  getProductById,
  getAdminProducts,
  getAdminProductById,
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

// Public catalog
router.get("/", getProducts);

// Admin routes must appear before "/:id".
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

// Create product
router.post(
  "/",
  protect,
  adminOnly,
  createProduct,
);

// Inventory
router.put(
  "/:id/inventory",
  protect,
  adminOnly,
  updateProductInventory,
);

// Restore archived product
router.put(
  "/:id/restore",
  protect,
  adminOnly,
  restoreProduct,
);

// Reviews: public reading, authenticated writing
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

// Public product details
router.get("/:id", getProductById);

// Update product
router.put(
  "/:id",
  protect,
  adminOnly,
  updateProduct,
);

// Archive product
router.delete(
  "/:id",
  protect,
  adminOnly,
  deleteProduct,
);

module.exports = router;