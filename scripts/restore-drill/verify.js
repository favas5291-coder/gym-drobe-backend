const check = require("node:assert/strict");
// mongosh creates objects in multiple JavaScript realms. Compare canonical BSON strings
// so values and BSON types are checked without comparing JavaScript prototypes.
function same(actual, expected) {
  check.equal(EJSON.stringify(actual, {relaxed: false}), EJSON.stringify(expected, {relaxed: false}));
}
const source = db.getSiblingDB("gd_fixture_backup");
const restored = db.getSiblingDB("gd_fixture_restored");
const names = source.getCollectionNames().sort();
same(["entitlements", "inventory", "orders"], names);
same(names, restored.getCollectionNames().sort());
for (const name of names) {
  const before = source.getCollection(name);
  const after = restored.getCollection(name);
  same(before.find().sort({_id:1}).toArray(), after.find().sort({_id:1}).toArray());
  const indexes = collection => collection.getIndexes()
    .map(index => ({name:index.name, key:index.key, unique: Boolean(index.unique)}))
    .sort((a,b) => a.name.localeCompare(b.name));
  same(indexes(before), indexes(after));
}
let duplicateRejected = false;
try {
  restored.entitlements.insertOne({_id:"duplicate", orderId:"order-a", line:0});
} catch (error) {
  if (error.code !== 11000) throw error;
  duplicateRejected = true;
}
check.ok(duplicateRejected, "Restored financial uniqueness constraint failed");
print("Verified 3 collections, 4 fixture documents and financial uniqueness");
