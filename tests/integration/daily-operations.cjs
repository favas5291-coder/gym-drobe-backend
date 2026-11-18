"use strict";
// Run only with a disposable loopback database. No live collections, accounts or providers.
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const {reportWindow, dailyOperations} = require("../../utils/dailyOperations");
const uri = process.env.GYMDROBE_TEST_MONGO_URI;
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/gymdrobe_fixture_[a-z0-9_]+(?:\?|$)/.test(uri || "")) {
  throw new Error("An explicitly named disposable loopback fixture database is required.");
}

async function main() {
  await mongoose.connect(uri, {autoCreate:false,autoIndex:false, dbName:"gymdrobe_fixture_report_" + process.pid});
  const Order = require("../../models/Order");
  const {Fulfilment} = require("../../models/Marketplace");
  const window = reportWindow("2024-02-29","real");
  const row = {metadata:{demo:false},status:"confirmed",pricing:{currency:"INR",finalTotal:200.05},
    payment:{method:"cod",amountsReconciled:true,grossCollected:0,refundedAmount:0,amountDue:200.05},
    customer:{email:"private@example.test"},createdAt:window.start};
  try {
    const inserted = await Order.collection.insertOne({...row});
    await Order.collection.insertMany([{...row,metadata:{demo:true}},{...row,createdAt:window.end}]);
    await Fulfilment.collection.insertOne({order:inserted.insertedId,status:"accepted"});
    await assert.rejects(dailyOperations(Order,Fulfilment.collection.name,window), /hint/i);
    await Order.collection.createIndex({"metadata.demo":1, createdAt:1});
    await Fulfilment.collection.createIndex({order:1,supplier:1});
    const report = await dailyOperations(Order,Fulfilment.collection.name,window);
    assert.equal(report.orders.all,1);
    assert.equal(report.fulfilments.accepted,1);
    assert.equal(report.confirmedOrderValue.knownPaise,20005);
    assert.equal(report.codOutstanding.knownPaise,20005);
    assert.ok(!JSON.stringify(report).includes("private@example.test"));
    assert.equal(await Order.collection.countDocuments({}),3);
    assert.equal(await Fulfilment.collection.countDocuments({}),1);
    const demo = await dailyOperations(Order,Fulfilment.collection.name, reportWindow(window.date,"test"));
    assert.equal(demo.orders.all,1);
    assert.equal(demo.fulfilments.accepted,0);
    const express = require("express");
    const jwt = require("jsonwebtoken");
    const User = require("../../models/User");
    const adminRoutes = require("../../routes/adminRoutes");
    process.env.JWT_SECRET = "local-report-fixture-secret";
    const app = express();
    app.use("/api/admin", adminRoutes);
    const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    try {
      const url = "http://127.0.0.1:" + server.address().port + "/api/admin/reports/daily-operations?date=" + window.date;
      assert.equal((await fetch(url)).status,401);
      for (const role of ["customer","supplier","admin"]) {
        const created = await User.collection.insertOne({email:role+"@fixture.test",role,isActive:true,authVersion:0});
        const token = jwt.sign({userId:String(created.insertedId),authVersion:0},process.env.JWT_SECRET,{algorithm:"HS256"});
        const headers = {Authorization:"Bearer "+token};
        const response = await fetch(url,{headers});
        assert.equal(response.status,role === "admin" ? 200 : 403);
        assert.equal(response.headers.get("cache-control"),"no-store");
        if (role === "admin") {
          assert.equal((await response.json()).report.orders.all,1);
          assert.equal((await fetch(url.replace(window.date,"invalid"),{headers})).status,400);
        }
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
    await Order.collection.insertMany(Array.from({length:5000},()=>({...row})));
    await assert.rejects(dailyOperations(Order,Fulfilment.collection.name,window), /bounded/);
    console.log("PASS protected HTTP route and refusal to return truncated high-volume results");
    console.log("PASS indexed IST cohort, exclusive upper bound, test isolation, supplier join, no PII and unchanged source rows");
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
