"use strict";
// Isolated CI integration only. Never reads MONGO_URI or connects to a remote DB.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const User = require("../../models/User");
const Order = require("../../models/Order");
const State = require("../../models/ShoppingState");
const Receipt = require("../../models/ShoppingOperation");
const { Device, Delivery, Control } = require("../../models/NotificationStore");
const Address = require("../../models/Address"), Review = require("../../models/Review"), Support = require("../../models/SupportTicket");
const shoppingStore = require("../../utils/shoppingStore");
const { createShoppingService } = require("../../utils/shoppingState");
const pushStore = require("../../utils/notifications/store");
const { registration, orderEvents, deliveryFor } = require("../../utils/notifications/domain");
const { createNotificationWorker } = require("../../utils/notifications/worker");
const { deleteAccount } = require("../../middleware/controllers/accountDeletionController");
const uri = process.env.GYMDROBE_TEST_MONGO_URI || "";
if (!/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\/[A-Za-z0-9_]+\?/.test(uri) || !uri.includes("replicaSet=")) throw new Error("Use the disposable loopback replica-set fixture; remote/production databases are prohibited.");
const database = `gymdrobe_fixture_${crypto.randomBytes(8).toString("hex")}`;
const checks = [];
const check = async (name, work) => { await work(); checks.push(name); console.log("PASS", name); };
const now = Date.now(), encryption = crypto.randomBytes(32);
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
let alice, bob, device, orderId;
async function run() {
  await mongoose.connect(uri, { dbName: database, serverSelectionTimeoutMS: 10000, maxPoolSize: 10 });
  await Promise.all([User, State, Receipt, Device, Delivery, Control, Order, Address, Review, Support].map(model => model.createIndexes()));
  alice = await User.create({ name: "Fixture Alice", email: "alice@example.test", googleId: "fixture-alice" });
  bob = await User.create({ name: "Fixture Bob", email: "bob@example.test", googleId: "fixture-bob" });
  const service = createShoppingService({ store: shoppingStore, now: () => now });
  const op = (baseRevision, changes) => ({ id: crypto.randomUUID(), issuedAt: now, baseRevision, changes });
  const line = { productId: "6ad2351ed8f991271e3d1a8b", selectedSize: "M", selectedColor: "Black" };
  await check("real Mongo transactions atomically save shopping state and idempotency receipts", async () => {
    const operation = op(0, [{ type: "seed", selection: { cart: [{ ...line, quantity: 1 }], wishlist: [] } }]);
    await service.mutate(alice._id, operation);
    const duplicate = await service.mutate(alice._id, operation);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await State.findById(alice._id)).cart[0].quantity, 1);
    assert.equal(await Receipt.countDocuments({ user: alice._id }), 1);
  });
  await check("concurrent devices rebase without lost quantities or duplicate operations", async () => {
    const operations = Array.from({ length: 8 }, () => op(1, [{ type: "adjust", line, delta: 1 }]));
    await Promise.all(operations.map(async operation => {
      for (let retry = 0; retry < 20; retry++) {
        try { await service.mutate(alice._id, operation); return; }
        catch (error) { if (error.status !== 409 || !error.state) throw error; operation.baseRevision = error.state.revision; }
      }
      throw new Error("Fixture exceeded bounded conflict retries");
    }));
    const state = await service.read(alice._id);
    assert.equal(state.cart[0].quantity, 9); assert.equal(state.revision, 9);
    assert.equal(await Receipt.countDocuments({ user: alice._id }), 9);
    assert.deepEqual((await service.read(bob._id)).cart, []);
  });
  await check("receipt persistence failure rolls back an actual Mongo shopping-state write", async () => {
    const originalCreate = Receipt.create;
    Receipt.create = async () => { throw new Error("Fixture interrupted receipt persistence"); };
    try { await assert.rejects(service.mutate(alice._id, op(9, [{ type: "adjust", line, delta: 1 }]))); }
    finally { Receipt.create = originalCreate; }
    assert.equal((await service.read(alice._id)).cart[0].quantity, 9);
    assert.equal(await Receipt.countDocuments({ user: alice._id }), 9);
  });
  const install = crypto.randomUUID(), binding = crypto.randomUUID();
  const body = { installationId: install, binding, token: "a".repeat(64), platform: "ios", environment: "sandbox", orderUpdates: true, refresh: false, claimAt: now };
  await check("shared-phone rebind rejects stale token callbacks and stale sign-out", async () => {
    const first = registration(body, now, encryption);
    await pushStore.register(alice._id, first);
    const next = registration({ ...body, binding: crypto.randomUUID(), claimAt: now + 1 }, now + 1, encryption);
    device = await pushStore.register(bob._id, next);
    await pushStore.disable(alice._id, { device: first._id, binding: first.binding });
    assert.equal((await Device.findById(device.device)).enabled, true);
    await assert.rejects(pushStore.register(alice._id, { ...first, refresh: true }), { status: 409 });
    await assert.rejects(pushStore.register(alice._id, first), { status: 409 });
    const rotated = registration({ ...body, binding: next.binding, claimAt: now + 1, token: "b".repeat(64), refresh: true }, now + 100, encryption);
    await pushStore.register(bob._id, rotated);
    assert.equal(await Device.countDocuments({ user: bob._id, enabled: true }), 1);
  });
  await check("parallel workers claim one durable send and cannot resend an accepted message", async () => {
    orderId = new mongoose.Types.ObjectId();
    // Minimal actual DB order source; no checkout/provider/stock mutation.
    await Order.collection.insertOne({ _id: orderId, user: bob._id, updatedAt: new Date(now + 500), tracking: { events: [{ status: "confirmed", timestamp: new Date(now + 500) }] } });
    const row = deliveryFor({ _id: orderId, user: bob._id }, orderEvents({ _id: orderId, user: bob._id, tracking: { events: [{ status: "confirmed", timestamp: now + 500 }] } }, now + 1000)[0], await Device.findById(device.device).lean(), now + 1000);
    await Delivery.create(row); await Control.create({ _id: "order-push", enabled: true, scanAt: new Date(now + 1000), scanFloor: new Date(now + 1000), scanBefore: new Date(now + 1000) });
    let sends = 0;
    const workers = Array.from({ length: 5 }, () => createNotificationWorker({ repository: pushStore, now: () => now + 1000, enabled: () => true,
      decrypt: () => "fixture-token", providers: { async send() { sends++; return { state: "sent", code: "PROVIDER_ACCEPTED" }; } }, alert: () => {} }));
    await Promise.all(workers.map(worker => worker.tick()));
    assert.equal(sends, 1); assert.equal((await Delivery.findById(row._id)).state, "sent");
    await Promise.all(workers.map(worker => worker.tick())); assert.equal(sends, 1);
    workers.forEach(worker => worker.stop());
  });
  await check("interrupted sends require review and invalid old tokens cannot disable rotated tokens", async () => {
    const row = await Delivery.findOne();
    await Delivery.updateOne({ _id: row._id }, { $set: { state: "sending", leaseUntil: new Date(now - 1) } });
    await pushStore.recover(now + 1000);
    assert.equal((await Delivery.findById(row._id)).state, "uncertain");
    assert.equal(await pushStore.resolve(row._id, "retry", alice._id), false);
    await pushStore.finish({ ...row.toObject(), claim: row.claim }, { state: "failed", code: "TOKEN_INVALID", invalidate: true, invalidateTokenHash: "old-token-hash", started: true }, now + 1000);
    assert.equal((await Device.findById(device.device)).enabled, true);
  });
  await check("actual order projection pages its source cursor and overlapping scans do not duplicate alerts", async () => {
    const sources = Array.from({ length: 101 }, () => ({ _id: new mongoose.Types.ObjectId(), user: bob._id, updatedAt: new Date(now + 2000), tracking: { events: [{ status: "shipped", timestamp: new Date(now + 2000) }] } }));
    await Order.collection.insertMany(sources);
    await Control.updateOne({ _id: "order-push" }, { $set: { scanAt: new Date(now + 1000), scanFloor: new Date(now + 1000), scanId: "", scanBefore: new Date(now + 4000) } });
    await pushStore.scan(now + 15000);
    assert.equal(await Delivery.countDocuments({ user: bob._id }), 101);
    await pushStore.scan(now + 15000);
    assert.equal(await Delivery.countDocuments({ user: bob._id }), 102);
    await pushStore.scan(now + 15000);
    assert.equal(await Delivery.countDocuments({ user: bob._id }), 102);
  });
  await check("account deletion removes owned private state atomically and prevents its recreation", async () => {
    process.env.ACCOUNT_DELETION_ENABLED = "true";
    process.env.ACCOUNT_ORDER_RETENTION_NOTICE = "Fixture-only notice. Financial records are retained for integration assertions.";
    const res = response();
    await Promise.allSettled([
      deleteAccount({ user: { _id: bob._id, role: "customer" }, body: { confirmation: "DELETE" }, authIssuedAt: Math.floor(Date.now() / 1000) }, res),
      pushStore.register(bob._id, registration({ ...body, binding: crypto.randomUUID(), claimAt: now + 50000 }, now + 50000, encryption)),
    ]);
    assert.equal(res.body.deleted, true);
    assert.equal(await Device.countDocuments({ user: bob._id }), 0); assert.equal(await Delivery.countDocuments({ user: bob._id }), 0);
    assert.equal(await Order.countDocuments({ user: bob._id }), 102, "Financial/fulfillment orders remain retained");
    assert.equal(await User.countDocuments({ _id: alice._id }), 1);
    await assert.rejects(pushStore.register(bob._id, registration({ ...body, binding: crypto.randomUUID(), claimAt: now + 2000 }, now + 2000, encryption)));
    await assert.rejects(service.mutate(bob._id, op(0, [{ type: "seed", selection: { cart: [{ ...line, quantity: 1 }], wishlist: [] } }])));
    assert.equal(await State.countDocuments({ _id: bob._id }), 0);
  });
  console.log(JSON.stringify({ passed: checks.length, failed: 0, checks, database: "disposable-loopback-only", providerCalls: 0 }));
}
run().catch(error => { console.error("FAIL commerce Mongo integration", error.stack); process.exitCode = 1; }).finally(async () => {
  if (mongoose.connection.readyState === 1 && mongoose.connection.name === database && database.startsWith("gymdrobe_fixture_")) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
