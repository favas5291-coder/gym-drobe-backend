const express = require("express");

const {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
} = require("../controllers/authController");

const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

// Per-process protection for public authentication endpoints.
// For multiple backend instances, use a shared rate-limit store.
function rateLimit(maximum, windowMs) {
  const buckets = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.expiresAt <= now) buckets.delete(key);
    }
  }, 60000);

  cleanup.unref();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.expiresAt <= now) {
      // Keep memory bounded.
      if (!bucket && buckets.size >= 10000) {
        return res.status(503).json({
          success: false,
          message: "Please try again shortly.",
        });
      }

      bucket = { count: 0, expiresAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > maximum) {
      res.set(
        "Retry-After",
        String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)))
      );

      return res.status(429).json({
        success: false,
        message: "Too many attempts. Please try again later.",
      });
    }

    return next();
  };
}

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.post("/register", rateLimit(10, 15 * 60000), register);
router.post("/login", rateLimit(30, 15 * 60000), login);

router.post(
  "/forgot-password",
  rateLimit(5, 15 * 60000),
  forgotPassword
);

router.post(
  "/reset-password",
  rateLimit(10, 15 * 60000),
  resetPassword
);

router.get("/me", protect, getMe);
router.put("/profile", protect, updateProfile);
router.put("/password", protect, changePassword);

module.exports = router;