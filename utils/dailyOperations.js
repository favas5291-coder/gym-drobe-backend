"use strict";

const IST = 330 * 60000;
const DAY = 86400000;
const APPROVED = new Set(["confirmed", "processing", "shipped", "out-for-delivery", "delivered"]);
const PARCEL_STATES = ["pending", "accepted", "preparing", "shipped", "delivered", "cancelled", "unknown"];
const MAX_ORDERS = 5000;

function reportWindow(date, source = "real", now = new Date()) {
  const today = new Date(now.getTime() + IST).toISOString().slice(0, 10);
  if (date === undefined) date = today;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !["real", "test"].includes(source)) {
    throw new RangeError("Use a calendar date YYYY-MM-DD and source real or test.");
  }
  const midnight = new Date(date + "T00:00:00.000Z");
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date || date > today) {
    throw new RangeError("Choose a valid date up to today in India.");
  }
  const start = new Date(midnight.getTime() - IST);
  const end = new Date(start.getTime() + DAY);
  return { date, source, start, end };
}

function metric() {
  return { knownPaise: 0, knownOrders: 0, unknownOrders: 0 };
}

function addAmount(target, rupees) {
  if (typeof rupees !== "number" || !Number.isFinite(rupees) || rupees < 0) {
    target.unknownOrders++;
    return;
  }
  const paise = Math.round(rupees * 100);
  if (!Number.isSafeInteger(paise) || !Number.isSafeInteger(target.knownPaise + paise)) {
    throw new Error("Report exceeds safe monetary precision.");
  }
  target.knownPaise += paise;
  target.knownOrders++;
}

function summarizeDaily(window, rows, now = new Date()) {
  const report = {
    date: window.date, timezone: "Asia/Kolkata", source: window.source,
    generatedAt: now.toISOString(),
    orders: { all: 0, confirmed: 0, cancelled: 0, paymentPending: 0, other: 0 },
    confirmedOrderValue: metric(), grossCollections: metric(), refunds: metric(),
    codOutstanding: metric(), codRecordedCollections: metric(),
    fulfilments: Object.fromEntries(PARCEL_STATES.map(status => [status, 0])),
    netProfitPaise: null,
  };
  for (const row of rows) {
    report.orders.all++;
    const active = APPROVED.has(row.status);
    if (active) report.orders.confirmed++;
    else if (row.status === "cancelled") report.orders.cancelled++;
    else if (row.status === "payment-pending") report.orders.paymentPending++;
    else report.orders.other++;
    const inr = row.pricing?.currency === "INR";
    if (active) addAmount(report.confirmedOrderValue, inr ? row.pricing.finalTotal : null);
    const payment = row.payment || {};
    const reconciled = inr && payment.amountsReconciled === true;
    addAmount(report.grossCollections, reconciled ? payment.grossCollected : null);
    addAmount(report.refunds, reconciled ? payment.refundedAmount : null);
    if (["cod", "cod-partial"].includes(payment.method)) {
      if (active) addAmount(report.codOutstanding, reconciled ? payment.amountDue : null);
      addAmount(report.codRecordedCollections, reconciled ? payment.grossCollected : null);
    }
    for (const parcel of row.parcels) {
      const status = PARCEL_STATES.includes(parcel.status) ? parcel.status : "unknown";
      report.fulfilments[status]++;
    }
  }
  return report;
}

// An approved time-range index is required. Keep this endpoint from falling
// back to a full order collection scan if staging or production lacks it.
async function dailyOperations(Order, fulfilmentsCollection, window) {
  const rows = await Order.aggregate([
    { $match: { "metadata.demo": window.source === "test", createdAt: { $gte: window.start, $lt: window.end } } },
    { $limit: MAX_ORDERS + 1 },
    { $project: { status: 1, "pricing.currency": 1, "pricing.finalTotal": 1,
      "payment.method": 1, "payment.amountsReconciled": 1, "payment.grossCollected": 1,
      "payment.refundedAmount": 1, "payment.amountDue": 1 } },
    { $lookup: { from: fulfilmentsCollection, localField: "_id", foreignField: "order",
      pipeline: [{ $project: { _id: 0, status: 1 } }], as: "parcels" } },
    { $unset: "_id" },
  ]).option({ hint: { "metadata.demo": 1, createdAt: 1 }, maxTimeMS: 5000, allowDiskUse: false });
  if (rows.length > MAX_ORDERS) throw new Error("Daily report exceeds bounded query capacity.");
  return summarizeDaily(window, rows);
}

module.exports = { reportWindow, summarizeDaily, dailyOperations };
