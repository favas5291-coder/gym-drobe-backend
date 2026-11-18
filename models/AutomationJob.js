"use strict";
const mongoose = require("mongoose");
const { Schema } = mongoose;

const history = new Schema({
  at: { type: Date, required: true },
  action: { type: String, required: true },
  actor: Schema.Types.ObjectId,
  code: String,
}, { _id: false });

const schema = new Schema({
  type: { type: String, required: true, immutable: true },
  order: { type: Schema.Types.ObjectId, ref: "Order", required: true, immutable: true },
  status: { type: String, enum: ["queued", "running", "completed", "failed", "needs_review"], default: "queued" },
  attempts: { type: Number, default: 0 },
  nextRunAt: { type: Date, default: Date.now },
  lease: { type: String, select: false },
  lastError: { type: String, default: "" },
  lastSuccessAt: Date,
  history: { type: [history], default: [] },
}, { timestamps: true, autoCreate: false, autoIndex: false });
schema.index({ type: 1, order: 1 }, { unique: true });
schema.index({ status: 1, nextRunAt: 1, _id: 1 });
schema.index({ status: 1, _id: -1 });
schema.index({ lastSuccessAt: -1 }, { sparse: true });
module.exports = mongoose.models.AutomationJob || mongoose.model("AutomationJob", schema);
