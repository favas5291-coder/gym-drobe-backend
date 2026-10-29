"use strict";
const crypto = require("node:crypto");
const { DAY, unseal, payload } = require("./domain");
const store = require("./store");
const { createProviders } = require("./providers");

function createNotificationWorker({ repository = store, providers = createProviders(), now = Date.now,
  enabled = () => process.env.PUSH_REGISTRATION_ENABLED === "true" && process.env.PUSH_DELIVERY_ENABLED === "true",
  decrypt = unseal, alert = code => console.error(`Order notification worker: ${code}`) } = {}) {
  let running = false, stopped = false, lastAlert = 0;
  const allowed = async () => !stopped && enabled() && (await repository.control())?.enabled === true;
  const notifyFailure = code => { if (now() - lastAlert >= 300000 || !lastAlert) { lastAlert = now(); alert(code); } };
  async function tick() {
    if (running || !await allowed()) return;
    running = true;
    try {
      if (await repository.recover(now())) notifyFailure("SEND_INTERRUPTED");
      await repository.scan(now());
      for (let i = 0; i < 20 && await allowed(); i++) {
        const row = await repository.claim(now(), crypto.randomUUID());
        if (!row) break;
        const device = +new Date(row.sourceAt) > now() - DAY && await repository.eligible(row, now());
        if (!device) { await repository.finish(row, { state: "cancelled", code: "BINDING_UNAVAILABLE" }, now()); continue; }
        let token, message;
        try { token = decrypt(device.tokenCipher, device._id); message = payload(row); }
        catch { await repository.finish(row, { state: "failed", code: "TOKEN_UNREADABLE" }, now()); notifyFailure("TOKEN_UNREADABLE"); continue; }
        // Recheck the database stop control immediately before the durable send.
        if (!await allowed()) break;
        const saved = await repository.sending(row);
        if (saved.modifiedCount !== 1) continue;
        let result;
        try { result = await providers.send(device, token, message); }
        catch { result = { state: "uncertain", code: "PROVIDER_CONNECTION" }; }
        await repository.finish(row, { ...result, started: true, invalidateTokenHash: device.tokenHash }, now());
        if (["failed", "uncertain"].includes(result.state)) notifyFailure(result.code);
      }
      await repository.heartbeat(now());
    } catch {
      // A persisted sending state is recovered as uncertain after a crash.
      notifyFailure("WORKER_PAUSED");
      await repository.heartbeat(now(), "WORKER_PAUSED").catch(() => {});
    } finally { running = false; }
  }
  return { tick, stop() { stopped = true; } };
}
let worker, timer;
function startNotificationWorker() {
  if (timer || process.env.PUSH_DELIVERY_ENABLED !== "true" || process.env.PUSH_REGISTRATION_ENABLED !== "true") return;
  worker = createNotificationWorker();
  const run = () => { void worker.tick().catch(() => console.error("Order notification worker: CONTROL_UNAVAILABLE")); };
  timer = setInterval(run, 30000); timer.unref?.(); run();
}
function stopNotificationWorker() { clearInterval(timer); timer = null; worker?.stop(); }
module.exports = { createNotificationWorker, startNotificationWorker, stopNotificationWorker };
