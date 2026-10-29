"use strict";
const mongoose = require("mongoose");
const User = require("../../models/User");
const Order = require("../../models/Order");
const { Device, Delivery, Control } = require("../../models/NotificationStore");
const { orderEvents, deliveryFor, registrationUpdate } = require("./domain");
const ACTIVE = "pending leased sending".split(" ");
async function accountTransaction(user, work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const exists = await User.updateOne({ _id: user, isActive: { $ne: false } }, { $inc: { shoppingSyncVersion: 1 } }, { session });
      if (exists.matchedCount !== 1) throw new Error("ACCOUNT_UNAVAILABLE");
      result = await work(session);
    }, { maxCommitTimeMS: 10000 });
    return result;
  } finally { await session.endSession(); }
}
module.exports = {
  async register(user, row) {
    return accountTransaction(user, async session => {
      const current = await Device.findById(row._id).session(session).lean();
      const count = await Device.countDocuments({ user, enabled: true, _id: { $ne: row._id }, tokenHash: { $ne: row.tokenHash } }).session(session);
      if (count >= 20) throw Object.assign(new Error("Turn off updates on an older device before adding another."), { notification: true, status: 409 });
      // Token rotation/restarts retain the original consent time for this same
      // binding. Re-enabling or changing account begins a new consent window.
      row = registrationUpdate(current, row, user);
      await Device.deleteMany({ tokenHash: row.tokenHash, _id: { $ne: row._id } }, { session });
      await Device.updateOne({ _id: row._id }, { $set: { ...row, user } }, { session, upsert: true, runValidators: true });
      return { device: row._id, binding: row.binding, enabled: true, expiresAt: row.expiresAt };
    });
  },
  devices: user => Device.find({ user }).select("_id binding platform environment enabled expiresAt").limit(20).lean(),
  async disable(user, input) {
    await accountTransaction(user, session => Device.updateOne({ _id: input.device, binding: input.binding, user }, { $set: { enabled: false } }, { session }));
    // A stale logout cannot disable a newer binding on the same phone.
    await Delivery.updateMany({ device: input.device, binding: input.binding, user, state: { $in: ["pending", "leased"] } }, { $set: { state: "cancelled", code: "DEVICE_DISABLED" } });
  },
  async control() { return Control.findById("order-push").lean(); },
  async setControl(enabled, actor) {
    return Control.findOneAndUpdate({ _id: "order-push" }, { $set: { enabled, changedBy: actor } }, { upsert: true, new: true }).lean();
  },
  async scan(now) {
    let checkpoint = await Control.findById("order-push").lean();
    if (!checkpoint?.enabled) return;
    if (!checkpoint.scanAt) {
      await Control.updateOne({ _id: "order-push", scanAt: null }, { $set: { scanAt: new Date(now), scanFloor: new Date(now), scanId: "", scanBefore: new Date(now) } });
      return; // First enable establishes a baseline; no historical blast.
    }
    const start = +checkpoint.scanAt, before = checkpoint.scanBefore && +checkpoint.scanBefore > start ? +checkpoint.scanBefore : now - 10000;
    if (before <= start) return;
    const query = { updatedAt: { $lte: new Date(before) }, user: { $ne: null }, $or: [
      { updatedAt: { $gt: checkpoint.scanAt } }, { updatedAt: checkpoint.scanAt, _id: { $gt: checkpoint.scanId || "000000000000000000000000" } },
    ] };
    const orders = await Order.find(query).select("user updatedAt tracking.events returnRequest refund").sort({ updatedAt: 1, _id: 1 }).limit(100).maxTimeMS(5000).lean();
    for (const order of orders) {
      const events = orderEvents(order, now);
      if (!events.length) continue;
      await accountTransaction(order.user, async session => {
        const devices = await Device.find({ user: order.user, enabled: true, expiresAt: { $gt: new Date(now) } }).session(session).limit(20).lean();
        for (const device of devices) for (const event of events) {
          const row = deliveryFor(order, event, device, now);
          if (row) await Delivery.updateOne({ _id: row._id }, { $setOnInsert: row }, { session, upsert: true, runValidators: true });
        }
      }).catch(error => { if (error.message !== "ACCOUNT_UNAVAILABLE") throw error; });
    }
    const last = orders.at(-1);
    // Compare-and-swap keeps parallel scans on one cursor. Every completed
    // cycle deliberately overlaps five minutes to catch short transactions.
    const next = orders.length === 100 ? { scanAt: last.updatedAt, scanId: String(last._id), scanBefore: new Date(before) }
      : { scanAt: new Date(Math.max(+(checkpoint.scanFloor || checkpoint.scanAt), before - 300000)), scanId: "", scanBefore: new Date(now - 10000), lastScanAt: new Date(now) };
    await Control.updateOne({ _id: "order-push", scanAt: checkpoint.scanAt, scanId: checkpoint.scanId || "", scanBefore: checkpoint.scanBefore }, { $set: next });
  },
  async recover(now) {
    const uncertain = await Delivery.updateMany({ state: "sending", leaseUntil: { $lte: new Date(now) } }, { $set: { state: "uncertain", code: "SEND_INTERRUPTED" } });
    await Delivery.updateMany({ state: "leased", leaseUntil: { $lte: new Date(now) } }, { $set: { state: "pending", code: "LEASE_RECOVERED" } });
    return uncertain.modifiedCount;
  },
  claim: (now, claim) => Delivery.findOneAndUpdate({ state: "pending", attempts: { $lt: 5 }, nextAttemptAt: { $lte: new Date(now) }, expiresAt: { $gt: new Date(now) } },
    { $set: { state: "leased", claim, leaseUntil: new Date(now + 60000) } }, { sort: { nextAttemptAt: 1 }, new: true }).lean(),
  async eligible(row, now) {
    const [user, device, order] = await Promise.all([
      User.exists({ _id: row.user, isActive: { $ne: false } }),
      Device.findOne({ _id: row.device, user: row.user, binding: row.binding, enabled: true, expiresAt: { $gt: new Date(now) }, consentAt: { $lt: row.sourceAt } }).select("+tokenCipher").lean(),
      Order.exists({ _id: row.order, user: row.user }),
    ]);
    return user && order && device;
  },
  sending: row => Delivery.updateOne({ _id: row._id, claim: row.claim, state: "leased" }, { $set: { state: "sending" }, $inc: { attempts: 1 } }),
  async finish(row, result, now) {
    const attempts = row.attempts + (result.started ? 1 : 0);
    const state = result.state === "pending" && attempts >= 5 ? "failed" : result.state;
    await Delivery.updateOne({ _id: row._id, claim: row.claim, state: { $in: ACTIVE } }, { $set: { state, code: state === "failed" && attempts >= 5 ? "RETRY_LIMIT" : result.code, nextAttemptAt: new Date(now + Math.min(3600000, 60000 * 2 ** attempts)) },
      $push: { history: { $each: [{ at: new Date(now), state, code: result.code }], $slice: -20 } } });
    if (result.invalidate) await Device.updateOne({ _id: row.device, binding: row.binding, user: row.user, tokenHash: result.invalidateTokenHash }, { $set: { enabled: false } });
  },
  heartbeat: (now, error = "") => Control.updateOne({ _id: "order-push" }, { $set: { lastWorkerAt: new Date(now), lastError: error } }),
  async summary() {
    const counts = await Delivery.aggregate([{ $group: { _id: "$state", count: { $sum: 1 } } }]);
    return { counts: Object.fromEntries(counts.map(row => [row._id, row.count])), recent: await Delivery.find({ state: { $in: ["failed", "uncertain"] } }).sort({ updatedAt: -1 }).limit(50).select("_id state code attempts updatedAt").lean() };
  },
  async resolve(id, action, actor) {
    if (!/^[a-f0-9]{64}$/.test(id) || !["retry", "cancel"].includes(action)) return false;
    // Uncertain requests cannot be resent automatically or by this retry tool.
    const filter = action === "retry" ? { state: "failed", attempts: { $lt: 5 }, code: { $ne: "TOKEN_INVALID" } } : { state: { $in: ["failed", "uncertain", "pending", "leased"] } };
    const result = await Delivery.updateOne({ _id: id, ...filter }, { $set: { state: action === "retry" ? "pending" : "cancelled", nextAttemptAt: new Date(), code: "ADMIN_REVIEWED" }, $push: { history: { $each: [{ at: new Date(), state: action, code: "ADMIN_REVIEWED", actor: String(actor) }], $slice: -20 } } });
    return result.modifiedCount === 1;
  },
};
