const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");

function deny(res, status, message) {
  return res.status(status).json({ success: false, message });
}

async function protect(req, res, next) {
  const authorization = req.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer\s+(\S+)$/i.exec(authorization)
      : null;

  if (!match) {
    return deny(res, 401, "Authentication required.");
  }

  if (!process.env.JWT_SECRET) {
    return deny(res, 503, "Authentication is temporarily unavailable.");
  }

  try {
    const decoded = jwt.verify(match[1], process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });

    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof decoded.userId !== "string" ||
      !mongoose.isObjectIdOrHexString(decoded.userId)
    ) {
      return deny(res, 401, "Invalid login session.");
    }

    const user = await User.findById(decoded.userId).select("+authVersion");

    if (!user) {
      return deny(res, 401, "User account no longer exists.");
    }

    if (user.isActive === false) {
      return deny(res, 403, "This account is disabled.");
    }

    // Older tokens without a version are treated as version zero.
    if ((decoded.authVersion ?? 0) !== (user.authVersion ?? 0)) {
      return deny(res, 401, "Your session expired. Please sign in again.");
    }

    req.user = user;
    return next();
  } catch (error) {
    if (
      ["JsonWebTokenError", "TokenExpiredError", "NotBeforeError"].includes(
        error.name
      )
    ) {
      return deny(res, 401, "Invalid or expired login session.");
    }

    console.error("Authentication service error:", error.name || "Error");

    // A database outage should not be mistaken for an invalid token.
    return deny(res, 503, "Authentication is temporarily unavailable.");
  }
}

function adminOnly(req, res, next) {
  if (!req.user) {
    return deny(res, 401, "Authentication required.");
  }

  if (req.user.role !== "admin") {
    return deny(res, 403, "Admin access required.");
  }

  return next();
}

module.exports = { protect, adminOnly };