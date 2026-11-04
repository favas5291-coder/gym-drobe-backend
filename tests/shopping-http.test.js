"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startShoppingFixture } = require("./helpers/shoppingFixture.cjs");

test("shopping HTTP routes verify actual JWT ownership, reject forged fields and never cache private lists", async () => {
  const f = await startShoppingFixture();
  const url = f.url + "/api/shopping-state";
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer invalid-fixture-token" } })).status, 401);
    const operation = { id: "fixture-http-operation-01", issuedAt: Date.now(), baseRevision: 0,
      changes: [{ type: "adjust", line: { productId: "507f1f77bcf86cd799439015", selectedSize: "M", selectedColor: "Black" }, delta: 2 }] };
    const save = await fetch(url + "/operations", { method: "POST", headers: {
      Authorization: `Bearer ${f.tokens.alice}`, "Content-Type": "application/json",
    }, body: JSON.stringify(operation) });
    assert.equal(save.status, 200);
    assert.equal(save.headers.get("cache-control"), "no-store");
    assert.equal((await save.json()).state.cart[0].quantity, 2);
    const other = await fetch(url, { headers: { Authorization: `Bearer ${f.tokens.bob}` } });
    assert.deepEqual((await other.json()).state.cart, []);
    const forged = await fetch(url + "/operations", { method: "POST", headers: {
      Authorization: `Bearer ${f.tokens.bob}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ ...operation, user: f.ids.alice }) });
    assert.equal(forged.status, 400);
    assert.equal(f.state(f.ids.alice).cart[0].quantity, 2);
    assert.equal(f.state(f.ids.bob), undefined);
  } finally { await f.close(); }
});
