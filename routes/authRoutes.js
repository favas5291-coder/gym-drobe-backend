const express = require("express");

const {
  googleChallenge,
  googleLogin,
  getMe,
  updateProfile,
} = require("../controllers/authController");

const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

// Limits are stored in this backend process.
// Multiple instances require a shared rate-limit store.
function rateLimit(maximum, windowMs) {
  const buckets = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();

    for (const [key, bucket] of buckets) {
      if (bucket.expiresAt <= now) {
        buckets.delete(key);
      }
    }
  }, 60000);

  cleanup.unref();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    let bucket = buckets.get(key);

    if (!bucket || bucket.expiresAt <= now) {
      if (!bucket && buckets.size >= 10000) {
        return res.status(503).json({
          success: false,
          message: "Please try again shortly.",
        });
      }

      bucket = {
        count: 0,
        expiresAt: now + windowMs,
      };

      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > maximum) {
      const retryAfter = Math.max(
        1,
        Math.ceil((bucket.expiresAt - now) / 1000)
      );

      res.set("Retry-After", String(retryAfter));

      return res.status(429).json({
        success: false,
        message: "Too many attempts. Please try again later.",
      });
    }

    return next();
  };
}

// Authentication responses must not be cached.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Start a Google sign-in attempt.
router.get(
  "/google/challenge",
  rateLimit(60, 15 * 60000),
  googleChallenge
);

// Verify Google credentials and create a GymDrobe session.
router.post(
  "/google",
  rateLimit(30, 15 * 60000),
  googleLogin
);

// Current account.
router.get("/me", protect, getMe);

// Update customer name and mobile number.
router.put("/profile", protect, updateProfile);

// Old password routes return a clear message.
function googleOnly(req, res) {
  return res.status(410).json({
    success: false,
    message: "Please use Continue with Google to access your account.",
  });
}

router.post("/register", googleOnly);
router.post("/login", googleOnly);
router.post("/forgot-password", googleOnly);
router.post("/reset-password", googleOnly);
router.put("/password", protect, googleOnly);

module.exports = router;