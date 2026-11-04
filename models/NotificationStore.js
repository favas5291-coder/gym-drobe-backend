"use strict";
const mongoose = require("mongoose");
const { Schema } = mongoose;
const objectId = { type: Schema.Types.ObjectId, required: true, index: true };
const device = new Schema({
  _id: String, user: objectId, binding: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true },
  tokenCipher: { type: String, required: true, select: false },
  platform: { type: String, enum: ["ios", "android"], required: true },
  environment: { type: String, enum: ["sandbox", "production"], required: true },
  enabled: { type: Boolean, default: false }, consentAt: { type: Date, required: true }, bindingIssuedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
device.index({ user: 1, enabled: 1 });
device.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const delivery = new Schema({
  _id: String, user: objectId, order: objectId, device: { type: String, required: true },
  binding: { type: String, required: true }, kind: { type: String, required: true },
  sourceAt: { type: Date, required: true },
  state: { type: String, enum: ["pending", "leased", "sending", "sent", "failed", "uncertain", "cancelled"], default: "pending" },
  attempts: { type: Number, default: 0, min: 0, max: 5 },
  nextAttemptAt: { type: Date, required: true }, leaseUntil: Date, claim: String,
  code: { type: String, default: "", maxlength: 60 },
  history: { type: [{ _id: false, at: Date, state: String, code: String, actor: String }], default: [] },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
delivery.index({ state: 1, nextAttemptAt: 1 });
delivery.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const control = new Schema({
  _id: String, enabled: { type: Boolean, default: false },
  scanAt: Date, scanFloor: Date, scanId: { type: String, default: "" },
  scanBefore: Date, lastScanAt: Date, lastWorkerAt: Date,
  lastError: { type: String, default: "", maxlength: 60 },
  changedBy: Schema.Types.ObjectId,
}, { timestamps: true });
module.exports = {
  Device: mongoose.models.NotificationDevice || mongoose.model("NotificationDevice", device),
  Delivery: mongoose.models.NotificationDelivery || mongoose.model("NotificationDelivery", delivery),
  Control: mongoose.models.NotificationControl || mongoose.model("NotificationControl", control),
};
