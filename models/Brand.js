const mongoose = require("mongoose");

const artwork = new mongoose.Schema({
  media: { type: mongoose.Schema.Types.ObjectId, required: true },
  source: { type: String, default: "" },
}, { _id: false });

const brand = new mongoose.Schema({
  _id: String,
  name: { type: String, required: true, maxlength: 100 },
  status: { type: String, enum: ["queued", "searching", "review", "unavailable", "idle"], default: "idle" },
  requestedBy: mongoose.Schema.Types.ObjectId,
  leaseUntil: Date,
  claim: String,
  candidate: { type: artwork, default: null },
  approved: { type: artwork, default: null },
  revision: { type: Number, default: 0 },
}, { timestamps: true });

brand.index({ status: 1, leaseUntil: 1 });

module.exports = mongoose.models.Brand || mongoose.model("Brand", brand);
