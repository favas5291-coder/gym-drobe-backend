"use strict";

const mongoose = require("mongoose");

const heartbeat = new mongoose.Schema({
  _id: String,
  lastScheduledPollAt: Date,
  lastManualDrainAt: Date,
}, { versionKey: false, autoCreate: false, autoIndex: false });

module.exports = mongoose.models.AutomationWorkerHeartbeat || mongoose.model("AutomationWorkerHeartbeat", heartbeat);
