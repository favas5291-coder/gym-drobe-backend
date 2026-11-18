const source = db.getSiblingDB("gd_fixture_backup");
const restored = db.getSiblingDB("gd_fixture_restored");
const names = source.getCollectionNames().sort();
assert.eq(["entitlements", "inventory", "orders"], names);
assert.eq(names, restored.getCollectionNames().sort());
for (const name of names) {
  const before = source.getCollection(name);
  const after = restored.getCollection(name);
  assert.eq(before.find().sort({_id:1}).toArray(), after.find().sort({_id:1}).toArray());
  const indexes = collection => collection.getIndexes()
    .map(index => ({name:index.name, key:index.key, unique: Boolean(index.unique)}))
    .sort((a,b) => a.name.localeCompare(b.name));
  assert.eq(indexes(before), indexes(after));
}
let duplicateRejected = false;
try {
  restored.entitlements.insertOne({_id:"duplicate", orderId:"order-a", line:0});
} catch (error) {
  if (error.code !== 11000) throw error;
  duplicateRejected = true;
}
assert(duplicateRejected, "Restored financial uniqueness constraint failed");
print("Verified 3 collections, 4 fixture documents and financial uniqueness");
