"use strict";

// Synthetic cross-PR acceptance, using the project's published marketplace fixture terms and prices.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const express = require("express");
const uri = process.env.GYMDROBE_TEST_MONGO_URI || "";
assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/gymdrobe_fixture_combined\?replicaSet=rs0(?:&directConnection=true)?$/);
for (const key of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) assert.ok(!process.env[key]);
Object.assign(process.env, {
  MARKETPLACE_ENABLED: "true", MARKETPLACE_DATA_KEY: crypto.randomBytes(32).toString("hex"),
  JWT_SECRET: crypto.randomBytes(32).toString("hex"), AUTOMATION_ENGINE_ENABLED: "true",
  AUTOMATION_WORKER_ENABLED: "true", STANDARD_COD_ENABLED: "true", STANDARD_COD_PINCODES: "673001",
});
// This scenario supplies no credentials and loads no provider SDK. Any use fails the test.
let gatewayAttempts = 0;
const gatewayModule = require.resolve("razorpay");
require.cache[gatewayModule] = { id: gatewayModule, filename: gatewayModule, loaded: true,
  exports: class ForbiddenGateway { constructor() { gatewayAttempts++; throw new Error("Provider disabled in cross-PR fixture"); } } };
const S = require("../../utils/marketplace/service");
const fixture = require("../fixtures/marketplace-data.cjs");
const Order = require("../../models/Order"), User = require("../../models/User");
const Product = require("../../models/Product"), Supplier = require("../../models/Supplier");
const Job = require("../../models/AutomationJob"), engine = require("../../utils/automation/engine");
const proof = {};
let server, admin, origin;
const token = u => jwt.sign({ userId: String(u._id), authVersion: u.authVersion || 0 }, process.env.JWT_SECRET);
const userHeaders = u => ({ Authorization: "Bearer " + token(u) });
async function call(route, { method = "GET", headers = {}, body, expect = 200 } = {}) {
  const response = await fetch(origin + route, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  assert.equal(response.status, expect, JSON.stringify({ route, status: response.status, data }));
  return data;
}
async function supplier(label) {
  const made = await S.createAccount(admin, { email: label + "@example.test",
    business: fixture.business("Synthetic combined " + label), terms: fixture.terms });
  const activated = await S.activate(null, { code: made.invitationCode, name: "Fixture " + label,
    password: "Synthetic-Combined-Only-123", acceptTerms: true, termsDigest: made.account.termsDigest });
  const actor = await User.findById(activated.user.id);
  const account = await S.M.Account.findById(made.account.id);
  await S.setStatus(admin, made.account.id, { revision: account.__v, status: "active", reason: "Synthetic supplier approved inside the disposable fixture." });
  let row = (await S.saveDraft(actor, null, { draft: { ...fixture.draft, name: "Synthetic combined " + label + " training shirt" } })).listing;
  row = (await S.submit(actor, row.id, { revision: row.revision })).listing;
  row = (await S.review(admin, row.id, { revision: row.revision, decision: "published", prices: fixture.prices,
    reason: "Fixture pricing, publication and synthetic product reviewed." })).listing;
  return { actor, product: row.productId, account: String(account._id) };
}
async function run() {
  await mongoose.connect(uri, { dbName: "gymdrobe_fixture_combined_" + crypto.randomBytes(7).toString("hex"), serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Supplier, Product, Order, Job, ...Object.values(S.M)].map(model => model.createIndexes()));
  await Order.collection.createIndex({ "metadata.demo": 1, createdAt: 1 });
  await S.M.Quota.create({ _id: "global", bytes: 0 });
  admin = await User.create({ name: "Synthetic admin", email: "combined-admin@example.test", role: "admin", password: "Synthetic-Combined-Admin-123" });
  const sellers = [await supplier("alpha"), await supplier("beta")];
  const app = express();
  app.use(express.json());
  app.use("/api/payments", require("../../routes/paymentRoutes"));
  app.use("/api/orders", require("../../routes/orderRoutes"));
  app.use("/api/marketplace", require("../../routes/marketplaceRoutes").createMarketplaceRouter());
  app.use("/api/admin", require("../../routes/adminRoutes"));
  server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  origin = "http://127.0.0.1:" + server.address().port + "/api";
  const adminHeaders = userHeaders(admin);
  const guest = await call("/payments/guest-session", { method: "POST", body: {}, expect: 201 });
  const guestHeaders = { "X-GymDrobe-Guest": guest.guestToken };
  const checkout = { checkoutToken: crypto.randomUUID(), paymentMethod: "cod", deliveryMethod: "standard",
    items: sellers.map(s => ({ id: s.product, selectedSize: "M", selectedColor: "Black", quantity: 1 })),
    shippingAddress: fixture.shippingAddress, pincode: fixture.shippingAddress.pincode };
  const { quote } = await call("/payments/checkout/quote", { method: "POST", body: checkout });
  assert.equal(quote.payment.amountToPayNow, 0);
  checkout.expectedTotal = quote.pricing.finalTotal;
  const totalPaise = Math.round(checkout.expectedTotal * 100);
  const create = () => call("/payments/cod/order", { method: "POST", headers: guestHeaders, body: checkout });
  const { order } = await create();
  assert.equal(order.isGuestOrder, true);
  assert.equal(order.payment.amountDue, checkout.expectedTotal);
  assert.equal((await create()).order.id, order.id);
  const stored = await Order.findOne({ orderNumber: order.id }).lean();
  const orderId = String(stored._id);
  const filter = { order: stored._id };
  assert.equal(await Order.countDocuments({}), 1);
  assert.equal(await S.M.Entitlement.countDocuments(filter), 2);
  assert.equal(await S.M.Fulfilment.countDocuments(filter), 2);
  assert.equal(await Job.countDocuments(filter), 1);
  assert.equal((await Job.findOne(filter)).status, "queued");
  for (const s of sellers) assert.equal((await Product.findById(s.product)).variants.Black.M, 9);
  proof.checkout = { guest: true, ordersAfterReplay: 1, invoicePaise: totalPaise, upfrontPaise: 0,
    committedSupplierGroups: 2, committedEntitlements: 2, stockEachFrom: 10, stockEachTo: 9, queuedJobs: 1 };
  console.log("PASS guest checkout and transactional queue", JSON.stringify(proof.checkout));
  engine.startWorker();
  const deadline = Date.now() + 65000;
  let job;
  do {
    await new Promise(resolve => setTimeout(resolve, 250));
    job = await Job.findOne(filter).lean();
  } while (["queued", "running"].includes(job.status) && Date.now() < deadline);
  await engine.stopWorker();
  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.deepEqual(job.history.map(h => h.action), ["queued", "claimed", "completed"]);
  assert.equal(job.attempts, 1);
  const health = await call("/admin/automation", { headers: adminHeaders });
  assert.equal(health.counts.completed, 1);
  proof.worker = { status: job.status, attempts: job.attempts, history: job.history.map(h => h.action), trigger: "standard 30-second worker timer in fixture" };
  console.log("PASS unmodified timer worker", JSON.stringify(proof.worker));

  for (let i = 0; i < sellers.length; i++) {
    const seller = sellers[i], headers = userHeaders(seller.actor);
    const shipment = (await call("/marketplace/orders", { headers })).orders.find(g => g.orderId === orderId);
    assert.equal(shipment.items.length, 1);
    let revision = shipment.revision;
    for (const status of ["accepted", "preparing", "shipped", ...(i === 0 ? ["delivered"] : [])]) {
      const update = await call("/marketplace/shipments/" + shipment.id, { method: "PATCH",
        headers: status === "delivered" ? adminHeaders : headers, body: { revision, status,
          reason: "Synthetic local parcel status evidence.", ...(status === "shipped" ? { carrier: "Fixture carrier", trackingNumber: "TEST-" + i } : {}) } });
      revision = update.shipment.revision;
    }
  }
  const date = new Date(stored.createdAt.getTime() + 330 * 60000).toISOString().slice(0, 10);
  const reportPath = "/admin/reports/daily-operations?date=" + date;
  // New orders have metadata.demo=false in every environment. Here this source is an isolated random database.
  const reportBefore = (await call(reportPath, { headers: adminHeaders })).report;
  assert.equal(reportBefore.codOutstanding.knownPaise, totalPaise);
  assert.equal(reportBefore.grossCollections.knownPaise, 0);
  const receipt = { requestKey: crypto.randomUUID(), reference: "COMBINED-FIXTURE-CASH-001", amount: totalPaise,
    collectedAt: new Date(Date.now() - 1000).toISOString(), confirmExternalCollection: true,
    reason: "Synthetic evidence of full invoice cash collected outside GymDrobe." };
  const collectionPath = "/marketplace/admin/orders/" + orderId + "/collection";
  await call(collectionPath, { method: "POST", body: receipt, headers: adminHeaders });
  assert.equal((await call(collectionPath, { method: "POST", body: receipt, headers: adminHeaders })).replayed, true);
  assert.equal(await S.M.Collection.countDocuments(filter), 1);
  const { review } = await call("/marketplace/admin/orders/" + orderId + "/settlement-review", { headers: adminHeaders });
  assert.deepEqual(review.exceptions, []);
  assert.equal(review.lines.length, 2);
  for (const line of review.lines) {
    assert.equal(line.purchasedPayablePaise, 50000);
    assert.equal(line.calculated.pendingPaise, 50000);
    assert.equal(line.calculated.eligiblePaise, 0);
  }
  assert.match(review.lines.find(line => line.supplierId === sellers[0].account).calculated.reason, /return window|hold/i);
  assert.match(review.lines.find(line => line.supplierId === sellers[1].account).calculated.reason, /delivery/i);
  const { preview } = await call("/marketplace/admin/remittances/preview", { method: "POST", headers: adminHeaders,
    body: { currency: "INR", rows: [{ reference: receipt.reference, remittedPaise: totalPaise - 1000, feePaise: 1000 }] } });
  assert.equal(preview.counts.matched, 1);
  assert.equal(preview.lines[0].differencePaise, 0);
  proof.finance = { receiptCountAfterReplay: 1, recordedGrossPaise: totalPaise, statementMatches: 1,
    settlementExceptions: review.exceptions, lines: review.lines.map((line, i) => ({ parcel: i === 0 ? "delivered" : "shipped",
      pendingPaise: line.calculated.pendingPaise, eligiblePaise: line.calculated.eligiblePaise, reason: line.calculated.reason })) };
  const { report } = await call(reportPath, { headers: adminHeaders });
  assert.equal(report.orders.all, 1);
  assert.equal(report.confirmedOrderValue.knownPaise, totalPaise);
  assert.equal(report.grossCollections.knownPaise, totalPaise);
  assert.equal(report.codRecordedCollections.knownPaise, totalPaise);
  assert.equal(report.codOutstanding.knownPaise, 0);
  assert.equal(report.refunds.knownPaise, 0);
  assert.equal(report.fulfilments.delivered, 1);
  assert.equal(report.fulfilments.shipped, 1);
  assert.equal(report.netProfitPaise, null);
  assert.equal((await call(reportPath + "&source=test", { headers: adminHeaders })).report.orders.all, 0);
  assert.equal(await S.M.Payout.countDocuments({}), 0);
  assert.equal(gatewayAttempts, 0);
  proof.daily = { orders: report.orders.all, invoicePaise: totalPaise, grossPaise: report.grossCollections.knownPaise,
    codOutstandingPaise: report.codOutstanding.knownPaise, refundsPaise: report.refunds.knownPaise, netProfitPaise: report.netProfitPaise,
    delivered: report.fulfilments.delivered, shipped: report.fulfilments.shipped };
  // The customer returns the first supplier's delivered item, retaining the other line.
  const orderPath = "/orders/" + order.id;
  const purchased = (await call(orderPath, { headers: guestHeaders })).order;
  const firstItem = purchased.items.find(i => i.productId === sellers[0].product);
  assert.equal(firstItem.returnsEligible, "yes");
  assert.ok(firstItem.returnRequestTypes.includes("return"));
  const deliveredParcel = purchased.supplierShipments.find(g => g.status === "delivered");
  assert.ok(Date.now() - Date.parse(deliveredParcel.deliveredAt) < firstItem.returnWindowDays * 86400000);

  const earningPaths = [];
  for (const seller of sellers) {
    const results = await call("/marketplace/earnings/reconcile", { method: "POST", headers: userHeaders(seller.actor), body: {} });
    const earning = results.earnings.find(e => e.orderId === orderId);
    earningPaths.push("/marketplace/admin/earnings/" + earning.id + "/resolutions");
  }
  const inspectedReturn = { requestKey: crypto.randomUUID(), kind: "return", quantity: 1, restockQuantity: 1,
    reason: "Synthetic eligible unworn item physically received and inspected in resalable condition." };
  await call(earningPaths[0], { method: "POST", headers: userHeaders(sellers[0].actor), body: inspectedReturn, expect: 403 });
  const blockedReturn = await call(earningPaths[1], { method: "POST", headers: adminHeaders, body: inspectedReturn, expect: 409 });
  assert.match(blockedReturn.message, /delivery/i);
  const acceptReturn = () => call(earningPaths[0], { method: "POST", headers: adminHeaders, body: inspectedReturn });
  const returned = (await acceptReturn()).resolution;
  assert.equal(returned.kind, "return");
  assert.equal(returned.status, "refund-pending");
  assert.equal(returned.customerRefundPaise, 55000);
  assert.equal(returned.supplierReversalPaise, 50000);
  assert.equal((await acceptReturn()).replayed, true);
  assert.equal((await call(orderPath, { headers: guestHeaders })).order.payment.refundedAmount, 0);
  const externalRefund = { revision: returned.revision, reference: "COMBINED-FIXTURE-REFUND-001",
    refundedAt: new Date().toISOString(), confirmExternalRefund: true };
  const recordRefund = () => call("/marketplace/admin/resolutions/" + returned.id + "/refund", {
    method: "POST", headers: adminHeaders, body: externalRefund });
  assert.equal((await recordRefund()).resolution.status, "refunded");
  assert.equal((await recordRefund()).replayed, true);

  const finalOrder = (await call(orderPath, { headers: guestHeaders })).order;
  assert.equal(finalOrder.marketplaceResolutions.length, 1);
  assert.equal(finalOrder.marketplaceResolutions[0].kind, "return");
  assert.equal(finalOrder.payment.status, "partially-refunded");
  assert.equal(finalOrder.payment.grossCollected, 1100);
  assert.equal(finalOrder.payment.refundedAmount, 550);
  assert.equal(finalOrder.payment.amountPaid, 550);
  assert.equal(finalOrder.payment.amountDue, 0);
  const stocks = await Promise.all(sellers.map(async seller => (await Product.findById(seller.product)).variants.Black.M));
  assert.deepEqual(stocks, [10, 9]);
  const finalFinance = (await call("/marketplace/admin/orders/" + orderId + "/settlement-review", { headers: adminHeaders })).review;
  assert.deepEqual(finalFinance.exceptions, []);
  const returnedLine = finalFinance.lines.find(line => line.supplierId === sellers[0].account);
  assert.equal(returnedLine.calculated.reversedPaise, 50000);
  assert.equal(returnedLine.calculated.pendingPaise, 0);
  assert.equal(returnedLine.calculated.eligiblePaise, 0);
  const beforeOther = review.lines.find(line => line.supplierId === sellers[1].account);
  const afterOther = finalFinance.lines.find(line => line.supplierId === sellers[1].account);
  assert.deepEqual(afterOther, beforeOther);
  const finalReport = (await call(reportPath, { headers: adminHeaders })).report;
  assert.equal(finalReport.orders.all, 1);
  assert.equal(finalReport.grossCollections.knownPaise, 110000);
  assert.equal(finalReport.codOutstanding.knownPaise, 0);
  assert.equal(finalReport.refunds.knownPaise, 55000);
  assert.equal(finalReport.fulfilments.shipped, 1);
  assert.equal(await S.M.Resolution.countDocuments(filter), 1);
  assert.equal(await S.M.Collection.countDocuments(filter), 1);
  assert.equal(await S.M.Payout.countDocuments({}), 0);
  assert.equal(gatewayAttempts, 0);
  proof.partialReturn = { orderedUnits: 2, returnedUnits: 1, resolutionsAfterReplay: 1,
    grossPaise: 110000, recordedRefundPaise: 55000, retainedPaise: 55000, duePaise: 0, stocks,
    returnedSupplierReversalPaise: 50000, otherSupplierPendingPaise: afterOther.recorded.pendingPaise,
    otherSupplierChanged: false, reportParcelCounts: finalReport.fulfilments, recordedRefunds: 1 };
  assert.equal(finalReport.fulfilments.cancelled, 0);
  assert.equal(finalReport.fulfilments.delivered, 1);
  assert.equal(finalReport.netProfitPaise, null);
  const finalDelivered = finalOrder.supplierShipments.find(g => g.key === deliveredParcel.key);
  assert.equal(finalDelivered.status, "delivered");
  assert.equal(finalDelivered.deliveredAt, deliveredParcel.deliveredAt);
  const unchangedShipment = await S.M.Fulfilment.findOne({ ...filter, supplier: sellers[0].account }).lean();
  assert.deepEqual(unchangedShipment.history.map(h => h.status), ["accepted", "preparing", "shipped", "delivered"]);
  proof.partialReturn.deliveryEvidencePreserved = true;
  proof.partialReturn.netProfitPaise = finalReport.netProfitPaise;

  // A separate unpaid guest basket verifies that real pre-dispatch cancellations still close only the correct parcel.
  const cancellationBody = { ...checkout, checkoutToken: crypto.randomUUID(), items: checkout.items.map((item, i) =>
    ({ ...item, quantity: i === 0 ? 2 : 1 })) };
  cancellationBody.expectedTotal = (await call("/payments/checkout/quote", { method: "POST", body: cancellationBody })).quote.pricing.finalTotal;
  const cancelledOrder = (await call("/payments/cod/order", { method: "POST", headers: guestHeaders, body: cancellationBody })).order;
  const cancelId = (await Order.findOne({ orderNumber: cancelledOrder.id }))._id;
  const earning = await S.M.Entitlement.findOne({ order: cancelId, supplier: sellers[0].account });
  const cancelPath = "/marketplace/admin/earnings/" + earning._id + "/resolutions";
  for (const step of [1, 2]) {
    const cancellation = { kind: "cancellation", requestKey: crypto.randomUUID(), quantity: 1, restockQuantity: 1,
      reason: "Synthetic pre-dispatch cancellation with verified physical restock." };
    const result = await call(cancelPath, { method: "POST", headers: adminHeaders, body: cancellation });
    assert.equal(result.resolution.customerRefundPaise, 0);
    assert.equal((await call(cancelPath, { method: "POST", headers: adminHeaders, body: cancellation })).replayed, true);
    const group = await S.M.Fulfilment.findOne({ order: cancelId, supplier: sellers[0].account }).lean();
    assert.equal(group.status, step === 1 ? "pending" : "cancelled");
    assert.equal(group.history.filter(h => h.status === "cancelled").length, step === 1 ? 0 : 1);
    const other = await S.M.Fulfilment.findOne({ order: cancelId, supplier: sellers[1].account });
    assert.equal(other.status, "pending");
  }
  assert.equal(gatewayAttempts, 0);
  proof.independentPredispatchCancellation = { partial: "pending", full: "cancelled", unaffectedSupplier: "pending", refundPaise: 0 };
  proof.gatewayAttempts = gatewayAttempts;
  proof.payouts = 0;
  console.log("PASS combined settlement, remittance preview and daily report", JSON.stringify(proof));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await engine.stopWorker();
  if (server) await new Promise(resolve => server.close(resolve));
  if (mongoose.connection.readyState === 1 && /^gymdrobe_fixture_combined_[a-f0-9]{14}$/.test(mongoose.connection.name)) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
