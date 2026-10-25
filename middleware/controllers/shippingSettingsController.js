"use strict";

const ShippingSettings = require(
  "../../models/ShippingSettings"
);

const {
  defaultShippingSettings,
  normalizeShippingSettings,
} = require("../../utils/shippingSettings");

function respondError(
  res,
  status,
  code,
  message
) {
  return res.status(status).json({
    success: false,
    code,
    message,
  });
}

function publicSettings(value) {
  const record =
    typeof value?.toObject === "function"
      ? value.toObject()
      : value;

  return normalizeShippingSettings({
    version: record.version,
    freeShipping: record.freeShipping,
  });
}

function versionConflict(res) {
  return respondError(
    res,
    409,
    "SHIPPING_SETTINGS_CONFLICT",
    "Shipping settings changed since you loaded them. Reload the saved settings before trying again."
  );
}

async function getShippingSettings(req, res) {
  try {
    const record =
      await ShippingSettings.findById("store")
        .maxTimeMS(5000)
        .lean();

    const settings = publicSettings(
      record || defaultShippingSettings()
    );

    return res.json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error(
      "Shipping settings read failed:",
      error?.name || "Error"
    );

    return respondError(
      res,
      503,
      "SHIPPING_SETTINGS_UNAVAILABLE",
      "Shipping settings could not be loaded. Please retry."
    );
  }
}

async function updateShippingSettings(req, res) {
  let submitted;

  try {
    submitted = normalizeShippingSettings(
      req.body
    );

    if (
      submitted.version >=
      Number.MAX_SAFE_INTEGER - 1
    ) {
      return respondError(
        res,
        400,
        "INVALID_SHIPPING_SETTINGS",
        "The shipping settings version cannot be increased. Contact support before saving."
      );
    }
  } catch (error) {
    if (
      error?.status === 400 &&
      error?.code === "INVALID_SHIPPING_SETTINGS"
    ) {
      return respondError(
        res,
        400,
        error.code,
        error.message
      );
    }

    return respondError(
      res,
      400,
      "INVALID_SHIPPING_SETTINGS",
      "Send the complete shipping settings loaded from the admin page."
    );
  }

  try {
    // Match the version in the same database
    // operation that saves it.
    // Only version zero may create the initial record.
    const record =
      await ShippingSettings.findOneAndUpdate(
        {
          _id: "store",
          version: submitted.version,
        },
        {
          $set: {
            freeShipping:
              submitted.freeShipping,

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
          setDefaultsOnInsert: true,
          maxTimeMS: 5000,
        }
      ).lean();

    if (!record) {
      return versionConflict(res);
    }

    const settings = publicSettings(record);

    if (
      settings.version !==
        submitted.version + 1 ||
      JSON.stringify(settings.freeShipping) !==
        JSON.stringify(submitted.freeShipping)
    ) {
      throw new Error(
        "SHIPPING_SETTINGS_SAVE_UNCONFIRMED"
      );
    }

    return res.json({
      success: true,
      settings,
    });
  } catch (error) {
    // Concurrent first saves or an old version-zero
    // form can collide with the unique store record.
    if (error?.code === 11000) {
      return versionConflict(res);
    }

    console.error(
      "Shipping settings save failed:",
      error?.name || "Error"
    );

    return respondError(
      res,
      503,
      "SHIPPING_SETTINGS_SAVE_UNCONFIRMED",
      "The save result could not be confirmed. Reload saved settings before trying again."
    );
  }
}

module.exports = {
  getShippingSettings,
  updateShippingSettings,
};