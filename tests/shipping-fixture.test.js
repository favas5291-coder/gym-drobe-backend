"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixtureConfiguration, bookingSnapshot } = require("../utils/marketplace/shippingFixture");
const data = require("./fixtures/marketplace-data.cjs");
const env = { NODE_ENV: "test", GYMDROBE_SHIPMENT_PROVIDER: "fixture", GYMDROBE_SHIPMENT_FIXTURE_URI: "mongodb://127.0.0.1:27017/gymdrobe_fixture_shipping_a?directConnection=true" };

test("shipping fixture rejects production, unsupported adapters and non-isolated database configuration", () => {
  assert.equal(fixtureConfiguration(env).database, "gymdrobe_fixture_shipping_a");
  for (const patch of [{NODE_ENV:"production"}, {GYMDROBE_SHIPMENT_PROVIDER:"carrier"}, {GYMDROBE_SHIPMENT_PROVIDER:""},
    ...["mongodb+srv://host/gymdrobe_fixture_shipping_a","mongodb://127.0.0.1:27017/gymdrobe?directConnection=true",
      env.GYMDROBE_SHIPMENT_FIXTURE_URI+"&replicaSet=rs0",env.GYMDROBE_SHIPMENT_FIXTURE_URI.replace("127.0.0.1","example.test")]
      .map(uri => ({ GYMDROBE_SHIPMENT_FIXTURE_URI:uri }))]) {
    assert.throws(() => fixtureConfiguration({...env, ...patch}));
  }
});

test("shipping requires supplier-owned unresolved items, paid order, contactable pickup and delivery addresses", () => {
  const group = { supplier:"fixture-a", status:"preparing", itemIndices:[0] };
  const order = { status:"processing", payment:{status:"paid"}, items:[{quantity:1, marketplace:{accountId:"fixture-a"}}], shippingAddress:data.shippingAddress };
  const account = { status:"active", business:data.business("Fixture pickup") };
  const snapshot = bookingSnapshot(group, order, account);
  assert.match(snapshot, /^[a-f0-9]{64}$/);
  assert.throws(() => bookingSnapshot({...group, itemIndices:[0,0]}, order, account));
  assert.throws(() => bookingSnapshot({...group, supplier:"other"}, order, account));
  assert.throws(() => bookingSnapshot({...group, status:"delivered"}, order, account));
  assert.throws(() => bookingSnapshot(group, {...order, payment:{status:"pending"}}, account));
  assert.throws(() => bookingSnapshot(group, {...order, marketplaceResolutions:[{itemIndex:0}]}, account));
  assert.throws(() => bookingSnapshot(group, {...order, shippingAddress:{...data.shippingAddress,pincode:"000000"}}, account));
  assert.throws(() => bookingSnapshot(group, order, {...account,business:{...account.business,pickupAddress:undefined}}));
  assert.notEqual(bookingSnapshot(group, {...order, shippingAddress:{...data.shippingAddress,phone:"9999999999"}}, account), snapshot);
});
