"use strict";
const crypto = require("node:crypto");
const DAY = 86400000;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const invalid = message => Object.assign(new Error(message), { notification: true, status: 400 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function encryptionKey(value = process.env.PUSH_TOKEN_ENCRYPTION_KEY) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("PUSH_KEY_UNAVAILABLE");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("PUSH_KEY_UNAVAILABLE");
  return key;
}
function seal(token, id, key = encryptionKey()) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id));
  const bytes = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(value => value.toString("base64url")).join(".");
}
function unseal(value, id, key = encryptionKey()) {
  const parts = String(value).split(".");
  if (parts.length !== 3) throw new Error("PUSH_TOKEN_INVALID");
  const [iv, tag, bytes] = parts.map(part => Buffer.from(part, "base64url"));
  const cipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8");
}
function registration(body, now = Date.now(), key = encryptionKey()) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["installationId", "binding", "token", "platform", "environment", "orderUpdates", "refresh", "claimAt"].includes(k))) throw invalid("Send only this device’s notification settings.");
  if (!uuid.test(body.installationId) || !uuid.test(body.binding) || body.orderUpdates !== true) throw invalid("Choose order updates to register this device.");
  if (typeof body.refresh !== "boolean" || !Number.isSafeInteger(body.claimAt) || body.claimAt > now + 300000 || (!body.refresh && body.claimAt < now - 300000)) throw invalid("This notification request expired. Choose order updates again.");
  const { platform, environment } = body;
  if (!["ios", "android"].includes(platform) || !["sandbox", "production"].includes(environment) || (platform === "android" && environment !== "production")) throw invalid("Unsupported notification platform.");
  const token = body.token;
  if (typeof token !== "string" || (platform === "ios" ? !/^[a-f0-9]{64,200}$/i.test(token) || token.length % 2 : !/^[A-Za-z0-9_:\-]{32,4096}$/.test(token))) throw invalid("The device did not return a valid notification token.");
  const normalized = platform === "ios" ? token.toLowerCase() : token;
  const id = digest(body.installationId.toLowerCase());
  return { _id: id, binding: body.binding.toLowerCase(), platform, environment,
    tokenHash: digest(`${platform}\0${environment}\0${normalized}`), tokenCipher: seal(normalized, id, key),
    enabled: true, refresh: body.refresh, bindingIssuedAt: new Date(body.claimAt), consentAt: new Date(now), expiresAt: new Date(now + 90 * DAY) };
}
function registrationUpdate(current, row, user) {
  const same = current?.enabled && String(current.user) === String(user) && current.binding === row.binding;
  if (row.refresh && !same) throw Object.assign(invalid("This device’s notification preference changed. Choose order updates again."), { status: 409 });
  if (!same && current && +row.bindingIssuedAt <= +new Date(current.bindingIssuedAt)) throw Object.assign(invalid("A newer sign-in changed this device’s notifications. Please retry."), { status: 409 });
  const { refresh: _refresh, ...saved } = row;
  if (same) { saved.consentAt = current.consentAt; saved.bindingIssuedAt = current.bindingIssuedAt; }
  return saved;
}
function bindingInput(body) {
  if (!body || Object.keys(body).some(k => !["device", "binding"].includes(k)) || !/^[a-f0-9]{64}$/.test(body.device) || !uuid.test(body.binding)) throw invalid("Load this device’s saved settings before disabling updates.");
  return { device: body.device, binding: body.binding.toLowerCase() };
}
// Only durable server order events are projected. No client payment result,
// courier animation or inferred shipping milestone can create an alert.
function orderEvents(order, now = Date.now()) {
  if (!order.user || !/^[a-f0-9]{24}$/i.test(String(order._id))) return [];
  const events = [];
  const add = (kind, value) => {
    const at = value ? new Date(value).getTime() : NaN;
    if (Number.isFinite(at) && at <= now && at > now - DAY) events.push({ kind, at, key: digest(`${order._id}\0${kind}\0${at}`) });
  };
  const allowed = new Set(["confirmed", "shipped", "out-for-delivery", "delivered", "cancelled"]);
  for (const event of order.tracking?.events || []) if (allowed.has(event.status)) add(event.status, event.timestamp);
  const request = order.returnRequest || {};
  for (const [status, field] of [["requested", "requestedAt"], ["approved", "approvedAt"], ["rejected", "rejectedAt"], ["completed", "completedAt"]]) {
    if (request.status === status) add(`return-${status}`, request[field]);
  }
  if (order.refund?.status === "refunded") add("refunded", order.refund.refundedAt);
  return [...new Map(events.map(event => [event.key, event])).values()];
}
function payload(delivery) {
  if (!/^[a-f0-9]{24}$/i.test(String(delivery.order))) throw new Error("PUSH_ORDER_INVALID");
  return { title: "GymDrobe", body: "Your GymDrobe order has an update.",
    data: { url: `https://www.gymdrobe.com/orders/${delivery.order}`, eventId: delivery._id },
    collapseId: delivery._id.slice(0, 64) };
}
function deliveryFor(order, event, device, now = Date.now()) {
  if (!device.enabled || String(device.user) !== String(order.user) || event.at <= +new Date(device.consentAt) || +new Date(device.expiresAt) <= now) return null;
  return { _id: digest(`${device._id}\0${device.binding}\0${event.key}`), user: order.user, order: order._id,
    device: device._id, binding: device.binding, kind: event.kind, sourceAt: new Date(event.at),
    state: "pending", attempts: 0, nextAttemptAt: new Date(now), expiresAt: new Date(now + 30 * DAY) };
}
function providerResult(status, reason = "") {
  if (!Number.isInteger(status) || status < 100) return { state: "uncertain", code: "PROVIDER_RESPONSE" };
  if (status >= 200 && status < 300) return { state: "sent", code: "PROVIDER_ACCEPTED" };
  if (status === 410 || reason === "UNREGISTERED" || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") return { state: "failed", code: "TOKEN_INVALID", invalidate: true };
  if ([429, 500, 502, 503, 504].includes(status)) return { state: "pending", code: "PROVIDER_RETRY" };
  return { state: "failed", code: [401, 403].includes(status) ? "PROVIDER_CREDENTIALS" : "PROVIDER_REJECTED" };
}
module.exports = { DAY, digest, uuid, encryptionKey, seal, unseal, registration, registrationUpdate, bindingInput, orderEvents, payload, deliveryFor, providerResult };
