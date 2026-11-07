const test = require("node:test");
const assert = require("node:assert/strict");
const Product = require("../models/Product");

function product() {
  return new Product({
    name: "Training Compression T-shirt",
    slug: "training-compression-tshirt",
    category: "Training clothing",
    brand: "Demo",
    sku: "DEMO-SEARCH-001",
    price: 799,
    stock: 0,
    image: "/demo-shirt.jpg",
    isActive: false,
  });
}

test("admin-defined search aliases are validated and kept as distinct public product text", async () => {
  const draft = product();
  draft.searchAliases = ["Gym tee", "Workout shirt", "gym tee"];
  await draft.validate();
  assert.deepEqual(draft.searchAliases, ["Gym tee", "Workout shirt"]);
  assert.ok(Object.prototype.hasOwnProperty.call(draft.toObject(), "searchAliases"));
});

test("search aliases reject oversized entries and excessive collections", async () => {
  const tooLong = product();
  tooLong.searchAliases = ["x".repeat(81)];
  await assert.rejects(tooLong.validate(), /searchAliases/);
  const tooMany = product();
  tooMany.searchAliases = Array.from({ length: 31 }, (_, i) => "Valid alias " + i);
  await assert.rejects(tooMany.validate(), /searchAliases/);
});

test("search aliases remain optional for existing catalogue products", async () => {
  const legacy = product();
  await legacy.validate();
  assert.deepEqual(legacy.searchAliases, []);
});
