"use strict";
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../../models/User");
const Order = require("../../models/Order");
const Address = require("../../models/Address");
const { Account } = require("../../models/Marketplace");

async function run() {
  const uri = process.env.GYMDROBE_CUSTOMER_FIXTURE_URI || "";
  if (!/^mongodb:\/\/127\.0\.0\.1:\d{1,5}\/gymdrobe_fixture_customer_[a-z0-9_]+\?directConnection=true$/.test(uri)) {
    throw new Error("A local, isolated customer fixture is required.");
  }
  const dbName = "gymdrobe_fixture_customer_" + randomUUID().replaceAll("-","");
  await mongoose.connect(uri, {dbName, autoIndex:false, autoCreate:false});
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  let server;
  try {
    const oid = () => new mongoose.Types.ObjectId();
    const [admin, customer, other, supplier] = ["admin", "customer", "customer", "customer"].map((role,index) => ({
      _id:oid(), role, email:"fixture"+index+"@example.test", name:"Fixture "+index, isActive:true, authVersion:0,
      password:"private-auth-sentinel", googleId:"private-federation-sentinel", createdAt:new Date()
    }));
    await User.collection.insertMany([admin, customer, other, supplier]);
    await Account.collection.insertOne({supplier:oid(), owner:supplier._id, status:"active"});
    const makeOrder = (user, number, demo, amount, extra = {}) => ({
      _id:oid(), user:user._id, orderNumber:number, status:"delivered", createdAt:new Date(),
      metadata:{demo}, pricing:{currency:"INR", finalTotal:amount}, paymentMethod:"razorpay",
      payment:{method:"razorpay",mode:demo ? "test" : "live",status:"paid",amountPaid:amount,amountDue:0,
        grossCollected:amount,refundedAmount:0,amountsReconciled:true,razorpaySignature:"private-signature-sentinel"},
      items:[{name:"Fixture shirt",quantity:1,price:amount}], shippingAddress:{phone:"9999999999",email:"private-shipping-sentinel"},
      ...extra
    });
    await Order.collection.insertMany([makeOrder(customer,"A1",false,100),makeOrder(customer,"A2",false,40),
      makeOrder(customer,"A-DEMO",true,1000,{createdAt:new Date(Date.now()+500),shippingAddress:{phone:"8888888888"}}),
      makeOrder(other,"B-PRIVATE",false,400)]);
    await Address.collection.insertOne({user:other._id,addressLine:"unrelated-address-sentinel"});
    const app = express();
    app.use(express.json());
    app.use("/api/admin", require("../../routes/adminRoutes"));
    server = app.listen(0,"127.0.0.1");
    await new Promise(resolve=>server.once("listening",resolve));
    async function call(path, actor, method = "GET", body) {
      const headers = { "Content-Type":"application/json" };
      if (actor) headers.Authorization = "Bearer "+jwt.sign({userId:String(actor._id),role:"admin"},process.env.JWT_SECRET);
      const res = await fetch("http://127.0.0.1:"+server.address().port+"/api/admin/customers"+path, {
        method, headers, body: body ? JSON.stringify(body) : undefined
      });
      assert.equal(res.headers.get("cache-control"), "no-store");
      return { status:res.status, data:await res.json() };
    }
    const path = "/"+customer._id;
    assert.equal((await call(path)).status,401);
    for (const actor of [customer,supplier]) {
      assert.equal((await call(path,actor)).status,403);
      assert.equal((await call("?activity=repeat",actor)).status,403);
      assert.equal((await call(path+"/status",actor,"PATCH",{isActive:false,expectedIsActive:true})).status,403);
    }
    assert.equal((await call("/"+admin._id,admin)).status,404);
    assert.equal((await call("/invalid",admin)).status,400);
    const detail = await call(path,admin);
    assert.equal(detail.status,200);
    assert.equal(detail.data.customer.id,String(customer._id));
    assert.equal(detail.data.customer.phone,"9999999999");
    assert.equal(detail.data.summary.confirmed,2);
    assert.equal(detail.data.summary.retainedPaise,14000);
    assert.deepEqual(detail.data.orders.map(row=>row.orderNumber).sort(), ["A1","A2"]);
    assert.deepEqual(detail.data.addresses,[]);
    const json = JSON.stringify(detail.data);
    for (const secret of ["private-", "unrelated-address-sentinel", "B-PRIVATE", "A-DEMO"]) assert.ok(!json.includes(secret));
    assert.equal((await call(path+"?source=test",admin)).data.orders[0].orderNumber,"A-DEMO");
    const merged = await call("?activity=all&sort=newest&from=&to=",admin);
    assert.equal(merged.status,200);
    assert.equal(merged.data.stats.total,3);
    assert.equal(merged.data.customers.find(row=>row.id===String(customer._id)).purchaseCount,2);
    const repeat = await call("?activity=repeat",admin);
    assert.deepEqual(repeat.data.customers.map(row=>row.id),[String(customer._id)]);
    const legacy = await call("?status=active",admin);
    assert.equal(legacy.status,200);
    assert.ok(legacy.data.customers.some(row=>row.id===String(customer._id) && row.orderCount===3));
    assert.deepEqual(legacy.data.stats,merged.data.stats);
    assert.equal((await call(path+"/status",admin,"PATCH",{isActive:false,expectedIsActive:true})).status,200);
    assert.equal((await call("?status=disabled",admin)).data.customers[0].id,String(customer._id));
    console.log("PASS admin customer detail, financial amounts, source separation, current and legacy lists, repeat counts, authorization and status access");
  } finally {
    if (server) await new Promise(resolve=>server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
