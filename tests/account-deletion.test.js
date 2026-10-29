const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const User = require("../models/User");
const Address = require("../models/Address");
const Review = require("../models/Review");
const SupportTicket = require("../models/SupportTicket");
const ShoppingState = require("../models/ShoppingState");
const ShoppingOperation = require("../models/ShoppingOperation");
const { Device: NotificationDevice, Delivery: NotificationDelivery } = require("../models/NotificationStore");
const { deleteAccount, deletionPolicy } = require("../middleware/controllers/accountDeletionController");
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

test("account deletion is unavailable until the store supplies its actual retention notice", async () => {
  const before = process.env.ACCOUNT_DELETION_ENABLED;
  process.env.ACCOUNT_DELETION_ENABLED = "false";
  try {
    const res = response(); await deleteAccount({}, res); assert.equal(res.statusCode, 503);
    const policy = response(); deletionPolicy({}, policy); assert.equal(policy.body.enabled, false);
  } finally { if (before === undefined) delete process.env.ACCOUNT_DELETION_ENABLED; else process.env.ACCOUNT_DELETION_ENABLED = before; }
});
test("deletion requires recent authentication, customer role, confirmation, and an atomic data removal", async () => {
  const previous = { enabled: process.env.ACCOUNT_DELETION_ENABLED, notice: process.env.ACCOUNT_ORDER_RETENTION_NOTICE };
  process.env.ACCOUNT_DELETION_ENABLED = "true";
  process.env.ACCOUNT_ORDER_RETENTION_NOTICE = "Fixture retention notice for financial records; not a real store policy.";
  const originals = [User.findById, User.deleteOne, Address.deleteMany, Review.deleteMany, SupportTicket.deleteMany, ShoppingState.deleteOne, ShoppingOperation.deleteMany, NotificationDevice.deleteMany, NotificationDelivery.deleteMany, mongoose.startSession];
  const operations = [], session = { withTransaction: async (operation) => { operations.push("transaction"); await operation(); }, endSession: async () => { operations.push("ended"); } };
  User.findById = () => ({ select: async () => ({ _id: "customer-id", role: "customer" }) });
  for (const [model, name, method] of [[User, "profile", "deleteOne"], [Address, "addresses", "deleteMany"], [Review, "reviews", "deleteMany"], [SupportTicket, "support", "deleteMany"], [ShoppingState, "shopping-state", "deleteOne"], [ShoppingOperation, "shopping-receipts", "deleteMany"], [NotificationDevice, "notification-devices", "deleteMany"], [NotificationDelivery, "notification-deliveries", "deleteMany"]]) model[method] = async (query, options) => { assert.equal(options.session, session); assert.equal(query.user || query._id, "customer-id"); operations.push(name); return { deletedCount: 1 }; };
  mongoose.startSession = async () => session;
  const req = { user: { _id: "customer-id", role: "customer" }, authIssuedAt: Math.floor(Date.now() / 1000), body: { confirmation: "DELETE" } };
  try {
    for (const [override, status] of [[{ authIssuedAt: 0 }, 401], [{ body: { confirmation: "delete" } }, 400], [{ user: { role: "admin" } }, 403]]) { const res = response(); await deleteAccount({ ...req, ...override }, res); assert.equal(res.statusCode, status); }
    assert.deepEqual(operations, []);
    const res = response(); await deleteAccount(req, res);
    assert.equal(res.body.deleted, true); assert.deepEqual(operations, ["transaction", "profile", "addresses", "reviews", "support", "shopping-state", "shopping-receipts", "notification-devices", "notification-deliveries", "ended"]);
    Address.deleteMany = async () => { throw new Error("database outage"); };
    const failed = response(); await deleteAccount(req, failed); assert.equal(failed.statusCode, 503); assert.notEqual(failed.body.deleted, true);
  } finally {
    [User.findById, User.deleteOne, Address.deleteMany, Review.deleteMany, SupportTicket.deleteMany, ShoppingState.deleteOne, ShoppingOperation.deleteMany, NotificationDevice.deleteMany, NotificationDelivery.deleteMany, mongoose.startSession] = originals;
    for (const [key, value] of [["ACCOUNT_DELETION_ENABLED", previous.enabled], ["ACCOUNT_ORDER_RETENTION_NOTICE", previous.notice]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
