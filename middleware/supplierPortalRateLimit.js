"use strict";

const crypto = require("node:crypto");

const {
  Quota,
} = require("../models/SupplierPortal");

// Shared MongoDB quotas survive restarts
// and apply across backend instances.
// TTL cleanup is housekeeping;
// the fixed window key enforces expiry itself.
function createSupplierPortalRateLimit({
  model = Quota,
  clock = Date.now,
} = {}) {
  return async (req, res, next) => {
    const reading = req.method === "GET";

    const windowMs = reading
      ? 60000
      : 15 * 60000;

    const maximum = reading ? 120 : 30;

    const now = clock();

    const window = Math.floor(
      now / windowMs
    );

    const expiresAt = new Date(
      (window + 1) * windowMs
    );

    const key = crypto
      .createHash("sha256")
      .update(
        `${req.user._id}:${
          reading ? "read" : "write"
        }:${window}`
      )
      .digest("hex");

    try {
      const update = () =>
        model
          .findOneAndUpdate(
            { _id: key },
            {
              $inc: {
                count: 1,
              },

              $setOnInsert: {
                expiresAt,
              },
            },
            {
              upsert: true,
              returnDocument: "after",
              maxTimeMS: 3000,
            }
          )
          .lean();

      let value;

      try {
        value = await update();
      } catch (error) {
        if (error.code !== 11000) {
          throw error;
        }

        value = await update();
      }

      if (
        !value ||
        value.count > maximum
      ) {
        res.set(
          "Retry-After",
          String(
            Math.max(
              1,
              Math.ceil(
                (expiresAt - now) / 1000
              )
            )
          )
        );

        return res.status(429).json({
          success: false,
          code: "SUPPLIER_RATE_LIMIT",
          message:
            "Too many supplier requests. Please try again later.",
        });
      }

      return next();
    } catch {
      return res.status(503).json({
        success: false,
        code: "SUPPLIER_PORTAL_UNAVAILABLE",
        message:
          "Supplier access is temporarily unavailable. Please retry.",
      });
    }
  };
}

module.exports = {
  createSupplierPortalRateLimit,
};