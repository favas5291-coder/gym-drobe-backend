"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const { once } = require("node:events");
const { EventEmitter } = require("node:events");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { registration, registrationUpdate, unseal, seal, orderEvents, deliveryFor, providerResult, payload, DAY } = require("../utils/notifications/domain");
const { createNotificationWorker } = require("../utils/notifications/worker");
const { createProviders } = require("../utils/notifications/providers");
const { createNotificationRouter } = require("../routes/notificationRoutes");
const now = Date.parse("2026-10-30T00:00:00Z"), key = crypto.randomBytes(32);
const alice = "6ad2351ed8f991271e3d1a8b", bob = "6ad24b64d8f991271e3d1eee";
const input = { installationId: crypto.randomUUID(), binding: crypto.randomUUID(), token: "a".repeat(64), platform: "ios", environment: "sandbox", orderUpdates: true, refresh: false, claimAt: now };

test("device registration requires explicit consent, minimal validated fields, and authenticated encryption", () => {
  const saved = registration(input, now, key);
  assert.equal(unseal(saved.tokenCipher, saved._id, key), input.token);
  assert.ok(!JSON.stringify(saved).includes(input.token));
  assert.notEqual(seal(input.token, saved._id, key), saved.tokenCipher);
  assert.throws(() => unseal(saved.tokenCipher, "different-device", key));
  assert.throws(() => unseal(saved.tokenCipher.slice(0, -8) + "tampered!", saved._id, key));
  assert.throws(() => unseal(saved.tokenCipher, saved._id, crypto.randomBytes(32)));
  for (const bad of [{ orderUpdates: false }, { user: alice }, { platform: "web" }, { token: "invalid" }, { installationId: "device" }]) assert.throws(() => registration({ ...input, ...bad }, now, key));
});
test("old token callbacks cannot rebind a phone after another account has claimed it", () => {
  const first = registration(input, now, key), current = { ...first, user: alice };
  const next = registration({ ...input, binding: crypto.randomUUID(), claimAt: now + 1 }, now + 1, key);
  const rebound = { ...registrationUpdate(current, next, bob), user: bob };
  assert.throws(() => registrationUpdate(rebound, { ...first, refresh: true }, alice), { status: 409 });
  assert.throws(() => registrationUpdate(rebound, first, alice), { status: 409 });
  const refreshed = registrationUpdate(rebound, { ...next, refresh: true, consentAt: new Date(now + 500) }, bob);
  assert.equal(+refreshed.consentAt, now + 1);
  assert.throws(() => registrationUpdate({ ...rebound, enabled: false }, { ...next, refresh: true }, bob));
});
test("only real recent server order milestones produce generic notifications", () => {
  const order = { _id: alice, user: bob, status: "delivered", customer: { name: "private", email: "private@example.test" },
    tracking: { events: [{ status: "confirmed", timestamp: now - 2000 }, { status: "delivered", timestamp: now - 1000 }, { status: "delivered", timestamp: now - 1000 }, { status: "shipped", timestamp: now - 2 * DAY }, { status: "paid", timestamp: now - 1000 }] },
    returnRequest: { status: "approved", approvedAt: now - 500 }, refund: { status: "refunded", refundedAt: now - 100 } };
  const events = orderEvents(order, now);
  assert.deepEqual(events.map(event => event.kind), ["confirmed", "delivered", "return-approved", "refunded"]);
  assert.deepEqual(orderEvents({ ...order, user: null }, now), []);
  assert.deepEqual(orderEvents({ _id: alice, user: bob, status: "shipped", createdAt: now - 500 }, now), []);
  const device = { _id: "device", binding: "binding", user: bob, enabled: true, consentAt: now - 3000, expiresAt: now + DAY };
  const row = deliveryFor(order, events[0], device, now);
  assert.equal(deliveryFor(order, events[0], device, now)._id, row._id);
  assert.equal(deliveryFor(order, events[0], { ...device, user: alice }, now), null);
  assert.equal(deliveryFor(order, events[0], { ...device, enabled: false }, now), null);
  assert.equal(deliveryFor(order, events[0], { ...device, consentAt: now }, now), null);
  assert.equal(deliveryFor(order, events[0], { ...device, expiresAt: now - 1 }, now), null);
  const message = payload(row);
  assert.equal(message.data.url, `https://www.gymdrobe.com/orders/${alice}`);
  assert.ok(!JSON.stringify(message).includes("private"));
  assert.ok(!JSON.stringify(message).includes("delivered"));
});
test("provider rejection, invalid token, retry and ambiguous outcomes remain distinct", () => {
  assert.equal(providerResult(200).state, "sent");
  for (const status of [429, 500, 503]) assert.equal(providerResult(status).state, "pending");
  assert.equal(providerResult(403).code, "PROVIDER_CREDENTIALS");
  assert.equal(providerResult(404, "UNREGISTERED").invalidate, true);
  assert.equal(providerResult(410).invalidate, true);
  assert.equal(providerResult(400, "BadDeviceToken").invalidate, true);
  assert.equal(providerResult(400).state, "failed");
  assert.equal(providerResult(0).state, "uncertain");
});
function fixture({ state = "pending", outcome = { state: "sent", code: "PROVIDER_ACCEPTED" }, eligible = true, enabled = true } = {}) {
  let sends = 0, allowed = enabled;
  const row = { _id: "a".repeat(64), user: alice, order: bob, device: "device", binding: "binding", sourceAt: new Date(now - 1000), state, attempts: 0 };
  const log = [], alerts = [];
  const repository = {
    async control() { return { enabled: allowed }; }, async scan() {},
    async recover() { if (row.state === "sending") { row.state = "uncertain"; return 1; } if (row.state === "leased") row.state = "pending"; return 0; },
    async claim(_now, claim) { if (row.state !== "pending" || row.attempts >= 5) return null; row.state = "leased"; row.claim = claim; return { ...row }; },
    async eligible() { return eligible && { _id: "device", platform: "ios", tokenCipher: "encrypted" }; },
    async sending() { log.push("sending"); row.state = "sending"; row.attempts++; return { modifiedCount: 1 }; },
    async finish(_row, result) { log.push(result.state); Object.assign(row, result); if (row.state === "pending" && row.attempts >= 5) row.state = "failed"; },
    async heartbeat() {},
  };
  const providers = { async send() { log.push("provider"); sends++; if (outcome instanceof Error) throw outcome; return outcome; } };
  const worker = createNotificationWorker({ repository, providers, enabled: () => true, now: () => now, decrypt: () => "token", alert: value => alerts.push(value) });
  return { worker, repository, row, log, alerts, get sends() { return sends; }, disable() { allowed = false; } };
}
test("durable sending precedes provider work and repeated polling never duplicates accepted delivery", async () => {
  const f = fixture(); await f.worker.tick(); await f.worker.tick();
  assert.equal(f.sends, 1); assert.deepEqual(f.log, ["sending", "provider", "sent"]);
});
test("ambiguous network failures and interrupted send claims require review without resend", async () => {
  for (const options of [{ outcome: new Error("network") }, { state: "sending" }]) {
    const f = fixture(options); await f.worker.tick(); await f.worker.tick();
    assert.equal(f.row.state, "uncertain"); assert.equal(f.sends, options.state ? 0 : 1); assert.ok(f.alerts.length);
  }
});
test("stopped workers, disabled bindings, expired events and lost claims cannot send", async () => {
  const disabled = fixture({ enabled: false }); await disabled.worker.tick(); assert.equal(disabled.sends, 0);
  const stopped = fixture(); stopped.worker.stop(); await stopped.worker.tick(); assert.equal(stopped.sends, 0);
  const invalid = fixture({ eligible: false }); await invalid.worker.tick(); assert.equal(invalid.sends, 0); assert.equal(invalid.row.state, "cancelled");
  const old = fixture(); old.row.sourceAt = new Date(now - 2 * DAY); await old.worker.tick(); assert.equal(old.sends, 0);
  const raced = fixture(); raced.repository.sending = async () => ({ modifiedCount: 0 }); await raced.worker.tick(); assert.equal(raced.sends, 0);
});
test("known provider retries are bounded and a stop during validation prevents the request", async () => {
  const f = fixture({ outcome: { state: "pending", code: "PROVIDER_RETRY" } });
  await f.worker.tick(); assert.equal(f.sends, 5); assert.equal(f.row.state, "failed");
  const stopped = fixture(); stopped.repository.eligible = async () => { stopped.disable(); return { tokenCipher: "encrypted" }; };
  await stopped.worker.tick(); assert.equal(stopped.sends, 0);
});
test("FCM uses server OAuth, stable v1, minimal payload and never retries a lost response", async () => {
  const calls = [], env = { FCM_PROJECT_ID: "fixture-project", FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: "service_account", project_id: "fixture-project", client_email: "fixture@example.test", private_key: "fixture" }) };
  class Auth { constructor(options) { assert.deepEqual(options.scopes, ["https://www.googleapis.com/auth/firebase.messaging"]); } async getAccessToken() { return "fixture-access"; } }
  const p = createProviders({ env, Auth, request: async (url, options) => { calls.push({ url, options }); return { status: 200, json: async () => ({ name: "fixture" }) }; } });
  const message = payload({ _id: "a".repeat(64), order: alice });
  assert.equal((await p.send({ platform: "android" }, "fixture-token", message)).state, "sent");
  assert.equal(calls.length, 1); assert.ok(calls[0].url.includes("/v1/projects/fixture-project/messages:send"));
  const body = JSON.parse(calls[0].options.body); assert.equal(body.message.android.notification.channel_id, "gymdrobe-orders"); assert.equal(body.message.token, "fixture-token");
  const lost = createProviders({ env, Auth, request: async () => { throw new Error("timeout"); } });
  assert.equal((await lost.send({ platform: "android" }, "fixture-token", message)).state, "uncertain");
  const missing = createProviders({ env: {}, request: async () => { throw new Error("must not call provider"); } });
  assert.equal((await missing.send({ platform: "ios" }, "token", message)).code, "PROVIDER_ENVIRONMENT");
});
test("APNs signs a valid ES256 JWT and uses the selected environment and minimal alert payload", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const env = { APNS_ENVIRONMENT: "sandbox", APNS_KEY_ID: "ABCDEFGHIJ", APPLE_TEAM_ID: "KLMNOPQRST", APNS_TOPIC: "com.gymdrobe.app", APNS_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) };
  let address, headers, content;
  const connect = url => {
    address = url; const client = new EventEmitter(); client.destroy = () => {};
    client.request = value => {
      headers = value; const stream = new EventEmitter(); stream.close = () => {};
      stream.end = body => { content = JSON.parse(body); queueMicrotask(() => { stream.emit("response", { ":status": 200 }); stream.emit("end"); }); };
      return stream;
    }; return client;
  };
  const provider = createProviders({ env, connect, now: () => now });
  const result = await provider.send({ platform: "ios", environment: "sandbox" }, "a".repeat(64), payload({ _id: "b".repeat(64), order: alice }));
  assert.equal(result.state, "sent"); assert.equal(address, "https://api.sandbox.push.apple.com");
  assert.equal(headers["apns-topic"], "com.gymdrobe.app"); assert.equal(headers["apns-push-type"], "alert");
  const parts = headers.authorization.replace("bearer ", "").split(".");
  assert.equal(JSON.parse(Buffer.from(parts[0], "base64url")).alg, "ES256");
  assert.equal(JSON.parse(Buffer.from(parts[1], "base64url")).iss, "KLMNOPQRST");
  assert.equal(crypto.verify("sha256", Buffer.from(parts[0] + "." + parts[1]), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url")), true);
  assert.equal(content.aps.alert.body, "Your GymDrobe order has an update.");
  assert.equal((await provider.send({ platform: "ios", environment: "production" }, "token", {})).code, "PROVIDER_ENVIRONMENT");
});
test("actual JWT routes isolate device preferences and restrict delivery controls to admins", async () => {
  const previousSecret = process.env.JWT_SECRET, originalFind = User.findById;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  User.findById = id => ({ select: async () => ({ _id: id, role: id === bob ? "admin" : "customer", isActive: true, authVersion: 0 }) });
  const writes = [], repository = { devices: async id => [{ device: "owned-" + id }], register: async (id, row) => { writes.push({ id, row }); return { device: row._id, binding: row.binding, enabled: true }; }, disable: async (id, row) => writes.push({ id, row }), control: async () => ({ enabled: false }), summary: async () => ({ counts: {} }) };
  const app = express(); app.use(express.json()); app.use("/api/notifications", createNotificationRouter({ repository, enabled: () => true, register: body => registration(body, now, key) }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/notifications`;
  const call = (path, id, body, method = body ? "POST" : "GET") => fetch(base + path, { method, headers: { ...(id ? { Authorization: "Bearer " + jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: "5m" }) } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await call("/devices")).status, 401);
    const a = await call("/devices", alice), b = await call("/devices", bob);
    assert.equal(a.headers.get("cache-control"), "no-store");
    assert.notDeepEqual((await a.json()).devices, (await b.json()).devices);
    assert.equal((await call("/devices", alice, { ...input, user: bob })).status, 400);
    const saved = await call("/devices", alice, input); assert.equal(saved.status, 200); assert.equal(writes[0].id, alice);
    assert.equal((await call("/admin", alice)).status, 403); assert.equal((await call("/admin", bob)).status, 200);
    assert.equal((await call("/devices", alice, { device: writes[0].row._id, binding: input.binding }, "DELETE")).status, 200);
    assert.equal(writes[1].id, alice);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); User.findById = originalFind; if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; }
});
