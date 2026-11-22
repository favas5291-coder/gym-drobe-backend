// Run on a disposable loopback MongoDB instance. All writes use a fresh random database.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Ticket = require("../../models/SupportTicket");
const { supportReviewFilter } = require("../../utils/supportReview");
const { listTickets } = require("../../middleware/controllers/supportController");

async function main() {
  const origin = process.env.SUPPORT_TEST_MONGO;
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+$/.test(origin || "")) {
    throw new Error("SUPPORT_TEST_MONGO must be a disposable mongodb://127.0.0.1:PORT instance.");
  }
  await mongoose.connect(origin, { dbName: "gd_support_fixture_" + crypto.randomBytes(12).toString("hex") });
  const user = new mongoose.Types.ObjectId();
  const time = new Date("2025-02-28T04:30:00.000Z");
  const make = (subject, createdAt, status = "open", by = "customer") => ({
    user, requestId: subject, subject, status,
    createdAt: new Date(createdAt), updatedAt: time,
    messages: [{ by, requestId: subject + "-msg", text: "Fixture only" }],
  });
  try {
    await Ticket.collection.insertMany([
      make("48h exact", +time - 48 * 3600000),
      make("48h minus 1ms", +time - 48 * 3600000 + 1),
      make("first reply sent", "2025-01-01", "open", "store"),
      make("resolved", "2025-01-01", "resolved"),
      make("Jan31 exact", "2025-01-31T04:30:00Z", "waiting"),
      make("Jan30 plus 1ms", "2025-01-30T04:30:00.001Z"),
      make("IST next month", "2025-01-31T18:31:00Z"),
      make("Jan29 exact", "2025-01-29T04:30:00Z"),
    ]);
    const subjects = async filter => (await Ticket.find(filter).select("subject").lean()).map(x => x.subject).sort();
    assert.deepEqual(await subjects(supportReviewFilter("unresolved-month", time)),
      ["Jan29 exact", "Jan31 exact", "first reply sent"].sort());
    assert.deepEqual(await subjects(supportReviewFilter("first-reply", time)),
      ["48h exact", "Jan31 exact", "Jan30 plus 1ms", "Jan29 exact", "IST next month"].sort());
    async function list(role, path, query) {
      const res = { statusCode: 200, set: () => res, status: code => {res.statusCode = code; return res;}, json: body => {res.body = body;} };
      await listTickets({ path, query, user: {role, _id:user} }, res);
      return res;
    }
    const admin = await list("admin", "/admin/tickets", {review:"first-reply"});
    assert.equal(admin.statusCode, 200);
    assert.equal(admin.body.review, "first-reply");
    assert.ok(new Date(admin.body.checkedAt) <= new Date());
    assert.ok(admin.body.tickets.every(t => t.messages.length === 0));
    assert.equal((await list("customer", "/", {review:"first-reply"})).statusCode, 403);
    assert.equal((await list("admin", "/", {review:"unresolved-month"})).statusCode, 403);
    assert.equal((await list("admin", "/admin/tickets", {review:"invalid"})).statusCode, 400);
    assert.equal((await list("admin", "/admin/tickets", {review:"first-reply",status:"open"})).statusCode, 400);
    assert.equal((await list("customer", "/", {})).body.total, 8);
    console.log("PASS MongoDB deadline boundaries, IST month-end clamping, message history, closed tickets and scoped controller responses.");
  } finally {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
