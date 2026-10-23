"use strict";

const express = require("express");
const CartAddonSettings = require("../models/CartAddonSettings");
const Product = require("../models/Product");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  MAX_SETTINGS_VERSION,
  defaultCartAddonSettings,
  normalizeCartAddonSettings,
} = require("../utils/cartAddonSettings");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function respondError(res, status, code, message) {
  return res.status(status).json({
    success: false,
    code,
    message,
  });
}

function publicSettings(record) {
  return normalizeCartAddonSettings({
    version: record.version,
    enabled: record.enabled,
    useCategoryRules: record.useCategoryRules,
    maxSuggestions: record.maxSuggestions,
    excludedProductIds: record.excludedProductIds,
    configuredPairs: record.configuredPairs,
  });
}

function versionConflict(res) {
  return respondError(
    res,
    409,
    "CART_ADDON_SETTINGS_CONFLICT",
    "Cart add-on settings changed since you loaded them. Reload saved settings before trying again.",
  );
}

async function readSettings(req, res) {
  try {
    const record = await CartAddonSettings.findById("store")
      .maxTimeMS(5000)
      .lean();

    const settings = publicSettings(
      record || defaultCartAddonSettings(),
    );

    return res.json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error(
      "Cart add-on settings read failed:",
      error?.name || "Error",
    );

    return respondError(
      res,
      503,
      "CART_ADDON_SETTINGS_UNAVAILABLE",
      "Cart add-on settings could not be loaded. Please retry.",
    );
  }
}

// Storefront reads expose only recommendation settings.
// Admin identity, supplier data and product prices are not returned.
router.get("/settings", readSettings);

router.use("/admin", protect, adminOnly);

router.get("/admin/settings", readSettings);

router.put("/admin/settings", async (req, res) => {
  let submitted;

  try {
    submitted = normalizeCartAddonSettings(req.body);

    if (submitted.version >= MAX_SETTINGS_VERSION) {
      return respondError(
        res,
        400,
        "INVALID_CART_ADDON_SETTINGS",
        "The settings version cannot be increased. Contact support before saving.",
      );
    }
  } catch (error) {
    return respondError(
      res,
      400,
      "INVALID_CART_ADDON_SETTINGS",
      error?.gymdrobe === true
        ? error.message
        : "Send the complete cart add-on settings loaded from the admin page.",
    );
  }

  // Allow the master switch to be turned off even when a previously
  // configured product has been removed or made inactive.
  if (submitted.enabled) {
    const ids = [
      ...new Set(
        submitted.configuredPairs
          .filter((pair) => pair.enabled)
          .flatMap((pair) => [
            pair.sourceId,
            pair.productId,
          ]),
      ),
    ];

    if (ids.length) {
      let products;

      try {
        products = await Product.find({
          _id: {
            $in: ids,
          },

          isActive: true,
        })
          .select("_id")
          .maxTimeMS(5000)
          .lean();

        if (!Array.isArray(products)) {
          throw new Error("INVALID_PRODUCT_RESULT");
        }
      } catch (error) {
        console.error(
          "Cart add-on product check failed:",
          error?.name || "Error",
        );

        return respondError(
          res,
          503,
          "CART_ADDON_PRODUCTS_UNAVAILABLE",
          "Products could not be checked. No settings were saved. Please retry.",
        );
      }

      const activeIds = new Set(
        products.map((product) =>
          String(product._id),
        ),
      );

      if (ids.some((id) => !activeIds.has(id))) {
        return respondError(
          res,
          400,
          "CART_ADDON_PRODUCT_UNAVAILABLE",
          "An enabled pairing contains a missing or inactive product. Disable that pairing or choose active products before saving.",
        );
      }
    }
  }

  try {
    // The version comparison and increment happen in one write.
    // Concurrent first saves are protected by the unique store ID.
    const record = await CartAddonSettings.findOneAndUpdate(
      {
        _id: "store",
        version: submitted.version,
      },
      {
        $set: {
          enabled: submitted.enabled,
          useCategoryRules: submitted.useCategoryRules,
          maxSuggestions: submitted.maxSuggestions,
          excludedProductIds: submitted.excludedProductIds,
          configuredPairs: submitted.configuredPairs,
          updatedBy: req.user._id,
        },

        $inc: {
          version: 1,
        },
      },
      {
        returnDocument: "after",
        upsert: submitted.version === 0,
        runValidators: true,
        setDefaultsOnInsert: false,
        maxTimeMS: 5000,
      },
    ).lean();

    if (!record) {
      return versionConflict(res);
    }

    const settings = publicSettings(record);

    const expected = {
      ...submitted,
      version: submitted.version + 1,
    };

    if (
      JSON.stringify(settings) !==
      JSON.stringify(expected)
    ) {
      throw new Error(
        "CART_ADDON_SETTINGS_SAVE_UNCONFIRMED",
      );
    }

    return res.json({
      success: true,
      settings,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return versionConflict(res);
    }

    console.error(
      "Cart add-on settings save failed:",
      error?.name || "Error",
    );

    return respondError(
      res,
      503,
      "CART_ADDON_SETTINGS_SAVE_UNCONFIRMED",
      "The save result could not be confirmed. Reload saved settings before trying again.",
    );
  }
});

module.exports = router;