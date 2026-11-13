"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { digest, orderUpdates } = require("../utils/orderUpdates");
const { deliverOrderEvents, sendWhatsApp, recordStatuses, validSignature, config } = require("../utils/whatsappOrderUpdates");

const now = Date.now();
const time = new Date(now - 5000);
const order = {
  _id: "507f1f77bcf86cd799439022", orderNumber: "GD-FIXTURE-1",
  status: "confirmed", items: [{ name: "Shirt" }, { name: "Bag" }],
  metadata: { demo: false },
  whatsappOrderUpdates: { consentedAt: new Date(now - 10000) },
  shippingAddress: { phone: "+91 9876543210" },
  tracking: { events: [{ status: "confirmed", timestamp: time }, { status: "confirmed", timestamp: time }] },
};
const split = { ...order, supplierShipments: [
  { key: "a", itemIndices: [0], publicFulfilmentName: "Fixture Outfitters", shippedAt: time, carrier: "Fixture Courier" },
  { key: "b", itemIndices: [1], publicFulfilmentName: "Fixture Bags", shippedAt: time },
] };

test("order projection supports legacy, one partner, split packages and duplicate tracking events", () => {
  assert.equal(orderUpdates(order).length, 1);
  assert.deepEqual(orderUpdates({ ...split, status: "payment-pending" }), []);
  const single = { ...split, supplierShipments: [{ ...split.supplierShipments[0], itemIndices: [0, 1] }] };
  assert.match(orderUpdates(single).find(row => row.kind === "confirmed").message, /Fixture Outfitters/);
  const updates = orderUpdates(split);
  assert.equal(updates.length, 3);
  assert.deepEqual(updates.filter(row => row.kind === "shipped").map(row => row.packageKey).sort(), ["a", "b"]);
  assert.equal(new Set(updates.map(row => row.id)).size, 3);
});

test("WhatsApp adapter submits a template, keeps unknown outcomes uncertain and validates webhook signature", async () => {
  const event = orderUpdates(order)[0];
  const settings = { version: "v25.0", phone: "1234567", template: "gymdrobe_order_update", token: "fixture" };
  const result = await sendWhatsApp(settings, { event, order, deliveryId: digest(event.id) }, async (url, input) => {
    assert.equal(url, "https://graph.facebook.com/v25.0/1234567/messages");
    const body = JSON.parse(input.body);
    assert.equal(body.to, "919876543210");
    assert.equal(body.template.name, settings.template);
    return Response.json({ messages: [{ id: "mock-message-id" }] });
  });
  assert.equal(result.state, "accepted");
  assert.equal((await sendWhatsApp(settings, { event, order }, async () => new Response(null, { status: 429 }))).state, "pending");
  assert.equal((await sendWhatsApp(settings, { event, order }, async () => { throw new Error("lost response"); })).state, "uncertain");
  const raw = Buffer.from("{}");
  const signature = "sha256=" + createHmac("sha256", "fixture").update(raw).digest("hex");
  assert.equal(validSignature(raw, signature, "fixture"), true);
  assert.equal(validSignature(Buffer.from("{ }"), signature, "fixture"), false);
  assert.equal(config({}), null);
});

function mockStore(rows, lastRead = row => row) {
  const state = new Map();
  const cursor = { async *[Symbol.asyncIterator]() { yield* rows; }, async close() {} };
  const chain = { sort: () => chain, select: () => chain, lean: () => chain, cursor: () => cursor };
  const orders = { find: () => chain, findOne: ({ _id }) => ({ select: () => ({ lean: async () => lastRead(rows.find(row => row._id === _id)) }) }) };
  const deliveries = {
    async updateMany() {},
    async updateOne(query, change) {
      const row = state.get(query._id);
      if (!row && change.$setOnInsert) state.set(query._id, { attempts: 0, ...change.$setOnInsert });
      if (row && change.$set && (query.state === row.state || query.state?.$in?.includes(row.state))) Object.assign(row, change.$set);
    },
    async findOneAndUpdate(query, change) {
      const row = state.get(query._id);
      if (row?.state !== query.state || +row.dueAt > +query.dueAt.$lte || row.attempts >= query.attempts.$lt) return null;
      Object.assign(row, change.$set);
      row.attempts += change.$inc.attempts;
      return { ...row };
    },
  };
  return { state, orders, deliveries };
}

test("durable claims deduplicate concurrent scans and repeated delivery webhooks", async () => {
  const { state, orders, deliveries } = mockStore([split]);
  let sent = 0;
  const run = () => deliverOrderEvents({ orders, deliveries, from: now - 60000, now, send: async () => {
    sent++;
    return { state: "accepted", providerId: "fixture-id", code: "PROVIDER_ACCEPTED" };
  } });
  await Promise.all([run(), run()]);
  await run();
  assert.equal(sent, 3);
  const [deliveryId] = state.keys();
  const statuses = status => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "fixture" },
    statuses: [{ id: "fixture-id", status, biz_opaque_callback_data: deliveryId }] } }] }] });
  await recordStatuses(statuses("delivered"), "fixture", deliveries);
  await recordStatuses(statuses("delivered"), "fixture", deliveries);
  await recordStatuses(statuses("sent"), "fixture", deliveries);
  assert.equal(state.get(deliveryId).state, "delivered");
});

test("opt-out is rechecked before sending and explicit rate-limit retries stop after four tries", async () => {
  const optedOut = mockStore([order], () => null);
  await deliverOrderEvents({ ...optedOut, from: now - 60000, now, send: () => assert.fail("opted-out order sent") });
  assert.equal([...optedOut.state.values()][0].state, "cancelled");
  const limited = mockStore([order]);
  let count = 0;
  for (let index = 0; index < 5; index++) {
    await deliverOrderEvents({ ...limited, from: now - 60000, now: now + index * 1000000,
      send: async () => { count++; return { state: "pending", code: "RATE_LIMIT" }; } });
  }
  assert.equal(count, 4);
  assert.equal([...limited.state.values()][0].state, "failed");
});
