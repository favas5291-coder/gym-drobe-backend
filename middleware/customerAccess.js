"use strict";

const crypto = require("node:crypto");

const GuestCheckoutSession = require(
  "../models/GuestCheckoutSession"
);

const {
  protect,
} = require("./authMiddleware");

const TOKEN = /^gco_[a-f0-9]{64}$/;

const buckets = new Map();

function digest(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function checkoutRateLimit(req, res, next) {
  const now = Date.now();

  if (buckets.size > 5000) {
    for (const [key, row] of buckets) {
      if (row.until <= now) {
        buckets.delete(key);
      }
    }
  }

  const key =
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown";

  let row = buckets.get(key);

  if (!row || row.until <= now) {
    if (buckets.size >= 10000) {
      return res.status(503).json({
        success: false,
        message: "Please retry shortly.",
      });
    }

    row = {
      count: 0,
      until: now + 15 * 60000,
    };

    buckets.set(key, row);
  }

  row.count += 1;

  if (row.count > 240) {
    const retryAfter = Math.max(
      1,
      Math.ceil((row.until - now) / 1000),
    );

    res.set(
      "Retry-After",
      String(retryAfter),
    );

    return res.status(429).json({
      success: false,
      message:
        "Too many checkout requests. Please wait and retry.",
    });
  }

  return next();
}

async function readGuest(req) {
  const token =
    req.get("X-GymDrobe-Guest") || "";

  if (!TOKEN.test(token)) {
    return null;
  }

  return GuestCheckoutSession.findOne({
    tokenHash: digest(token),

    expiresAt: {
      $gt: new Date(),
    },
  });
}

async function attachCustomer(req, res, next) {
  try {
    req.guestSession = await readGuest(req);

    if (!req.user?._id && !req.guestSession) {
      return res.status(401).json({
        success: false,
        code: "ORDER_ACCESS_REQUIRED",
        message:
          "Sign in or restore your private guest access code to view this order.",
      });
    }

    return next();
  } catch {
    return res.status(503).json({
      success: false,
      message:
        "Order access could not be checked. Please retry.",
    });
  }
}

function customerAccess(req, res, next) {
  // Account credentials must pass authentication.
  // Invalid or blocked accounts cannot fall back to guest access.
  if (req.headers.authorization) {
    return protect(req, res, () =>
      attachCustomer(req, res, next)
    );
  }

  return attachCustomer(req, res, next);
}

async function createGuestSession(req, res) {
  res.set("Cache-Control", "no-store");

  try {
    const current = await readGuest(req);

    if (current) {
      return res.json({
        success: true,
        expiresAt: current.expiresAt,
      });
    }

    const token =
      `gco_${crypto.randomBytes(32).toString("hex")}`;

    const expiresAt = new Date(
      Date.now() + 90 * 86400000
    );

    await GuestCheckoutSession.create({
      tokenHash: digest(token),
      expiresAt,
    });

    return res.status(201).json({
      success: true,
      guestToken: token,
      expiresAt,
    });
  } catch {
    return res.status(503).json({
      success: false,
      message:
        "Guest checkout could not be prepared. Please retry.",
    });
  }
}

async function checkGuestSession(req, res) {
  res.set("Cache-Control", "no-store");

  try {
    const session = await readGuest(req);

    if (!session) {
      return res.status(401).json({
        success: false,
        message:
          "This guest access code is invalid or expired.",
      });
    }

    return res.json({
      success: true,
      expiresAt: session.expiresAt,
    });
  } catch {
    return res.status(503).json({
      success: false,
      message:
        "Guest access could not be checked. Please retry.",
    });
  }
}

module.exports = {
  customerAccess,
  checkoutRateLimit,
  createGuestSession,
  checkGuestSession,
};