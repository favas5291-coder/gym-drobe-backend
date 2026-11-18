"use strict";
const { randomUUID } = require("node:crypto");
const Job = require("../../models/AutomationJob");
const { Fulfilment, Entitlement } = require("../../models/Marketplace");

const TYPE = "order.fulfilment.check.v1";
const STATES = ["queued", "running", "completed", "failed", "needs_review"];
const MAX_ATTEMPTS = 5;
const LEASE_MS = 60000;
const enabled = () => process.env.AUTOMATION_ENGINE_ENABLED === "true" && process.env.MARKETPLACE_ENABLED === "true";
const workerEnabled = () => enabled() && process.env.AUTOMATION_WORKER_ENABLED === "true";
const transition = (action, at, actor, code) => ({ history: { $each: [{ action, at, actor, code }], $slice: -32 } });

async function enqueue(orderId, session, actor) {
  const at = new Date();
  return Job.updateOne({ type: TYPE, order: orderId }, { $setOnInsert: {
    status: "queued", attempts: 0, nextRunAt: at, history: [{ action: "queued", at, actor }],
  } }, { upsert: true, session });
}

// Compare frozen purchase-time amounts and item ownership. Current balances,
// product prices and parcel statuses are allowed to change after checkout.
function discrepancy(order, shipments, entitlements) {
  if (!order) return "ORDER_MISSING";
  const expected = new Map();
  for (const [index, item] of order.items.entries()) {
    const snapshot = item.marketplace;
    if (!snapshot) continue;
    if (!/^[a-f\d]{24}$/i.test(String(snapshot.accountId)) ||
        !Number.isSafeInteger(snapshot.supplierPayablePaise) || snapshot.supplierPayablePaise < 0) {
      return "SUPPLIER_SNAPSHOT_INVALID";
    }
    expected.set(index, snapshot);
  }
  if (!expected.size) return "SUPPLIER_SNAPSHOT_INVALID";
  const seen = new Set();
  for (const group of shipments) {
    if (!group.itemIndices?.length) return "FULFILMENT_MISMATCH";
    for (const index of group.itemIndices) {
      if (seen.has(index) || expected.get(index)?.accountId !== String(group.supplier)) return "FULFILMENT_MISMATCH";
      seen.add(index);
    }
  }
  if (seen.size !== expected.size) return "FULFILMENT_MISMATCH";
  seen.clear();
  for (const row of entitlements) {
    const snapshot = expected.get(row.itemIndex);
    if (!snapshot || seen.has(row.itemIndex) || String(row.supplier) !== snapshot.accountId ||
        row.snapshot?.supplierPayablePaise !== snapshot.supplierPayablePaise) return "ENTITLEMENT_MISMATCH";
    seen.add(row.itemIndex);
  }
  return seen.size === expected.size ? "" : "ENTITLEMENT_MISMATCH";
}

async function inspect(orderId) {
  const Order = require("../../models/Order");
  const [order, shipments, entitlements] = await Promise.all([
    Order.findById(orderId).select("_id +items.marketplace").lean().maxTimeMS(5000),
    Fulfilment.find({ order: orderId }).select("supplier itemIndices").lean().maxTimeMS(5000),
    Entitlement.find({ order: orderId }).select("supplier itemIndex snapshot.supplierPayablePaise").lean().maxTimeMS(5000),
  ]);
  return discrepancy(order, shipments, entitlements);
}

async function processOne({ check = inspect, now = () => new Date(), actor } = {}) {
  const at = now();
  const lease = randomUUID();
  const candidate = await Job.findOneAndUpdate({
    type: TYPE, status: { $in: ["queued", "running"] }, nextRunAt: { $lte: at },
  }, {
    $set: { status: "running", lease, nextRunAt: new Date(+at + LEASE_MS) },
    $inc: { attempts: 1 }, $push: transition("claimed", at, actor),
  }, { returnDocument: "after", sort: { nextRunAt: 1, _id: 1 } }).lean();
  if (!candidate) return false;

  const result = { status: "completed", lastError: "", nextRunAt: null };
  if (candidate.attempts > MAX_ATTEMPTS) {
    // The final execution crashed. Terminalize without issuing a sixth read.
    result.status = "failed";
    result.lastError = "LEASE_EXHAUSTED";
  } else {
    try {
      const reason = await check(candidate.order);
      if (reason) {
        result.status = "needs_review";
        result.lastError = reason;
      } else {
        result.lastSuccessAt = now();
      }
    } catch {
      result.status = candidate.attempts < MAX_ATTEMPTS ? "queued" : "failed";
      result.lastError = "RETRYABLE_READ_FAILURE";
      if (result.status === "queued") result.nextRunAt = new Date(+now() + 30000 * 2 ** (candidate.attempts - 1));
    }
  }
  // A slow worker cannot overwrite a newer worker after lease recovery.
  await Job.updateOne({ _id: candidate._id, status: "running", lease }, {
    $set: result, $unset: { lease: 1 }, $push: transition(result.status, now(), actor, result.lastError),
  });
  return true;
}

let draining = null;
async function drain(actor) {
  if (draining) return 0;
  draining = (async () => {
    let count = 0;
    while (count < 10 && await processOne({ actor })) count += 1;
    return count;
  })();
  try { return await draining; } finally { draining = null; }
}
let timer;
function startWorker() {
  if (timer || !workerEnabled()) return;
  timer = setInterval(() => { drain().catch(() => console.error("Automation worker could not access the job queue.")); }, 30000);
  timer.unref();
}
async function stopWorker() {
  clearInterval(timer);
  timer = null;
  await draining?.catch(() => {});
}

async function requeue(filter, actor) {
  const at = new Date();
  return Job.findOneAndUpdate(filter, {
    $set: { status: "queued", nextRunAt: at, attempts: 0, lastError: "" },
    $push: transition("admin_requeue", at, actor),
  }, { returnDocument: "after" });
}
module.exports = { TYPE, STATES, enabled, workerEnabled, enqueue, discrepancy, processOne, drain, startWorker, stopWorker, requeue };
