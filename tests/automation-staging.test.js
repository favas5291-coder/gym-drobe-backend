const test = require("node:test");
const assert = require("node:assert/strict");
const { matches, inspect, main } = require("../scripts/checkAutomationStaging.cjs");

test("staging pilot requires the actual composite unique constraint", () => {
  const rule = { key: { order: 1, supplier: 1 }, unique: true };
  assert.ok(matches({ ...rule, name: "custom_name" }, rule));
  for (const change of [{ unique: false }, { hidden: true }, { sparse: true },
    { partialFilterExpression: { live: true } }, { expireAfterSeconds: 0 }, { collation: { locale: "en" } },
    { key: { supplier: 1, order: 1 } }]) {
    assert.equal(matches({ ...rule, ...change }, rule), false);
  }
});

test("missing collection and standalone topology report blockers and read no customer documents", async () => {
  const db = { command: async cmd => { assert.deepEqual(cmd, { hello: 1 }); return { ok: 1 }; },
    collection: () => ({ listIndexes: () => ({ toArray: async () => { throw Object.assign(new Error(), { code: 26 }); } }) }) };
  const report = await inspect(db);
  assert.equal(report.status, "blocked");
  assert.equal(report.transactionalTopology, false);
  assert.equal(report.missingIndexes.length, 9);
});

test("environment and database mismatches stop before connection", async () => {
  assert.equal((await main({})).code, "APPROVED_STAGING_DATABASE_REQUIRED");
  assert.equal((await main({ GYMDROBE_ENV: "staging", GYMDROBE_STAGING_DATABASE: "gymdrobe_staging_pilot",
    MONGO_URI: "mongodb://127.0.0.1:1/other" })).code, "DATABASE_NAME_MISMATCH");
});
