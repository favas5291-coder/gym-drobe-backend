// Start a disposable loopback MongoDB with --auth and no existing users.
// This fixture provisions isolated users and writes synthetic product records.
"use strict";
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { mongo: { MongoClient, ObjectId } } = require("mongoose");
const { run } = require("../../scripts/catalogue-quality.cjs");

async function main() {
  const origin = process.env.CATALOGUE_TEST_MONGO;
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+$/.test(origin || "")) {
    throw new Error("CATALOGUE_TEST_MONGO must refer to a fresh loopback --auth instance.");
  }
  const name = "fixture_" + randomBytes(8).toString("hex");
  const password = randomBytes(32).toString("hex");
  const uri = user => origin.replace("://", "://" + user + ":" + password + "@");
  const setup = new MongoClient(origin);
  try {
    await setup.db("admin").command({createUser:name,pwd:password,roles:["root"]});
  } finally { await setup.close(); }
  const writer = new MongoClient(uri(name) + "/admin");
  const db = writer.db(name);
  const reader = name + "_reader";
  try {
    await db.command({createUser:reader,pwd:password,roles:[{role:"read",db:name}]});
    const [first,second] = [new ObjectId(),new ObjectId()];
    const clean = { brand:"Fixture",stock:1,price:19, image:"/fixture.webp",isActive:true };
    const docs = [{...clean, _id:first}, {...clean, _id:second, specifications:{"BRAND NAME":"Second Fixture","Comment":"private-note"},
      reviews:[{name:"unprojected-private-marker"}]}, {...clean, _id:new ObjectId(), isActive:false, price:0}];
    await db.collection("products").insertMany(docs);
    process.env.MONGO_URI = uri(reader) + "/" + name;
    const a = await run(["--mongo","--limit","1"]);
    assert.equal(a.scanned,1);
    assert.equal(a.withFindings,0);
    assert.equal(a.nextCursor,String(first));
    const b = await run(["--mongo","--limit","1","--after",a.nextCursor]);
    assert.deepEqual(b.counts,{EXPLICIT_BRAND_CONFLICT:1});
    assert.equal(b.findings[0].id,String(second));
    assert.equal(b.findings[0].brandEvidence.conflictingFields[0].value,"Second Fixture");
    assert.equal(b.nextCursor,null);
    assert.ok(!JSON.stringify(b).includes("private"));
    assert.deepEqual(await db.collection("products").find().sort({_id:1}).toArray(),docs);
    console.log("PASS authenticated MongoDB read-only account: active product projection, brand evidence, cursors and unchanged fixture records.");
  } finally {
    await db.command({dropAllUsersFromDatabase:1});
    await db.dropDatabase();
    await writer.db("admin").command({dropUser:name});
    await writer.close();
  }
}

main().catch(error => { console.error(error.name + ": " + error.message); process.exitCode=1; });
