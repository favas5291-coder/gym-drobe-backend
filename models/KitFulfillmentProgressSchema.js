const mongoose = require("mongoose");

const {
  PARCEL_STAGES,
  PROCUREMENT_STAGES,
} = require("../utils/kitFulfillmentProgress");

const noId = { _id: false };

const integer = () => ({
  type: Number,
  required: true,
  min: 0,
  validate: Number.isSafeInteger,
});

const audit = {
  updatedAt: {
    type: Date,
    default: null,
  },

  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
};

const component = new mongoose.Schema(
  {
    itemIndex: integer(),
    receivedQuantity: integer(),

    procurementStatus: {
      type: String,
      enum: PROCUREMENT_STAGES,
      required: true,
    },

    supplierReference: {
      type: String,
      default: "",
      maxlength: 200,
    },

    notes: {
      type: String,
      default: "",
      maxlength: 500,
    },

    ...audit,
  },
  noId,
);

const parcel = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      maxlength: 100,
    },

    status: {
      type: String,
      enum: PARCEL_STAGES,
      required: true,
    },

    carrier: {
      type: String,
      default: "",
      maxlength: 100,
    },

    trackingNumber: {
      type: String,
      default: "",
      maxlength: 150,
    },

    estimatedDelivery: {
      type: Date,
      default: null,
    },

    packedAt: {
      type: Date,
      default: null,
    },

    shippedAt: {
      type: Date,
      default: null,
    },

    deliveredAt: {
      type: Date,
      default: null,
    },

    codCollectedPaise: integer(),

    codCollectedAt: {
      type: Date,
      default: null,
    },

    collectionReference: {
      type: String,
      default: "",
      maxlength: 200,
    },

    ...audit,
  },
  noId,
);

module.exports = new mongoose.Schema(
  {
    revision: integer(),

    components: {
      type: [component],
      required: true,
    },

    parcels: {
      type: [parcel],
      required: true,
    },

    ...audit,
  },
  noId,
);