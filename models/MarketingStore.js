"use strict";

const mongoose = require("mongoose");

const { Schema } = mongoose;

const model = (name, fields) =>
  mongoose.models[name] ||
  mongoose.model(
    name,
    new Schema(fields, {
      timestamps: true,
    }),
  );

const Config = model("MarketingConfig", {
  _id: {
    type: String,
    default: "meta",
  },

  enabled: {
    type: Boolean,
    default: false,
  },

  pixelEnabled: {
    type: Boolean,
    default: false,
  },

  capiEnabled: {
    type: Boolean,
    default: false,
  },

  feedEnabled: {
    type: Boolean,
    default: false,
  },

  datasetId: {
    type: String,
    default: "",
  },

  apiVersion: {
    type: String,
    default: "v26.0",
  },

  testMode: {
    type: Boolean,
    default: true,
  },

  testEventCode: {
    type: String,
    default: "",
  },

  policiesReviewed: {
    type: Boolean,
    default: false,
  },

  epoch: {
    type: Number,
    default: 0,
  },

  allowedEvents: {
    type: [String],
    default: [],
  },

  codModel: {
    type: String,
    default: "delivered-collected",
  },

  revision: {
    type: Number,
    default: 0,
  },

  reviewedBy: Schema.Types.ObjectId,
  reviewedAt: Date,

  feed: Schema.Types.Mixed,

  lastWorkerAt: Date,
  lastWorkerError: String,
});

const Consent = model("MarketingConsent", {
  _id: String,

  granted: Boolean,
  matching: Boolean,

  version: {
    type: Number,
    default: 1,
  },

  revision: {
    type: Number,
    default: 0,
  },

  preferenceTime: Date,

  expiresAt: {
    type: Date,
    index: {
      expireAfterSeconds: 0,
    },
  },

  firstTouch: Schema.Types.Mixed,
  lastTouch: Schema.Types.Mixed,

  fbc: String,
  fbp: String,

  fbcExpiresAt: Date,
  fbpExpiresAt: Date,

  agent: String,
  clientIP: String,
});

const eventSchema = new Schema(
  {
    _id: String,

    eventId: String,
    eventName: String,
    eventTime: Number,

    subject: {
      type: String,
      index: true,
    },

    consentVersion: Number,

    order: {
      type: Schema.Types.ObjectId,
      index: true,
    },

    payload: Schema.Types.Mixed,
    userData: Schema.Types.Mixed,

    datasetId: String,
    apiVersion: String,

    testMode: Boolean,
    testEventCode: String,

    state: {
      type: String,
      index: true,
    },

    suppression: String,

    attempts: {
      type: Number,
      default: 0,
    },

    nextAttemptAt: Date,
    leaseUntil: Date,
    acceptedAt: Date,

    errorCode: String,

    expiresAt: {
      type: Date,
      index: {
        expireAfterSeconds: 0,
      },
    },
  },
  {
    timestamps: true,
  },
);

eventSchema.index({
  state: 1,
  nextAttemptAt: 1,
  leaseUntil: 1,
});

const Event =
  mongoose.models.MarketingEvent ||
  mongoose.model(
    "MarketingEvent",
    eventSchema,
  );

const Checkpoint = model("MarketingCheckpoint", {
  _id: String,

  time: Date,
  cursor: String,
  owner: String,
  leaseUntil: Date,
});

const chunkSchema = new Schema({
  version: String,
  ordinal: Number,
  data: String,

  expiresAt: {
    type: Date,
    index: {
      expireAfterSeconds: 0,
    },
  },
});

chunkSchema.index(
  {
    version: 1,
    ordinal: 1,
  },
  {
    unique: true,
  },
);

const FeedChunk =
  mongoose.models.MarketingFeedChunk ||
  mongoose.model(
    "MarketingFeedChunk",
    chunkSchema,
  );

module.exports = {
  Config,
  Consent,
  Event,
  Checkpoint,
  FeedChunk,
};