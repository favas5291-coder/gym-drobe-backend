"use strict";

const { MongoClient, ObjectId } = require("mongoose").mongo;
const D = require("./domain");
const { Account, Fulfilment } = require("../../models/Marketplace");
const Order = require("../../models/Order");
const stages = ["booked", "collected", "in-transit", "delivered"];

function fixtureConfiguration(env) {
  if (env.NODE_ENV !== "test" || env.GYMDROBE_SHIPMENT_PROVIDER !== "fixture") {
    throw new Error("Set NODE_ENV=test and GYMDROBE_SHIPMENT_PROVIDER=fixture to use the synthetic carrier.");
  }
  const uri = env.GYMDROBE_SHIPMENT_FIXTURE_URI || "";
  const match = /^mongodb:\/\/127\.0\.0\.1:(\d{1,5})\/(gymdrobe_fixture_shipping_[a-z0-9_]{1,40})\?directConnection=true$/.exec(uri);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error("A direct loopback connection to a named shipping fixture database is required.");
  }
  return { uri, database: match[2] };
}

function contactAddress(address, name, phone, label) {
  if (!address || !/^\+?\d{7,15}$/.test(phone || "")) throw new Error("Check " + label + " contact details.");
  return {
    ...D.address(Object.fromEntries(["addressLine", "city", "state", "pincode", "country"].map(key => [key, address[key]])), label),
    contact: D.text(name, label + " contact", 150, 2),
    phone
  };
}

function bookingSnapshot(group, order, account) {
  if (!order || !account || group.status !== "preparing" || group.carrier || group.trackingNumber ||
      !["confirmed", "processing"].includes(order.status) || !["paid", "partially-paid", "partially-refunded"].includes(order.payment?.status) ||
      account.status !== "active") throw new Error("The supplier shipment is not ready to book.");
  const indices = group.itemIndices;
  const supplier = String(group.supplier);
  const purchased = (order.items || []).flatMap((item, index) => String(item.marketplace?.accountId) === supplier ? [index] : []);
  if (!Array.isArray(indices) || !indices.length || D.digest([...indices].sort((a,b) => a-b)) !== D.digest(purchased) ||
      (order.marketplaceResolutions || []).some(row => indices.includes(row.itemIndex))) {
    throw new Error("Reconcile the supplier's purchased items before booking.");
  }
  const dest = order.shippingAddress;
  const business = account.business || {};
  const pickup = contactAddress(business.pickupAddress, business.contactName, business.phone, "pickup");
  const destination = contactAddress(dest, dest?.fullName || dest?.name, dest?.phone, "destination");
  const items = purchased.map(i => ({ index: i, quantity: D.integer(order.items[i].quantity, "quantity", 1) }));
  return D.digest({ pickup, destination, items });
}

// Both provider operations persist only synthetic references in a separate collection.
// The immutable command key is also the provider's unique idempotency key.
function fixtureCarrier(receipts) {
  return {
    async book(key, loseResponse) {
      const reference = "FIX-" + D.digest(key).slice(0, 24).toUpperCase();
      await insertOnce(receipts, { _id: key, reference, createdAt: new Date() });
      if (loseResponse) throw Object.assign(new Error("Fixture reply lost."), { code: "UNCERTAIN" });
      return receipts.findOne({ _id: key });
    },
    async lookup(key) {
      return receipts.findOne({ _id: key });
    }
  };
}

async function insertOnce(collection, row) {
  try { await collection.insertOne(row); }
  catch (error) { if (error.code !== 11000) throw error; }
}

async function openShippingFixture(env = process.env) {
  const { uri, database } = fixtureConfiguration(env);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try { await client.connect(); } catch (error) { await client.close(); throw error; }
  const db = client.db(database);
  const intents = db.collection("fixture_shipping_intents");
  const carrier = fixtureCarrier(db.collection("fixture_shipping_receipts"));
  async function groupFor(id) {
    const row = await db.collection(Fulfilment.collection.name).findOne({ _id: new ObjectId(D.id(id)) });
    if (!row) throw new Error("Fixture supplier fulfilment was not found.");
    return row;
  }
  function intentKey(group) { return "fixture:v1:" + group.order + ":" + group.supplier; }
  async function currentSnapshot(group) {
    const [order, account] = await Promise.all([
      db.collection(Order.collection.name).findOne({ _id: group.order }, { projection: { items: 1, marketplaceResolutions: 1, status: 1, "payment.status": 1, shippingAddress: 1 } }),
      db.collection(Account.collection.name).findOne({ _id: group.supplier }, { projection: { status: 1, "business.pickupAddress": 1, "business.contactName": 1, "business.phone": 1 } })
    ]);
    return bookingSnapshot(group, order, account);
  }
  function read(key) { return intents.findOne({ _id: key }, { projection: { snapshot: 0 } }); }
  async function confirm(key, receipt) {
    await intents.updateOne({ _id: key, state: { $ne: "booked" } }, {
      $set: { state: "booked", reference: receipt.reference, rank: 0, stage: stages[0], stageAt: receipt.createdAt }
    });
    return read(key);
  }
  async function book(id, { loseResponse = false, recover = false } = {}) {
    const group = await groupFor(id);
    const key = intentKey(group);
    let row = await intents.findOne({ _id: key });
    if (row && !row.fulfilment.equals(group._id)) throw new Error("Conflicting supplier fulfilment records require review.");
    if (row?.state === "booked") return read(key);
    if (row) {
      const receipt = await carrier.lookup(key);
      if (receipt) return confirm(key, receipt);
      if (!recover) return read(key);
    } else if (recover) {
      throw new Error("No prior booking intent to recover.");
    }
    const snapshot = await currentSnapshot(group);
    if (!row) {
      await insertOnce(intents, { _id: key, fulfilment: group._id, state: "submitting", snapshot, createdAt: new Date() });
      row = await intents.findOne({ _id: key });
    }
    if (row.snapshot !== snapshot || !row.fulfilment.equals(group._id)) {
      throw new Error("The purchased items or shipping details changed. Review the booking.");
    }
    try { return await confirm(key, await carrier.book(key, loseResponse)); }
    catch (error) {
      if (error.code !== "UNCERTAIN") throw error;
      await intents.updateOne({ _id: key, state: "submitting" }, { $set: { state: "uncertain" } });
      return read(key);
    }
  }
  async function track(id, reference, stage, at) {
    const key = intentKey(await groupFor(id));
    const rank = stages.indexOf(stage);
    const time = new Date(at);
    if (rank < 1 || typeof at !== "string" || !Number.isFinite(+time) || time.toISOString() !== at || +time > Date.now()) {
      throw new Error("Provide a valid tracking stage and recorded UTC timestamp.");
    }
    const row = await read(key);
    if (row?.state !== "booked" || row.reference !== reference) throw new Error("The tracking reference did not match this booking.");
    await intents.updateOne({ _id: key, state: "booked", reference, rank: { $lt: rank }, stageAt: { $lte: time } }, {
      $set: { stage, rank, stageAt: time }, $push: { history: { stage, at: time } }
    });
    return read(key);
  }
  return { book, track, inspect: async id => read(intentKey(await groupFor(id))), close: () => client.close() };
}

module.exports = { fixtureConfiguration, bookingSnapshot, openShippingFixture };
