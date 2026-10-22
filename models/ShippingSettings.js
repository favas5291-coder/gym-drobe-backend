"use strict";

const mongoose = require("mongoose");

const {
  LIST_FIELDS,
  defaultShippingSettings,
  normalizeShippingSettings,
} = require("../utils/shippingSettings");

const { Schema } = mongoose;

const offerFields = {
  enabled: {
    type: Boolean,
    required: true,
  },

  minimumSubtotalPaise: {
    type: Number,
    required: true,
    min: 0,
    max: 100000000,
    validate: Number.isSafeInteger,
  },

  additionalChargesNotice: {
    type: String,
    default: "",
    maxlength: 500,
  },
};

for (
  const [key, maximum] of
  Object.entries(LIST_FIELDS)
) {
  offerFields[key] = {
    type: [String],

    default: () => [],

    validate: {
      validator: (values) =>
        Array.isArray(values) &&
        values.length <= maximum,

      message:
        `${key} contains too many entries.`,
    },
  };
}

const offerSchema = new Schema(
  offerFields,
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
    },

    version: {
      type: Number,
      default: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER - 1,
      validate: Number.isSafeInteger,
    },

    freeShipping: {
      type: offerSchema,
      required: true,

      default: () =>
        defaultShippingSettings()
          .freeShipping,
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

schema.pre(
  "validate",
  function () {
    normalizeShippingSettings({
      version: this.version,

      freeShipping:
        this.freeShipping?.toObject(),
    });
  },
);

module.exports =
  mongoose.models.ShippingSettings ||
  mongoose.model(
    "ShippingSettings",
    schema,
  );