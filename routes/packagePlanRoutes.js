const express = require("express");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  getPackagePlans,
  getPackagePlan,
  createPackagePlan,
  updatePackagePlan,
  confirmPackagePlan,
} = require("../middleware/controllers/packagePlanController");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use(protect, adminOnly);

router.get("/", getPackagePlans);

router.post("/", createPackagePlan);

router.get("/:id", getPackagePlan);

router.put("/:id", updatePackagePlan);

router.post(
  "/:id/confirm",
  confirmPackagePlan
);

module.exports = router;