"use strict";
const mongoose = require("mongoose");

// Choices only: never prices, discounts, payment state or stock reservations.
const stateSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  revision: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  cart: { type: [mongoose.Schema.Types.Mixed], default: [] },
  wishlist: { type: [String], default: [] },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.ShoppingState || mongoose.model("ShoppingState", stateSchema);
