"use strict";
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const express = require("express");
const D = require("../../utils/marketplace/domain");
const {createMarketplaceRouter} = require("../../routes/marketplaceRoutes");
const M = require("../../models/Marketplace");
const Order = require("../../models/Order");
const fixture = require("../fixtures/marketplace-data.cjs");
const uri = process.env.GYMDROBE_TEST_MONGO_URI;
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/gymdrobe_fixture_[a-z0-9_]+(?:\?|$)/.test(uri || "")) {
  throw new Error("Dispatch review requires an explicitly named disposable loopback fixture.");
}
const id = () => new mongoose.Types.ObjectId();
async function main() {
  await mongoose.connect(uri,{autoCreate:false,autoIndex:false,dbName:"gymdrobe_fixture_dispatch_"+process.pid});
  let server;
  try {
    const owner = id(), otherOwner = id(), admin = id(), stranger = id(), a = id(), b = id();
    const principals = {a:{_id:owner,role:"customer"},b:{_id:otherOwner,role:"customer"},admin:{_id:admin,role:"admin"},stranger:{_id:stranger,role:"customer"}};
    await M.Account.collection.insertMany([{_id:a,owner,status:"active"},{_id:b,owner:otherOwner,status:"active"}]);
    const terms = D.terms({...fixture.terms,dispatchClock:"elapsed-days-from-payment-verification"});
    const item = supplier=>({quantity:1,marketplace:{accountId:String(supplier),terms,termsDigest:D.digest(terms)}});
    const sample = {status:"confirmed",customer:{email:"hidden@example.test"},shippingAddress:{addressLine:"PRIVATE_STREET"},
      payment:{status:"paid",verifiedAt:new Date("2020-04-01T00:00:00Z")},metadata:{demo:false},items:[item(a),item(b)]};
    const real = (await Order.collection.insertOne({...sample})).insertedId;
    const demo = (await Order.collection.insertOne({...sample,metadata:{demo:true}})).insertedId;
    const unknown = (await Order.collection.insertOne({...sample,items:[{quantity:1}]})).insertedId;
    const g = (order,supplier,itemIndices,status="pending") => ({_id:id(),order,supplier,itemIndices,status});
    const groups = [g(real,a,[0]),g(real,b,[1]),g(demo,a,[0]),g(unknown,a,[0]),g(real,a,[0],"delivered")];
    await M.Fulfilment.collection.insertMany(groups);
    const app = express();
    app.use("/api/marketplace",createMarketplaceRouter({enabled:()=>true,authenticate:(req,res,next)=>{
      req.user=principals[req.get("x-test-principal")];return req.user?next():res.sendStatus(401);
    }}));
    server = await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
    const url="http://127.0.0.1:"+server.address().port+"/api/marketplace/dispatch-review";
    const get=(who,query="")=>fetch(url+query,{headers:{"x-test-principal":who}});
    assert.equal((await get("guest")).status,401);
    assert.equal((await get("stranger")).status,404);
    assert.equal((await get("a","?supplier="+b)).status,404);
    assert.equal((await get("a","?source=all")).status,400);
    assert.equal((await get("a","?after=bad")).status,400);
    assert.equal((await get("a")).status,503);
    await M.Fulfilment.collection.createIndex({supplier:1,status:1,_id:1});
    const first = await get("a");
    assert.equal(first.headers.get("cache-control"),"no-store");
    const report = await first.json();
    assert.deepEqual(report.rows.map(r=>r.timing),["overdue","unknown"]);
    assert.equal(report.rows[0].dueAt,"2020-04-03T00:00:00.000Z");
    assert.equal(report.nextCursor,null);
    assert.ok(!JSON.stringify(report).includes("PRIVATE_STREET"));
    assert.ok(!JSON.stringify(report).includes("hidden@example.test"));
    assert.ok(!JSON.stringify(report).includes(String(b)));
    assert.equal((await (await get("a","?source=test")).json()).rows[0].orderId,String(demo));
    assert.equal((await (await get("admin","?supplier="+b)).json()).rows[0].fulfilmentId,String(groups[1]._id));
    assert.equal((await M.Fulfilment.collection.countDocuments()),groups.length);
    assert.equal((await Order.collection.countDocuments()),3);
    const more = Array.from({length:49},()=>g(real,a,[0],"preparing"));
    await M.Fulfilment.collection.insertMany(more);
    const pageOne=await (await get("a")).json();
    assert.ok(pageOne.nextCursor);
    const pageTwo=await (await get("a","?after="+pageOne.nextCursor)).json();
    assert.equal(pageTwo.nextCursor,null);
    const all=[...pageOne.rows,...pageTwo.rows];
    assert.equal(all.length,51);
    assert.equal(new Set(all.map(r=>r.fulfilmentId)).size,51);
    console.log("PASS dispatch clock, actual MongoDB projection, source/owner isolation, stable cursor, read-only endpoint, protected access and missing-index failure");
  } finally {
    if (server) await new Promise(resolve=>server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
