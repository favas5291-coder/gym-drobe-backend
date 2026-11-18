"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { inspectProduct } = require("../utils/catalogueQuality");

const FILE_BYTES = 4 * 1024 * 1024;
const FILE_PRODUCTS = 250;
const FIXTURE = path.join(__dirname, "../tests/fixtures/catalogue-quality.json");

async function fileProducts(filename) {
  const handle = await fs.open(filename);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > FILE_BYTES) throw new Error("Choose a regular JSON file of at most 4 MiB.");
    const bytes = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used !== info.size) throw new Error("Input size changed during the read. Use a stable snapshot.");
    let parsed;
    try { parsed = JSON.parse(bytes.toString("utf8", 0, used)); }
    catch { throw new Error("The input is not valid JSON."); }
    if (parsed?.success === false) throw new Error("The input records an unsuccessful catalogue response.");
    const products = Array.isArray(parsed) ? parsed : parsed?.products;
    if (!Array.isArray(products) || products.length > FILE_PRODUCTS) {
      throw new Error("Supply a products array of up to 250 records.");
    }
    return products;
  } finally { await handle.close(); }
}

function report(products, source, nextCursor = null) {
  const findings = [];
  const counts = {};
  products.forEach((product, index) => {
    const row = inspectProduct(product, index + 1);
    if (!row.issues.length) return;
    findings.push(row);
    for (const code of row.issues) counts[code] = (counts[code] || 0) + 1;
  });
  return { source, scanned: products.length, withFindings: findings.length, counts, findings, nextCursor };
}

// Fetch the same active-product population as GET /api/products. Skip joins,
// reviews, private supplier terms and credentials. No model initialization.
async function mongoPage(limit, after) {
  const uri = process.env.MONGO_URI;
  if (!/^mongodb(?:\+srv)?:\/\/[^/?#]+\/[^/?#]+(?:[?#]|$)/i.test(uri || "")) {
    throw new Error("Set MONGO_URI including the explicit database name for the selected read-only database.");
  }
  const mongoose = require("mongoose");
  const Product = require("../models/Product");
  const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const collection = client.db().collection(Product.collection.collectionName);
    const filter = { isActive: true };
    if (after) filter._id = { $gt: new mongoose.Types.ObjectId(after) };
    const projection = Object.fromEntries(["_id", "brand", "sizes", "colors", "variants", "stock", "stockStatus",
      "price", "discount", "variantPrices", "image", "images", "colorImages"].map(key => [key, 1]));
    projection.hasMarketplaceListing = { $ne: [{ $ifNull: ["$marketplaceListing", null] }, null] };
    // Read only explicit Brand / Brand name specification entries, irrespective of case.
    projection.specifications = { $arrayToObject: { $filter: {
      input: { $objectToArray: { $cond: [{ $eq: [{ $type: "$specifications" }, "object"] }, "$specifications", {}] } },
      as: "field", cond: { $in: [{ $toLower: { $trim: { input: "$$field.k" } } }, ["brand", "brand name"]] },
    } } };
    const cursor = collection.find(filter, { projection, maxTimeMS: 6000, batchSize: 5 }).sort({ _id: 1 }).limit(limit + 1);
    const rows = [];
    let bytes = 0;
    let next = null;
    for await (const row of cursor) {
      if (rows.length === limit) { next = String(rows.at(-1)._id); break; }
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > FILE_BYTES) throw new Error("Page exceeds 4 MiB. Retry with a smaller limit.");
      rows.push(row);
    }
    return report(rows, "active-products", next);
  } finally { await client.close(); }
}

async function run(args) {
  if (args.length === 1 && args[0] === "--fixture") return report(await fileProducts(FIXTURE), "fixture");
  if (args.length === 2 && args[0] === "--file") return report(await fileProducts(args[1]), "file");
  if (args[0] === "--mongo" && args[1] === "--limit" && /^(?:[1-9]\d?|100)$/.test(args[2]) &&
      (args.length === 3 || (args.length === 5 && args[3] === "--after" && /^[a-f\d]{24}$/i.test(args[4])))) {
    return mongoPage(Number(args[2]), args[4]);
  }
  throw new Error("Use --fixture, --file FILE, or --mongo --limit 1..100 [--after OBJECT_ID].");
}

if (require.main === module) {
  run(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.withFindings ? 1 : 0;
  }).catch(error => {
    // Driver messages can contain connection details. Never print URIs or parse excerpts.
    console.error(error.name.startsWith("Mongo") ? "Catalogue database read failed. Check the selected read-only connection." :
      error.code && /^E[A-Z]+$/.test(error.code) ? "Catalogue input could not be opened or read." : error.message);
    process.exitCode = 2;
  });
}

module.exports = { run };
