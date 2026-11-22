"use strict";

const { MongoClient } = require("mongoose").mongo;

// The COD, job runner and owner-report branches rely on these database constraints.
const requirements = {
  orders: [
    { key: { orderNumber: 1 }, unique: true },
    { key: { user: 1, checkoutToken: 1 }, unique: true },
    { key: { "metadata.demo": 1, createdAt: 1 } },
  ],
  marketplacefulfilments: [{ key: { order: 1, supplier: 1 }, unique: true }],
  marketplaceentitlements: [{ key: { order: 1, itemIndex: 1 }, unique: true }],
  marketplaceledgers: [{ key: { key: 1 }, unique: true }],
  automationjobs: [
    { key: { type: 1, order: 1 }, unique: true },
    { key: { status: 1, nextRunAt: 1, _id: 1 } },
    { key: { status: 1, _id: -1 } },
  ],
};

function matches(actual, required) {
  return JSON.stringify(Object.entries(actual.key)) === JSON.stringify(Object.entries(required.key))
    && Boolean(actual.unique) === Boolean(required.unique)
    && !actual.sparse && !actual.hidden && !actual.partialFilterExpression
    && actual.expireAfterSeconds === undefined
    && (!actual.collation || actual.collation.locale === "simple");
}

async function inspect(db) {
  const topology = await db.command({ hello: 1 }, { timeoutMS: 5000 });
  const transactionalTopology = Boolean((topology.setName || topology.msg === "isdbgrid")
    && topology.logicalSessionTimeoutMinutes != null);
  const missing = [];
  for (const [name, requiredIndexes] of Object.entries(requirements)) {
    let indexes;
    try {
      indexes = await db.collection(name).listIndexes({ maxTimeMS: 5000 }).toArray();
    } catch (error) {
      if (error.code !== 26) throw error;
      indexes = [];
    }
    for (const required of requiredIndexes) {
      if (!indexes.some(index => matches(index, required))) {
        missing.push({ collection: name, ...required });
      }
    }
  }
  return { status: transactionalTopology && !missing.length ? "metadata-passed" : "blocked",
    transactionalTopology, missingIndexes: missing };
}

async function main(env) {
  const name = env.GYMDROBE_STAGING_DATABASE;
  if (env.GYMDROBE_ENV !== "staging" || !/^gymdrobe_staging_[a-z0-9][a-z0-9_]{0,38}$/.test(name || "") ||
      !env.MONGO_URI) return { status: "blocked", code: "APPROVED_STAGING_DATABASE_REQUIRED" };
  const client = new MongoClient(env.MONGO_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 1 });
  if (client.options.dbName !== name) return { status: "blocked", code: "DATABASE_NAME_MISMATCH" };
  try {
    await client.connect();
    return await inspect(client.db(name));
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main(process.env).then(report => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "metadata-passed" ? 0 : 1;
  }).catch(() => {
    console.error(JSON.stringify({ status: "blocked", code: "DATABASE_METADATA_UNAVAILABLE" }));
    process.exitCode = 1;
  });
}
module.exports = { matches, inspect, main };
