"use strict";

const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  _id: String,
  order: { type: mongoose.Schema.Types.ObjectId, required: true },
  state: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  dueAt: Date,
  providerId: String,
  code: String,
  expiresAt: Date,
}, { timestamps: true, autoCreate: false, autoIndex: false });
schema.index({ state: 1, dueAt: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.WhatsAppOrderDelivery || mongoose.model("WhatsAppOrderDelivery", schema);
