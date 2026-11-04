"use strict";
const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const { createShoppingService } = require("../utils/shoppingState");
const store = require("../utils/shoppingStore");

function createShoppingRouter({ auth = protect, service = createShoppingService({ store }), enabled = () => process.env.SHOPPING_SYNC_ENABLED === "true" } = {}) {
  const router = express.Router();
  const buckets = new Map();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
    if (!enabled()) return res.status(503).json({ success: false, code: "SHOPPING_SYNC_UNAVAILABLE", message: "Account saving is not available yet. Your shopping lists are kept on this device." });
    return next();
  });
  router.use(auth);
  router.use((req, res, next) => {
    const now = Date.now();
    for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
    const id = String(req.user._id), bucket = buckets.get(id) || { count: 0, until: now + 60000 };
    if (!buckets.has(id) && buckets.size >= 10000) return res.status(503).json({ success: false, code: "SHOPPING_SYNC_BUSY", message: "Saving is busy. Your lists are kept on this device." });
    buckets.set(id, bucket);
    if (++bucket.count > 120) { res.set("Retry-After", "60"); return res.status(429).json({ success: false, code: "SHOPPING_RATE_LIMITED", message: "Please wait before syncing again." }); }
    return next();
  });
  const handle = work => async (req, res) => {
    try { return await work(req, res); }
    catch (error) {
      const known = error.shopping === true;
      return res.status(known ? error.status : 503).json({ success: false,
        code: known ? error.code : "SHOPPING_SYNC_UNAVAILABLE",
        message: known ? error.message : "Your lists could not sync. They are kept on this device.",
        ...(known && error.state ? { state: error.state } : {}) });
    }
  };
  router.get("/", handle(async (req, res) => res.json({ success: true, state: await service.read(req.user._id), serverNow: Date.now() })));
  router.post("/operations", handle(async (req, res) => {
    if (Buffer.byteLength(JSON.stringify(req.body || {})) > 131072) return res.status(413).json({ success: false, message: "The shopping change is too large." });
    return res.json({ success: true, ...await service.mutate(req.user._id, req.body), serverNow: Date.now() });
  }));
  return router;
}
module.exports = { createShoppingRouter };
