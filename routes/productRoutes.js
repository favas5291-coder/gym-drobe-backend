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

const source = require("../utils/productSource");
const marketplace = require("../utils/marketplace/service");
const media = require("../utils/marketplace/media");
const sourceLimits = new Map();
router.post("/source-preview", protect, async (req,res) => {
  try {
    if(req.user.role !== "admin") {
      if (!marketplace.enabled()) return res.status(403).json({message: "Supplier access is unavailable."});
      await marketplace.account(req.user,null,null,true);
    }
    const now=Date.now(), key=String(req.user._id);
    for(const [id,window] of sourceLimits) if(window.until<=now) sourceLimits.delete(id);
    const window=sourceLimits.get(key)||{until:now+60000,count:0};
    if(++window.count>20) return res.status(429).json({message:"Please retry in a minute."});
    sourceLimits.set(key,window);
    const isImage=req.body.kind==="image";
    const result=await source.readPublic(req.body.url,isImage);
    if(isImage) return res.json({success:true,...await media.upload(req.user,{kind:"product",mime:result.type,base64:result.buffer.toString("base64")})});
    res.json({success:true,...source.suggestions(result.buffer.toString("utf8"),result.url)});
  } catch(error) {
    res.status(error.status||422).json({message:error.status?error.message:"Could not read this source. You can enter the details manually."});
  }
});

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