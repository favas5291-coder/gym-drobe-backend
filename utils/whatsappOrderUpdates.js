"use strict";

const Delivery = require("../models/WhatsAppOrderDelivery");
const Order = require("../models/Order");
const { digest, orderUpdates } = require("./orderUpdates");
const { createHmac, timingSafeEqual } = require("node:crypto");

const day = 86400000;
const retries = 4;
const windowMs = 2 * day;
const enabled = () => process.env.WHATSAPP_ORDER_DELIVERY_ENABLED === "true";
const startAt = () => Date.parse(process.env.WHATSAPP_ORDER_DELIVERY_START_AT);
const eligible = (order, event, from, now) =>
  order.metadata?.demo === false && Boolean(order.whatsappOrderUpdates?.consentedAt) &&
  +event.at >= Math.max(from, now - windowMs, +new Date(order.whatsappOrderUpdates.consentedAt));

function config(env = process.env) {
  const { WHATSAPP_GRAPH_VERSION: version, WHATSAPP_PHONE_NUMBER_ID: phone,
    WHATSAPP_ACCESS_TOKEN: token, WHATSAPP_APP_SECRET: appSecret,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: verifyToken, WHATSAPP_ORDER_TEMPLATE: template } = env;
  if (!/^v\d{1,3}\.\d$/.test(version || "") || !/^\d{5,30}$/.test(phone || "") ||
      !token || !appSecret || !verifyToken || !/^[a-z][a-z0-9_]{2,100}$/.test(template || "") ||
      !Number.isFinite(Date.parse(env.WHATSAPP_ORDER_DELIVERY_START_AT))) return null;
  return { version, phone, token, appSecret, verifyToken, template };
}

function indiaPhone(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  const local = digits.replace(/^91(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(local) ? `91${local}` : "";
}

async function sendWhatsApp(settings, { event, order, deliveryId }, request = fetch) {
  const recipient = indiaPhone(order.shippingAddress?.phone);
  if (!recipient) return { state: "failed", code: "INVALID_RECIPIENT" };
  try {
    const response = await request(`https://graph.facebook.com/${settings.version}/${settings.phone}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient,
        type: "template",
        biz_opaque_callback_data: deliveryId,
        template: {
          name: settings.template, language: { code: "en" },
          components: [
            { type: "body", parameters: [{ type: "text", text: order.orderNumber }, { type: "text", text: event.message }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: order.orderNumber }] },
          ],
        },
      }),
    });
    if (response.status === 429) return { state: "pending", code: "RATE_LIMIT" };
    if (response.status >= 500) return { state: "uncertain", code: "PROVIDER_UNCERTAIN" };
    if (!response.ok) return { state: "failed", code: `HTTP_${response.status}` };
    const data = await response.json();
    const id = data.messages?.[0]?.id;
    return typeof id === "string" && id.length <= 300
      ? { state: "accepted", providerId: id, code: "PROVIDER_ACCEPTED" }
      : { state: "uncertain", code: "MISSING_PROVIDER_ID" };
  } catch {
    // A timeout can occur after acceptance. Wait for a signed callback.
    return { state: "uncertain", code: "UNKNOWN_PROVIDER_OUTCOME" };
  }
}

function validSignature(raw, signature, secret) {
  if (!Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/.test(signature || "") || !secret) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

async function recordStatuses(payload, phone, deliveries = Delivery) {
  const allowed = {
    sent: ["sending", "accepted", "uncertain"],
    delivered: ["sending", "accepted", "uncertain", "sent"],
    read: ["sending", "accepted", "uncertain", "sent", "delivered"],
    failed: ["sending", "accepted", "uncertain", "sent"],
  };
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.value?.metadata?.phone_number_id !== phone) continue;
      for (const row of Array.isArray(change.value.statuses) ? change.value.statuses : []) {
        if (!Object.hasOwn(allowed, row?.status) || typeof row.id !== "string" || row.id.length > 300 ||
            !/^[a-f0-9]{64}$/.test(row.biz_opaque_callback_data || "")) continue;
        await deliveries.updateOne({
          _id: row.biz_opaque_callback_data, state: { $in: allowed[row.status] },
          $or: [{ providerId: row.id }, { providerId: { $exists: false } }],
        }, {
          $set: { providerId: row.id, state: row.status, code: `WEBHOOK_${row.status.toUpperCase()}` },
        });
      }
    }
  }
}

async function deliverOrderEvents({ send, from, now = Date.now(), orders = Order, deliveries = Delivery }) {
  await deliveries.updateMany({ state: "sending", dueAt: { $lte: new Date(now) } },
    { $set: { state: "uncertain", code: "WORKER_INTERRUPTED" } });
  // Project durable order/parcel facts. Scan only the activation window and page
  // through candidates so a busy store cannot starve older eligible orders.
  const candidates = orders.find({
    "whatsappOrderUpdates.consentedAt": { $exists: true },
    "metadata.demo": false, updatedAt: { $gte: new Date(Math.max(from, now - windowMs)) },
  }).select("orderNumber status items.name tracking supplierShipments cancellation refund marketplaceResolutions whatsappOrderUpdates shippingAddress.phone metadata.demo")
    .sort({ _id: 1 }).lean().cursor();
  let sends = 0;
  try {
    for await (const order of candidates) {
      for (const event of orderUpdates(order).filter(event => eligible(order, event, from, now)).reverse()) {
        const id = digest(`whatsapp\0${event.id}`);
        await deliveries.updateOne({ _id: id }, { $setOnInsert: {
          order: order._id, state: "pending", dueAt: new Date(now), expiresAt: new Date(now + 30 * day),
        } }, { upsert: true });
        const claim = await deliveries.findOneAndUpdate({
          _id: id, state: "pending", attempts: { $lt: retries }, dueAt: { $lte: new Date(now) },
        }, { $set: { state: "sending", dueAt: new Date(now + 60000) }, $inc: { attempts: 1 } }, { new: true });
        if (!claim) continue;
        const latest = await orders.findOne({ _id: order._id, "whatsappOrderUpdates.consentedAt": { $exists: true },
          "metadata.demo": false }).select("orderNumber whatsappOrderUpdates shippingAddress.phone metadata.demo").lean();
        const result = latest && eligible(latest, event, from, now)
          ? await send({ event, order: latest, deliveryId: id })
          : { state: "cancelled", code: "OPTED_OUT" };
        if (result.state === "pending" && claim.attempts >= retries) result.state = "failed";
        await deliveries.updateOne({ _id: id, state: "sending", attempts: claim.attempts }, { $set: {
          ...result, dueAt: new Date(now + 60000 * 2 ** claim.attempts),
        } });
        if (++sends >= 15) return;
      }
    }
  } finally {
    await candidates.close();
  }
}

function startWorker() {
  const settings = config();
  if (!enabled() || !settings || process.env.GYMDROBE_ENV === "staging" || process.env.NODE_ENV === "test") return;
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await deliverOrderEvents({ from: startAt(), send: input => sendWhatsApp(settings, input) });
    } catch {
      console.error("WhatsApp order update worker could not complete its scan.");
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, 60000);
  timer.unref();
  void tick();
}

module.exports = { config, enabled, deliverOrderEvents, sendWhatsApp, validSignature, recordStatuses, startWorker };
