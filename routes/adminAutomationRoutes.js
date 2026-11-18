"use strict";
const express = require("express");
const mongoose = require("mongoose");
const Job = require("../models/AutomationJob");
const engine = require("../utils/automation/engine");

const { readWorkerHealth } = require("../utils/automation/workerHealth");

const router = express.Router();
const reject = (res, status, message) => res.status(status).json({ success: false, message });
const validId = value => typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);

function publicJob(row) {
  return {
    id: String(row._id), orderId: String(row.order), type: row.type,
    status: row.status, attempts: row.attempts, nextRunAt: row.nextRunAt,
    lastError: row.lastError, createdAt: row.createdAt, updatedAt: row.updatedAt,
    history: row.history.map(({ at, action, code }) => ({ at, action, code })),
  };
}

router.get("/", async (req, res) => {
  const { status, before } = req.query;
  if ((status !== undefined && !engine.STATES.includes(status)) || (before !== undefined && !validId(before))) {
    return reject(res, 400, "Invalid job status or page cursor.");
  }
  const counts = Object.fromEntries(engine.STATES.map(state => [state, 0]));
  const summary = {
    success: true, enabled: engine.enabled(), workerEnabled: engine.workerEnabled(),
    lastSuccessAt: null, counts, jobs: [], nextCursor: null,
  };
  const healthOptions = { enabled: summary.enabled, workerEnabled: summary.workerEnabled, type: engine.TYPE };
  if (!summary.enabled) {
    summary.workerHealth = await readWorkerHealth(healthOptions);
    return res.json(summary);
  }
  const filter = {};
  if (status) filter.status = status;
  if (before) filter._id = { $lt: new mongoose.Types.ObjectId(before) };
  const [page, success, totals, workerHealth] = await Promise.all([
    Job.find(filter).sort({ _id: -1 }).limit(26).lean().maxTimeMS(5000),
    Job.findOne({ lastSuccessAt: { $exists: true } }).sort({ lastSuccessAt: -1 }).select("lastSuccessAt").lean().maxTimeMS(5000),
    Promise.all(engine.STATES.map(state => Job.countDocuments({ status: state }).maxTimeMS(5000))),
    readWorkerHealth(healthOptions),
  ]);
  summary.workerHealth = workerHealth;
  engine.STATES.forEach((state, index) => { counts[state] = totals[index]; });
  summary.lastSuccessAt = success?.lastSuccessAt || null;
  summary.jobs = page.slice(0, 25).map(publicJob);
  summary.nextCursor = page.length > 25 ? summary.jobs.at(-1).id : null;
  return res.json(summary);
});

router.use((req, res, next) => engine.enabled() ? next() : reject(res, 503, "The automation engine is disabled."));
router.post("/process", async (req, res) => {
  const processed = await engine.drain(req.user._id);
  return res.json({ success: true, processed });
});
router.post("/jobs/:id/retry", async (req, res) => {
  if (!validId(req.params.id)) return reject(res, 400, "Invalid job reference.");
  const job = await engine.requeue({ _id: req.params.id, status: { $in: ["failed", "needs_review"] } }, req.user._id);
  if (!job) return reject(res, 409, "The job is not awaiting a retry. Refresh the job list.");
  return res.json({ success: true, queued: true });
});
router.post("/orders/:id/reconcile", async (req, res) => {
  if (!validId(req.params.id)) return reject(res, 400, "Enter the order's 24-character database reference.");
  const order = await require("../models/Order").exists({ _id: req.params.id, "items.marketplace.accountId": { $exists: true } });
  if (!order) return reject(res, 404, "Marketplace order not found.");
  const filter = { order: req.params.id, type: engine.TYPE };
  let existing = await Job.findOne(filter).select("status").lean();
  if (!existing) {
    try { await engine.enqueue(req.params.id, null, req.user._id); }
    catch (error) { if (error.code !== 11000) throw error; }
    existing = await Job.findOne(filter).select("status").lean();
    if (existing?.status === "queued") return res.json({ success: true, queued: true });
  }
  if (existing?.status === "queued") return res.json({ success: true, queued: true });
  if (existing?.status !== "completed" || !await engine.requeue({ ...filter, status: "completed" }, req.user._id)) {
    return reject(res, 409, "This check is already running or awaiting review. Refresh the job list.");
  }
  return res.json({ success: true, queued: true });
});
module.exports = router;
