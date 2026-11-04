"use strict";
const express = require("express");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { registration, bindingInput } = require("../utils/notifications/domain");
const store = require("../utils/notifications/store");

function createNotificationRouter({ auth = protect, admin = adminOnly, repository = store,
  enabled = () => process.env.PUSH_REGISTRATION_ENABLED === "true", register = registration } = {}) {
  const router = express.Router(), buckets = new Map();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Pragma", "no-cache"); next(); });
  router.use(auth);
  router.use((req, res, next) => {
    const now = Date.now(), id = String(req.user._id);
    for (const [key, value] of buckets) if (value.until < now) buckets.delete(key);
    const bucket = buckets.get(id) || { until: now + 60000, count: 0 };
    if (!buckets.has(id) && buckets.size >= 10000) return res.status(503).json({ success: false, message: "Notification settings are busy." });
    buckets.set(id, bucket);
    if (++bucket.count > 30) return res.status(429).set("Retry-After", "60").json({ success: false, message: "Please wait before changing notification settings again." });
    next();
  });
  const handle = work => async (req, res) => {
    try { await work(req, res); }
    catch (error) { res.status(error.notification ? error.status : 503).json({ success: false, message: error.notification ? error.message : "Notification settings could not be saved. Please retry." }); }
  };
  router.get("/devices", handle(async (req, res) => res.json({ success: true, available: enabled(), devices: enabled() ? await repository.devices(req.user._id) : [] })));
  router.post("/devices", handle(async (req, res) => {
    if (!enabled()) return res.status(503).json({ success: false, message: "Order notifications are not available yet." });
    if (Buffer.byteLength(JSON.stringify(req.body || {})) > 8192) return res.status(413).json({ success: false, message: "Notification settings are too large." });
    res.json({ success: true, ...await repository.register(req.user._id, register(req.body)) });
  }));
  // Disable remains available during a rollout stop/rollback.
  router.delete("/devices", handle(async (req, res) => { await repository.disable(req.user._id, bindingInput(req.body)); res.json({ success: true, enabled: false }); }));
  router.get("/admin", admin, handle(async (_req, res) => res.json({ success: true, control: await repository.control(), ...await repository.summary() })));
  router.put("/admin/control", admin, handle(async (req, res) => {
    if (typeof req.body?.enabled !== "boolean" || Object.keys(req.body).some(k => k !== "enabled")) return res.status(400).json({ success: false, message: "Choose whether notification delivery is enabled." });
    // Environment and credentials still gate the worker. This is an additional
    // immediate database stop, not a deployment or authorization to send.
    res.json({ success: true, control: await repository.setControl(req.body.enabled, req.user._id) });
  }));
  router.post("/admin/deliveries/:id", admin, handle(async (req, res) => {
    const saved = await repository.resolve(req.params.id, req.body?.action, req.user._id);
    res.status(saved ? 200 : 409).json({ success: saved, message: saved ? "Delivery review recorded." : "This delivery cannot be retried. Review uncertain sends without resending them." });
  }));
  return router;
}
module.exports = { createNotificationRouter };
