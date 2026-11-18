"use strict";
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const engine = require("../../utils/automation/engine");
const Job = require("../../models/AutomationJob");

module.exports = async function verifyAutomation({ order, admin, customer, token, base }) {
  const req = async (path, method = "GET", user = admin) => {
    const response = await fetch(base.replace("/marketplace", "/admin/automation") + path, {
      method, headers: { Authorization: "Bearer " + token(user) },
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await req("", "GET", customer)).status, 403);
  assert.equal(await Job.countDocuments({ order: order._id }), 1);
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await engine.enqueue(new mongoose.Types.ObjectId(), session);
    await session.abortTransaction();
  } finally { await session.endSession(); }
  await engine.enqueue(order._id);
  assert.equal(await Job.countDocuments(), 1, "replays and aborted transactions do not add work");
  const response = await req("/process", "POST");
  assert.deepEqual(response.body, { success: true, processed: 1 });
  let page = (await req("")).body;
  assert.equal(page.counts.completed, 1, JSON.stringify(page));
  const job = page.jobs[0];
  assert.equal(job.orderId, String(order._id));
  assert.ok(page.lastSuccessAt);
  assert.equal((await req("/jobs/" + job.id + "/retry", "POST")).status, 409);

  await req("/orders/" + order._id + "/reconcile", "POST");
  // Keep the first claim paused until its lease expires and another runner has completed the job.
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const t = Date.now() + 50;
  const first = engine.processOne({ now: () => new Date(t), check: async () => { enter(); await gate; return "FULFILMENT_MISMATCH"; } });
  await entered;
  assert.equal(await engine.processOne({ now: () => new Date(t + 2000) }), false);
  assert.equal(await engine.processOne({ now: () => new Date(t + 61000) }), true);
  release();
  await first;
  assert.equal((await Job.findById(job.id)).status, "completed");

  await req("/orders/" + order._id + "/reconcile", "POST");
  let tick = t + 120000;
  for (let i = 0; i < 5; i += 1) {
    assert.ok(await engine.processOne({now: () => new Date(tick), check: async () => { throw new Error("private provider detail"); }}));
    tick += 600000;
  }
  assert.equal(await engine.processOne({now: () => new Date(tick)}), false);
  page = (await req("?status=failed")).body;
  assert.equal(page.jobs[0].lastError, "RETRYABLE_READ_FAILURE");
  assert.ok(!JSON.stringify(page).includes("private provider"));
  assert.equal((await req("/jobs/" + job.id + "/retry", "POST")).status, 200);
  await req("/process", "POST");
  assert.equal((await req("")).body.counts.completed, 1);

  process.env.AUTOMATION_ENGINE_ENABLED = "false";
  assert.equal((await req("")).body.enabled, false);
  assert.equal((await req("/process", "POST")).status, 503);
};
