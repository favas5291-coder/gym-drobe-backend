"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Product = require("../../models/Product");
const Order = require("../../models/Order");
const { M } = require("../../utils/marketplace/service");
const { earnings, supplierOrders, updateFulfilment } = require("../../utils/marketplace/settlement");
const { recordCollection, create: resolveItem } = require("../../utils/marketplace/resolution");

module.exports = async function standardCodAcceptance({ base, admin, alice, bob, aid, bid, publish, token, gateway, fixture }) {
  const previous = { enabled: process.env.STANDARD_COD_ENABLED, pincodes: process.env.STANDARD_COD_PINCODES };
  const customer = { Authorization: "Bearer " + token(alice) };
  const api = base.replace("/marketplace", "");
  const post = async (route, body, headers = customer) => {
    const response = await fetch(api + "/payments" + route, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const success = result => {
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.data;
  };
  try {
    process.env.STANDARD_COD_ENABLED = "true";
    process.env.STANDARD_COD_PINCODES = fixture.shippingAddress.pincode;
    const listings = [
      await publish(alice, "Synthetic COD supplier A"),
      await publish(bob, "Synthetic COD supplier B"),
    ];
    const stock = async () => Promise.all(listings.map(async listing =>
      (await Product.findById(listing.productId)).variants.Black.M));
    const initialStock = await stock();
    const providerOrders = gateway.orders.size;
    const body = {
      checkoutToken: crypto.randomUUID(), paymentMethod: "cod", deliveryMethod: "standard",
      pincode: fixture.shippingAddress.pincode, shippingAddress: fixture.shippingAddress,
      items: listings.map(row => ({ id: row.productId, quantity: 1, selectedSize: "M", selectedColor: "Black" })),
    };
    const refused = await post("/checkout/quote", { ...body, pincode: "700001" });
    assert.equal(refused.data.code, "COD_PINCODE_UNAVAILABLE");
    const { quote } = success(await post("/checkout/quote", body));
    body.expectedTotal = quote.pricing.finalTotal;
    assert.equal(quote.payment.amountToPayNow, 0);
    assert.equal(quote.payment.amountDue, body.expectedTotal);
    assert.equal(quote.payment.advancePercentage, 0);
    assert.equal((await post("/cod/order", body, {})).status, 401);
    assert.equal((await post("/cod/order", { ...body, expectedTotal: 1 })).data.code, "CHECKOUT_TOTAL_CHANGED");
    assert.equal((await post("/cod/order", { ...body,
      shippingAddress: { ...body.shippingAddress, pincode: "700001" } })).data.code, "COD_PINCODE_UNAVAILABLE");
    assert.equal(await Order.countDocuments({ checkoutToken: body.checkoutToken }), 0);
    assert.deepEqual(await stock(), initialStock);

    const [first, retry] = await Promise.all([post("/cod/order", body), post("/cod/order", body)]);
    const { order } = success(first);
    assert.equal(success(retry).order.id, order.id);
    assert.equal(order.status, "confirmed");
    assert.equal(order.payment.method, "cod");
    assert.equal(order.payment.status, "pending");
    assert.equal(order.payment.grossCollected, 0);
    assert.equal(order.payment.amountPaid, 0);
    assert.equal(order.payment.amountDue, body.expectedTotal);
    assert.equal(order.metadata.inventoryReserved, true);
    assert.deepEqual(await stock(), initialStock.map(value => value - 1));
    assert.equal((await post("/cod/order", { ...body, orderNote: "Changed instructions" })).data.code, "CHECKOUT_CHANGED");
    const stored = await Order.findOne({ orderNumber: order.id });
    const filter = { order: stored._id };
    assert.equal(await M.Entitlement.countDocuments(filter), 2);
    assert.equal(await M.Fulfilment.countDocuments(filter), 2);
    const collection = { requestKey: crypto.randomUUID(), amount: Math.round(body.expectedTotal * 100),
      reference: "TEST-STANDARD-COD", collectedAt: new Date(Date.now() - 1000).toISOString(),
      reason: "Synthetic full cash receipt for both parcels.", confirmExternalCollection: true };
    await assert.rejects(recordCollection(admin, String(stored._id), collection), { code: "MARKETPLACE_COD_DISPATCH_REQUIRED" });
    for (const [supplier, accountId] of [[alice, aid], [bob, bid]]) {
      const own = (await supplierOrders(supplier)).orders.find(row => row.orderNumber === order.id);
      const internal = (await supplierOrders(admin, accountId)).orders.find(row => row.orderNumber === order.id);
      assert.equal(own.items.length, 1);
      assert.ok(own.shippingAddress.fullName);
      assert.equal(internal.standardCod, true);
      assert.equal(internal.balanceDuePaise, Math.round(body.expectedTotal * 100));
      assert.equal(Object.hasOwn(own, "balanceDuePaise"), false);
      let revision = own.revision;
      for (const status of ["accepted", "preparing", "shipped"]) {
        const { shipment } = await updateFulfilment(supplier, own.id, { status, revision,
          ...(status === "shipped" ? { carrier: "Fixture courier", trackingNumber: "TEST-" + own.id } : {}) });
        revision = shipment.revision;
      }
      const earned = (await earnings(supplier)).earnings.find(row => row.orderId === String(stored._id));
      assert.equal(earned.pendingAmount, 50000);
      assert.equal(earned.eligibleAmount, 0);
    }
    await recordCollection(admin, String(stored._id), collection);
    assert.equal((await recordCollection(admin, String(stored._id), collection)).replayed, true);
    assert.equal((await Order.findById(stored._id)).payment.amountDue, 0);
    assert.equal((await Order.findById(stored._id)).payment.grossCollected, body.expectedTotal);

    const session = await post("/guest-session", {}, {});
    assert.equal(session.status, 201);
    const guest = { "X-GymDrobe-Guest": session.data.guestToken };
    const guestBody = { ...body, checkoutToken: crypto.randomUUID() };
    const guestOrder = success(await post("/cod/order", guestBody, guest)).order;
    assert.equal(guestOrder.isGuestOrder, true);
    assert.equal((await fetch(api + "/orders/" + guestOrder.id, { headers: customer })).status, 404);
    assert.equal((await fetch(api + "/orders/" + guestOrder.id, { headers: guest })).status, 200);
    const guestStored = await Order.findOne({ orderNumber: guestOrder.id });
    const guestItem = await M.Entitlement.findOne({ order: guestStored._id, supplier: aid });
    const { resolution } = await resolveItem(admin, String(guestItem._id), {
      requestKey: crypto.randomUUID(), kind: "cancellation", quantity: 1, restockQuantity: 1,
      reason: "Cancel one unpaid item before dispatch and restore its reserved unit.",
    });
    assert.equal(resolution.customerRefundPaise, 0);
    assert.equal((await Order.findById(guestStored._id)).payment.amountDue, body.expectedTotal - 550);

    const ordinary = await Product.create({
      name: "Fixture ordinary cash sale", slug: "fixture-ordinary-cash-sale", sku: "FIXTURE-ORDINARY-CASH",
      category: fixture.draft.category, brand: fixture.draft.brand, price: 100,
      image: fixture.draft.images[0], images: fixture.draft.images, sizes: ["M"], colors: ["Black"],
      variants: { Black: { M: 1 } }, stock: 1,
    });
    const lastUnit = { ...body, items: [{ ...body.items[0], id: String(ordinary._id) }] };
    lastUnit.expectedTotal = success(await post("/checkout/quote", lastUnit)).quote.pricing.finalTotal;
    const starts = await Promise.all([1, 2].map(() => post("/cod/order", { ...lastUnit, checkoutToken: crypto.randomUUID() })));
    assert.deepEqual(starts.map(row => row.status).sort(), [200, 409]);
    assert.equal((await Product.findById(ordinary._id)).variants.Black.M, 0);
    const ordinaryId = starts.find(row => row.status === 200).data.order.id;
    const update = async data => {
      const response = await fetch(api + "/orders/admin/orders/" + ordinaryId + "/status", {
        method: "PUT", headers: { Authorization: "Bearer " + token(admin), "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return { status: response.status, data: await response.json() };
    };
    for (const status of ["processing", "shipped", "out-for-delivery"]) {
      success(await update({ status, packingConfirmed: status === "processing", carrier: "Fixture courier", trackingNumber: "TEST-ORDINARY-CASH" }));
    }
    assert.equal((await update({ status: "delivered" })).data.code, "COD_COLLECTION_REQUIRED");
    const collected = success(await update({ status: "delivered", codBalanceCollected: true })).order;
    assert.equal(collected.payment.amountDue, 0);
    assert.equal(collected.payment.amountPaid, lastUnit.expectedTotal);
    assert.equal(gateway.orders.size, providerOrders);
    delete process.env.STANDARD_COD_ENABLED;
    assert.equal((await post("/cod/order", { ...body, checkoutToken: crypto.randomUUID() })).data.code, "COD_DISABLED");
    assert.equal(success(await post("/cod/order", guestBody, guest)).order.id, guestOrder.id);
  } finally {
    for (const [key, value] of [["STANDARD_COD_ENABLED", previous.enabled], ["STANDARD_COD_PINCODES", previous.pincodes]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
