const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const express = require("express");
const mongoose = require("mongoose");
const sharp = require("sharp");
const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const Brand = require("../../models/Brand");
const Product = require("../../models/Product");
const { Media, Quota, Audit } = require("../../models/Marketplace");
const logos = require("../../utils/brandLogos");
const router = require("../../routes/brandRoutes");
const uri = process.env.GYMDROBE_TEST_MONGO_URI || "";
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/gymdrobe_fixture_[a-z\d_]+\?/.test(uri) || !uri.includes("replicaSet=")) {
  throw new Error("Use an isolated loopback Mongo replica set.");
}

async function main() {
  const dbName = `gymdrobe_fixture_brand_${randomBytes(6).toString("hex")}`;
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 8000 });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/brands", router());
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    await Promise.all([User, Brand, Product, Media, Quota, Audit].map(model => model.createIndexes()));
    const admin = await User.create({ name: "QA Admin", email: "qa-brand@example.test", password: "Brand-Fixture-Only-123", role: "admin" });
    const token = jwt.sign({ userId: String(admin._id), authVersion: 0 }, process.env.JWT_SECRET);
    const call = (path, body, authorized = false) => fetch(base + "/brands" + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const list = async () => (await (await call("/admin", null, true)).json()).brands;
    const image = await sharp({ create: { width: 100, height: 42, channels: 3, background: "#0f3d3a" } }).png().toBuffer();
    const mime = "image/png";
    const base64 = image.toString("base64");

    assert.equal((await call("/admin", { name: "Adidas" })).status, 401);
    const created = await Promise.all([" Adidas ", "ADIDAS"].map(name => call("/admin", { name }, true)));
    assert.ok(created.every(response => response.ok), await Promise.all(created.map(r => r.text())));
    assert.equal(await Brand.countDocuments(), 1);
    assert.equal((await list())[0].status, "queued");
    const requested = [];
    await logos.processLogoJob({ fetchLogo: async url => { requested.push(url); return { mime, base64 }; } });
    await logos.processLogoJob({ fetchLogo: async url => { requested.push(url); return { mime, base64 }; } });
    assert.equal(requested.length, 1);
    const candidate = (await list())[0];
    assert.equal(candidate.status, "review");
    assert.match(candidate.candidate.source, /^https:\/\/news\.adidas\.com\//);
    assert.equal((await call(`/adidas/logo/${candidate.candidate.media}`)).status, 404);
    assert.equal((await call(`/admin/adidas/preview/${candidate.candidate.media}`, null, true)).headers.get("content-type"), "image/webp");
    assert.equal((await call("/admin/adidas/approve", { revision: candidate.revision }, true)).status, 200);
    const publicRows = (await (await call("")).json()).brands;
    assert.deepEqual(publicRows.map(row => row.key), ["adidas"]);
    assert.equal((await call(publicRows[0].logoPath.replace("/brands", ""))).headers.get("content-type"), "image/webp");

    assert.equal((await call("/admin", { name: "Ambiguous Brand" }, true)).status, 200);
    const ambiguous = (await list()).find(row => row.key === "ambiguous brand");
    assert.equal(ambiguous.status, "unavailable");
    assert.equal((await call("/admin/upload", { name: ambiguous.name, revision: ambiguous.revision, source: "javascript:alert(1)", mime, base64 }, true)).status, 400);
    assert.equal((await call("/admin/upload", { name: ambiguous.name, revision: ambiguous.revision, mime, base64 }, true)).status, 200);
    const manual = (await list()).find(row => row.key === ambiguous.key);
    assert.equal(manual.status, "review");
    assert.equal((await call("/admin/ambiguous%20brand/approve", { revision: manual.revision }, true)).status, 200);
    const approved = (await list()).find(row => row.key === ambiguous.key);
    assert.equal((await call("/admin/ambiguous%20brand/remove", { revision: approved.revision }, true)).status, 200);
    assert.equal((await call(`/ambiguous%20brand/logo/${approved.approved.media}`)).status, 404);
    const ad = (await list()).find(row => row.key === "adidas");
    assert.equal((await call(`/adidas/logo/${ad.approved.media}`)).status, 200);

    await logos.registerBrand("Coitonic", admin);
    await logos.processLogoJob({ fetchLogo: async () => { throw new Error("Fixture source offline"); } });
    assert.equal((await list()).find(row => row.key === "coitonic").status, "unavailable");
    console.log("PASS brand registration, duplicate casing, official-source lookup, admin approval, public media, manual upload, removal and unavailable sources");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
