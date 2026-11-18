"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const mongoose = require("mongoose");
const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const Job = require("../../models/AutomationJob");
const Heartbeat = require("../../models/AutomationWorkerHeartbeat");
const engine = require("../../utils/automation/engine");
const { POLL_MS } = require("../../utils/automation/workerHealth");

async function run() {
  const uri = process.env.GYMDROBE_TEST_MONGO_URI || "";
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/gymdrobe_fixture_[a-z\d_]+\?replicaSet=[\w-]+$/.test(uri)) {
    throw new Error("A disposable loopback replica set is required.");
  }
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  process.env.MARKETPLACE_ENABLED = "true";
  process.env.AUTOMATION_ENGINE_ENABLED = "true";
  delete process.env.AUTOMATION_WORKER_ENABLED;
  await mongoose.connect(uri, { dbName: "gymdrobe_fixture_worker_health_" + randomBytes(8).toString("hex") });
  let server;
  try {
    await Job.createIndexes();
    const admin = await User.create({ role: "admin", name: "Admin", email: "admin@example.test", password: "Fixture-only-password-123" });
    const customer = await User.create({ role: "customer", name: "Customer", email: "customer@example.test", password: "Fixture-only-password-123" });
    const app = express();
    app.use("/api/admin", require("../../routes/adminRoutes"));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = "http://127.0.0.1:" + server.address().port + "/api/admin/automation";
    const call = (actor = admin, path = "", method = "GET") => fetch(url + path, {
      method, headers: actor ? { Authorization: "Bearer " + jwt.sign({ userId: String(actor._id), authVersion: 0 }, process.env.JWT_SECRET) } : {},
    });
    const read = async () => { const r = await call(); assert.equal(r.status, 200); return (await r.json()).workerHealth; };
    assert.equal((await call(null)).status, 401);
    assert.equal((await call(customer)).status, 403);
    assert.equal((await call(customer, "/process", "POST")).status, 403);
    assert.equal((await read()).state, "disabled");
    assert.equal(await Heartbeat.countDocuments(), 0);
    process.env.AUTOMATION_WORKER_ENABLED = "true";
    assert.equal((await read()).state, "never_seen");
    assert.equal((await call(admin, "/process", "POST")).status, 200);
    const manual = await read();
    assert.equal(manual.state, "never_seen");
    assert.equal(manual.lastScheduledPollAt, null);
    assert.ok(Date.parse(manual.lastManualDrainAt));
    engine.startWorker();
    await delay(POLL_MS + 200);
    const deadline = Date.now() + 5000;
    let live = await read();
    while (live.state !== "polling" && Date.now() < deadline) { await delay(100); live = await read(); }
    await engine.stopWorker();
    assert.equal(live.state, "polling");
    assert.equal(live.lastManualDrainAt, manual.lastManualDrainAt);
    assert.equal(live.oldestDueAt, null);
    const oldest = new Date(Date.now() - 5000);
    for (const [state, at] of [["completed", new Date(0)], ["running", oldest], ["queued", new Date(Date.now() + 50000)]]) {
      await Job.create({ type: engine.TYPE, order: new mongoose.Types.ObjectId(), status: state, nextRunAt: at });
    }
    await Heartbeat.updateOne({}, { $set: { lastScheduledPollAt: new Date(Date.now() - 91000) } });
    const stale = await read();
    assert.equal(stale.state, "stale");
    assert.equal(stale.oldestDueAt, oldest.toISOString());
    assert.equal(await Heartbeat.countDocuments(), 1);
    assert.equal(await Job.countDocuments({ status: "running" }), 1);
    console.log("PASS real timer, empty scheduled poll, manual distinction, stale, oldest due, denied customer, singleton and read-only summary");
  } finally {
    await engine.stopWorker();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
