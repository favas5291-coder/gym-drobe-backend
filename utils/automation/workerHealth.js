"use strict";

const Heartbeat = require("../../models/AutomationWorkerHeartbeat");
const Job = require("../../models/AutomationJob");

const POLL_MS = 30000;
const STALE_MS = 3 * POLL_MS;
// One shared document, regardless of the job count or number of API processes.
const HEARTBEAT_ID = "marketplace-order-reconciliation";

async function recordCompletedBatch(scheduled) {
  const field = scheduled ? "lastScheduledPollAt" : "lastManualDrainAt";
  await Heartbeat.updateOne({ _id: HEARTBEAT_ID }, { $currentDate: { [field]: true } },
    { upsert: true, maxTimeMS: 3000, setDefaultsOnInsert: false });
}

function status(workerEnabled, lastPoll, now) {
  if (!workerEnabled) return "disabled";
  if (!lastPoll) return "never_seen";
  const age = now - lastPoll;
  if (age < -POLL_MS) return "clock_skew";
  return age >= STALE_MS ? "stale" : "polling";
}

async function readWorkerHealth({ enabled, workerEnabled, type }) {
  const now = new Date();
  let heartbeat, due;
  let heartbeatReadable = null, dueWorkReadable = null;
  if (enabled) {
    const [pollRead, dueRead] = await Promise.allSettled([
      Heartbeat.findById(HEARTBEAT_ID).select("-_id lastScheduledPollAt lastManualDrainAt").lean().maxTimeMS(3000),
      Job.findOne({ type, status: { $in: ["queued", "running"] }, nextRunAt: { $lte: now } })
        .sort({ nextRunAt: 1, _id: 1 }).select("-_id nextRunAt").lean().maxTimeMS(3000),
    ]);
    heartbeatReadable = pollRead.status === "fulfilled";
    dueWorkReadable = dueRead.status === "fulfilled";
    if (heartbeatReadable) heartbeat = pollRead.value;
    if (dueWorkReadable) due = dueRead.value;
  }
  return {
    state: enabled && workerEnabled && heartbeatReadable === false ? "unavailable" : status(enabled && workerEnabled, heartbeat?.lastScheduledPollAt, now),
    heartbeatReadable, dueWorkReadable,
    observedAt: now, staleAfterMs: STALE_MS, lastScheduledPollAt: heartbeat?.lastScheduledPollAt || null,
    lastManualDrainAt: heartbeat?.lastManualDrainAt || null, oldestDueAt: due?.nextRunAt || null,
  };
}

module.exports = { POLL_MS, status, readWorkerHealth, recordCompletedBatch };
