"use strict";
// Dedicated native MongoDB fixture. The only adapter reachable from here uses local collections.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { MongoClient, ObjectId } = require("mongoose").mongo;
const { Account, Fulfilment } = require("../../models/Marketplace");
const Order = require("../../models/Order");
const { bookingSnapshot, fixtureConfiguration, openShippingFixture } = require("../../utils/marketplace/shippingFixture");
const data = require("../fixtures/marketplace-data.cjs");

async function run() {
  const config = fixtureConfiguration(process.env);
  // Each run owns a unique database even when concurrent jobs use the same local server.
  const name = "gymdrobe_fixture_shipping_" + randomUUID().replaceAll("-", "");
  const uri = config.uri.replace("/"+config.database+"?", "/"+name+"?");
  const env = { ...process.env, GYMDROBE_SHIPMENT_FIXTURE_URI: uri };
  const client = await MongoClient.connect(uri);
  const db = client.db(name);
  let fixture;
  try {
    const groups = db.collection(Fulfilment.collection.name);
    const accounts = db.collection(Account.collection.name);
    const order = { _id:new ObjectId(), status:"processing", payment:{status:"paid"}, items:[], shippingAddress:data.shippingAddress };
    const fixtures = [];
    for (let index = 0; index < 3; index++) {
      const supplier = new ObjectId();
      const group = { _id:new ObjectId(), order:order._id, supplier, itemIndices:[index], status:"preparing" };
      await accounts.insertOne({ _id:supplier, status:"active", business:data.business("Fixture supplier "+index) });
      await groups.insertOne(group);
      order.items.push({ quantity:1, marketplace:{accountId:String(supplier)} });
      fixtures.push(group);
    }
    await db.collection(Order.collection.name).insertOne(order);
    const [a,b,c] = fixtures.map(row => String(row._id));
    fixture = await openShippingFixture(env);
    const uncertain = await fixture.book(a, {loseResponse:true});
    assert.equal(uncertain.state, "uncertain");
    await fixture.close();
    fixture = await openShippingFixture(env);
    const first = await fixture.book(a, {recover:true});
    assert.equal(first.state, "booked");
    assert.equal((await fixture.book(a)).reference, first.reference);
    const races = await Promise.all(Array.from({length:8}, () => fixture.book(b)));
    const second = await fixture.book(b, {recover:true});
    assert.ok(races.every(row => !row.reference || row.reference === second.reference));
    assert.notEqual(second.reference, first.reference);
    assert.equal(await db.collection("fixture_shipping_receipts").countDocuments(), 2);
    assert.equal(await db.collection("fixture_shipping_intents").countDocuments(), 2);
    const timestamp = new Date().toISOString();
    assert.equal((await fixture.track(a, first.reference, "in-transit", timestamp)).stage, "in-transit");
    const terminal = await fixture.track(a, first.reference, "delivered", timestamp);
    assert.equal(terminal.history.length, 2);
    assert.deepEqual(await fixture.track(a, first.reference, "collected", timestamp), terminal);
    assert.deepEqual(await fixture.track(a, first.reference, "delivered", timestamp), terminal);
    assert.deepEqual(await fixture.track(b, second.reference, "delivered", "1970-01-01T00:00:00.000Z"), second);
    await assert.rejects(fixture.track(b, first.reference, "delivered", timestamp), /reference/);
    await assert.rejects(fixture.track(b, second.reference, "unknown", timestamp), /stage/);
    const syntheticKeys = await db.collection("fixture_shipping_intents").find().toArray();
    for (const original of [data.shippingAddress.phone, data.shippingAddress.addressLine, data.shippingAddress.fullName]) {
      assert.ok(!JSON.stringify(syntheticKeys).includes(original));
    }
    // Simulate a crash after durable preparation and before provider acceptance.
    const group = fixtures[2];
    const snapshot = bookingSnapshot(group, order, await accounts.findOne({_id:group.supplier}));
    await db.collection("fixture_shipping_intents").insertOne({ _id:"fixture:v1:"+order._id+":"+group.supplier, fulfilment:group._id, state:"submitting", snapshot });
    await accounts.updateOne({_id:group.supplier}, {$set:{"business.phone":"0123456789"}});
    await assert.rejects(fixture.book(c, {recover:true}), /changed/);
    assert.equal(await db.collection("fixture_shipping_receipts").countDocuments(), 2);
    await accounts.updateOne({_id:group.supplier}, {$set:{"business.phone":data.business("test").phone}});
    assert.equal((await fixture.book(c, {recover:true})).state, "booked");
    assert.equal(await db.collection("fixture_shipping_receipts").countDocuments(), 3);
    assert.equal(await groups.countDocuments({status:"preparing"}), 3);
    assert.equal((await db.collection(Order.collection.name).findOne({_id:order._id})).status, "processing");
    console.log("PASS synthetic booking, split suppliers, eight concurrent submissions, lost reply, restart, changed details, tracking order and isolation");
  } finally {
    if (fixture) await fixture.close();
    await db.dropDatabase();
    await client.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
