const mongoose = require("mongoose");

const noId = { _id: false };

const integer = (minimum = 0) => ({
  type: Number,
  required: true,
  min: minimum,
  validate: Number.isSafeInteger,
});

const text = (maximum) => ({
  type: String,
  required: true,
  maxlength: maximum,
});

const range = new mongoose.Schema(
  {
    minimum: integer(),
    maximum: integer(),
  },
  noId,
);

const content = new mongoose.Schema(
  {
    itemIndex: integer(),
    productId: text(24),
    name: text(500),
    quantity: integer(1),

    selectedSize: {
      type: String,
      default: null,
      maxlength: 200,
    },

    selectedColor: {
      type: String,
      default: null,
      maxlength: 200,
    },
  },
  noId,
);

const parcel = new mongoose.Schema(
  {
    key: text(100),

    groupId: {
      type: String,
      default: null,
      maxlength: 80,
    },

    label: text(150),
    carrier: text(100),
    service: text(200),

    contents: {
      type: [content],
      required: true,
    },

    preparationDays: {
      type: range,
      required: true,
    },

    transitDays: {
      type: range,
      required: true,
    },

    estimatedDays: {
      type: range,
      required: true,
    },

    merchandisePaise: integer(),
    shippingPaise: integer(),
    amountDuePaise: integer(),
  },
  noId,
);

module.exports = new mongoose.Schema(
  {
    version: {
      type: Number,
      enum: [1],
      required: true,
    },

    destinationPincode: {
      type: String,
      match: /^[1-9]\d{5}$/,
      required: true,
    },

    paymentMethod: {
      type: String,
      enum: ["razorpay", "cod-partial"],
      required: true,
    },

    reviewedAt: {
      type: Date,
      required: true,
    },

    validUntil: {
      type: Date,
      required: true,
    },

    packageCount: integer(1),
    shippingPaise: integer(),
    merchandisePaise: integer(),
    totalPaise: integer(),
    payNowPaise: integer(),
    amountDuePaise: integer(),

    shipments: {
      type: [parcel],
      required: true,
    },
  },
  noId,
);