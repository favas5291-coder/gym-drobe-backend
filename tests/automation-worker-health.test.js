"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../utils/automation/engine");
const { status, POLL_MS, readWorkerHealth } = require("../utils/automation/workerHealth");
const Heartbeat = require("../models/AutomationWorkerHeartbeat");
const Job = require("../models/AutomationJob");

test("poll evidence allows empty work, expires at 90 seconds and detects clock skew", () => {
  const now = new Date(1000000);
  assert.equal(status(false, new Date(+now - 1000), now), "disabled");
  assert.equal(status(true, null, now), "never_seen");
  assert.equal(status(true, new Date(+now - 3 * POLL_MS + 1), now), "polling");
  assert.equal(status(true, new Date(+now - 3 * POLL_MS), now), "stale");
  assert.equal(status(true, new Date(+now + POLL_MS + 1), now), "clock_skew");
});

test("disabled summary performs no queue or heartbeat reads", async t => {
  t.mock.method(Job, "findOne", () => assert.fail("unexpected queue read"));
  t.mock.method(Heartbeat, "findById", () => assert.fail("unexpected heartbeat read"));
  const health = await readWorkerHealth({ enabled: false, workerEnabled: false, type: engine.TYPE });
  assert.equal(health.state, "disabled");
  assert.equal(health.oldestDueAt, null);
});

test("a failed heartbeat read remains distinguishable from a never-seen worker", async t => {
  const due = new Date();
  const query = result => ({ sort() { return this; }, select() { return this; }, lean() { return this; }, maxTimeMS: result });
  t.mock.method(Heartbeat, "findById", () => query(async () => { throw new Error("unreadable"); }));
  t.mock.method(Job, "findOne", () => query(async () => ({ nextRunAt: due })));
  const health = await readWorkerHealth({ enabled: true, workerEnabled: true, type: engine.TYPE });
  assert.equal(health.state, "unavailable");
  assert.equal(health.heartbeatReadable, false);
  assert.equal(health.dueWorkReadable, true);
  assert.equal(health.oldestDueAt, due);
});

test("only completed scheduled polls record scheduled evidence", async t => {
  const vars = ["MARKETPLACE_ENABLED", "AUTOMATION_ENGINE_ENABLED", "AUTOMATION_WORKER_ENABLED"];
  const saved = Object.fromEntries(vars.map(k => [k, process.env[k]]));
  for (const k of vars) process.env[k] = "true";
  t.after(async () => {
    await engine.stopWorker();
    for (const k of vars) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  let tick;
  t.mock.method(globalThis, "setInterval", (fn, ms) => {
    assert.equal(ms, POLL_MS); tick = fn; return { unref() {} };
  });
  const writes = [];
  t.mock.method(Heartbeat, "updateOne", async (filter, update) => { writes.push(Object.keys(update.$currentDate)[0]); });
  let outcome;
  t.mock.method(Job, "findOneAndUpdate", () => ({ lean: () => outcome }));
  engine.startWorker();
  let release;
  outcome = new Promise(resolve => { release = resolve; });
  const manual = engine.drain("admin");
  tick();
  release(null);
  assert.equal(await manual, 0);
  assert.deepEqual(writes, ["lastManualDrainAt"]);
  t.mock.method(console, "error", () => {});
  outcome = Promise.reject(new Error("queue unavailable"));
  tick();
  await engine.stopWorker();
  assert.deepEqual(writes, ["lastManualDrainAt"]);
  outcome = Promise.resolve(null);
  engine.startWorker();
  tick();
  await engine.stopWorker();
  assert.deepEqual(writes, ["lastManualDrainAt", "lastScheduledPollAt"]);
});
