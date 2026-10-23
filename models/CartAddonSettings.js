"use strict";

const mongoose = require("mongoose");

const {
  MAX_SUGGESTIONS,
  MAX_CONFIGURED_PAIRS,
  MAX_EXCLUDED_PRODUCTS,
  MAX_SETTINGS_VERSION,
  defaultCartAddonSettings,
  normalizeCartAddonSettings,
} = require("../utils/cartAddonSettings");

const { Schema } = mongoose;
const defaults = defaultCartAddonSettings();

function productIdField() {
  return {
    type: String,
    required: true,
    cast: false,
    trim: true,
    lowercase: true,
    match: /^[a-f0-9]{24}$/,
  };
}

const pairingSchema = new Schema(
  {
    sourceId: productIdField(),
    productId: productIdField(),

    enabled: {
      type: Boolean,
      required: true,
      cast: false,
    },

    compatibilityConfirmed: {
      type: Boolean,
      required: true,
      cast: false,
    },
  },
  {
    _id: false,
    strict: "throw",
  },
);

const schema = new Schema(
  {
    _id: {
      type: String,
      default: "store",
      enum: ["store"],
      required: true,
    },

    version: {
      type: Number,
      default: defaults.version,
      required: true,
      cast: false,
      min: 0,
      max: MAX_SETTINGS_VERSION,
      validate: Number.isSafeInteger,
    },

    enabled: {
      type: Boolean,
      default: defaults.enabled,
      required: true,
      cast: false,
    },

    useCategoryRules: {
      type: Boolean,
      default: defaults.useCategoryRules,
      required: true,
      cast: false,
    },

    maxSuggestions: {
      type: Number,
      default: defaults.maxSuggestions,
      required: true,
      cast: false,
      min: 1,
      max: MAX_SUGGESTIONS,
      validate: Number.isSafeInteger,
    },

    excludedProductIds: {
      type: [productIdField()],
      default: () => [],
      required: true,
      castNonArrays: false,

      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length <= MAX_EXCLUDED_PRODUCTS &&
          new Set(values).size === values.length,

        message:
          "Excluded product IDs must be unique and within the allowed limit.",
      },
    },

    configuredPairs: {
      type: [pairingSchema],
      default: () => [],
      required: true,

      set(value) {
        if (!Array.isArray(value)) {
          throw new mongoose.Error.CastError(
            "Array",
            value,
            "configuredPairs",
          );
        }

        return value;
      },

      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length <= MAX_CONFIGURED_PAIRS,

        message:
          "Too many product pairings have been configured.",
      },
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    strict: "throw",
  },
);

schema.pre("validate", function () {
  normalizeCartAddonSettings({
    version: this.version,
    enabled: this.enabled,
    useCategoryRules: this.useCategoryRules,
    maxSuggestions: this.maxSuggestions,
    excludedProductIds: this.excludedProductIds,

    configuredPairs: this.configuredPairs?.map(
      (pair) => pair.toObject(),
    ),
  });
});

module.exports =
  mongoose.models.CartAddonSettings ||
  mongoose.model("CartAddonSettings", schema);