"use strict";

const express = require("express");
const { config, enabled, validSignature, recordStatuses } = require("../utils/whatsappOrderUpdates");
const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  req.whatsappSettings = enabled() && config();
  if (!req.whatsappSettings || process.env.GYMDROBE_ENV === "staging") return res.sendStatus(404);
  return next();
});
router.get("/", (req, res) => {
  if (req.query["hub.mode"] !== "subscribe" ||
      req.query["hub.verify_token"] !== req.whatsappSettings.verifyToken ||
      !/^\d{1,100}$/.test(req.query["hub.challenge"] || "")) return res.sendStatus(403);
  return res.type("text/plain").send(req.query["hub.challenge"]);
});
router.post("/", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
  if (!validSignature(req.body, req.get("X-Hub-Signature-256"), req.whatsappSettings.appSecret)) return res.sendStatus(403);
  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.sendStatus(400);
  }
  if (payload?.object !== "whatsapp_business_account") return res.sendStatus(400);
  try {
    await recordStatuses(payload, req.whatsappSettings.phone);
    return res.sendStatus(200);
  } catch {
    return res.sendStatus(503);
  }
});

module.exports = router;
