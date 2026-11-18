"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { reportWindow, summarizeDaily } = require("../utils/dailyOperations");

const clock = new Date("2026-11-18T19:30:00Z");
test("IST calendar bounds work across UTC dates, validate leap days and reject normalized/future dates", () => {
  const window = reportWindow(undefined, undefined, clock);
  assert.equal(window.date,"2026-11-19");
  assert.equal(window.start.toISOString(),"2026-11-18T18:30:00.000Z");
  assert.equal(window.end.toISOString(),"2026-11-19T18:30:00.000Z");
  assert.equal(reportWindow("2024-02-29","test",clock).source,"test");
  for (const date of ["2025-02-29","yesterday","2026-11-20",["2026-11-19"]]) {
    assert.throws(() => reportWindow(date,"real",clock), RangeError);
  }
  assert.throws(() => reportWindow(undefined,{},clock), RangeError);
});

test("order cohorts separate booked value, collections, refunds, COD and supplier parcels", () => {
  const rows = [
    { status:"delivered",pricing:{currency:"INR",finalTotal:550},payment:{method:"cod-partial",amountsReconciled:true,grossCollected:550,amountPaid:500,amountDue:0,refundedAmount:50},parcels:[{status:"delivered"},{status:"cancelled"}] },
    { status:"confirmed",pricing:{currency:"INR",finalTotal:123.45},payment:{method:"cod",amountsReconciled:true,grossCollected:0,amountDue:123.45,refundedAmount:0},parcels:[] },
    { status:"cancelled",pricing:{currency:"INR",finalTotal:100},payment:{method:"razorpay",amountsReconciled:true,grossCollected:100,refundedAmount:100},parcels:[] },
    { status:"payment-pending",pricing:{currency:"INR",finalTotal:70},payment:{method:"razorpay",amountsReconciled:false,amountPaid:70},parcels:[] },
  ];
  const report = summarizeDaily(reportWindow(undefined,"real",clock),rows,clock);
  assert.deepEqual(report.orders,{all:4,confirmed:2,cancelled:1,paymentPending:1,other:0});
  assert.deepEqual(report.confirmedOrderValue,{knownPaise:67345,knownOrders:2,unknownOrders:0});
  assert.deepEqual(report.grossCollections,{knownPaise:65000,knownOrders:3,unknownOrders:1});
  assert.equal(report.refunds.knownPaise,15000);
  assert.equal(report.codOutstanding.knownPaise,12345);
  assert.equal(report.codRecordedCollections.knownPaise,55000);
  assert.equal(report.fulfilments.delivered,1); assert.equal(report.fulfilments.cancelled,1);
  assert.equal(report.netProfitPaise,null);
});

test("missing legacy amounts, non-INR and unrecognized states are visible gaps", () => {
  const report = summarizeDaily(reportWindow("2025-01-01"),[
    {status:"confirmed",pricing:{currency:"USD",finalTotal:50},payment:{method:"cod",amountsReconciled:true,grossCollected:50},parcels:[{status:"new-state"}]},
    {status:"unknown",pricing:{currency:"INR"},payment:{amountsReconciled:true},parcels:[]},
  ]);
  assert.equal(report.confirmedOrderValue.unknownOrders,1);
  assert.equal(report.grossCollections.unknownOrders,2);
  assert.equal(report.refunds.unknownOrders,2);
  assert.equal(report.codOutstanding.unknownOrders,1);
  assert.equal(report.fulfilments.unknown,1);
  assert.equal(report.orders.other,1);
});
