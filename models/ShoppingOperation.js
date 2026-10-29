"use strict";
const mongoose = require("mongoose");

const receiptSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  fingerprint: { type: String, required: true, maxlength: 64 },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.ShoppingOperation || mongoose.model("ShoppingOperation", receiptSchema);
