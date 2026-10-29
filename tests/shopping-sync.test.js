"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createShoppingService, selection } = require("../utils/shoppingState");

const alice = "507f1f77bcf86cd799439011", bob = "507f1f77bcf86cd799439012";
const now = 1793304000000;
const clone = value => structuredClone(value);
const line = { productId: "507f1f77bcf86cd799439015", selectedSize: "M", selectedColor: "Black" };
const op = (id, changes, baseRevision = 0) => ({ id: `fixture-operation-${id}`, issuedAt: now, baseRevision, changes });
const adjust = delta => ({ type: "adjust", line, delta });
function fixture() {
  const states = new Map(), receipts = new Map(), accounts = new Set([alice, bob]);
  let tail = Promise.resolve(), failReceipt = false;
  const store = {
    async read(user) { return clone(states.get(user)); },
    transaction(user, work) {
      const next = tail.then(async () => {
        let state = clone(states.get(user));
        const staged = new Map();
        const result = await work({
          touchAccount: async () => accounts.has(user),
          read: async () => clone(state),
          receipt: async id => clone(receipts.get(user + id)),
          save: async value => { state = clone(value); },
          record: async (id, value) => {
            if (failReceipt) throw new Error("Fixture receipt unavailable");
            staged.set(user + id, clone(value));
          },
        });
        states.set(user, state);
        for (const [id, value] of staged) receipts.set(id, value);
        return result;
      });
      tail = next.catch(() => {});
      return next;
    },
  };
  return { service: createShoppingService({ store, now: () => now }), accounts,
    failReceipt() { failReceipt = true; } };
}

test("lost acknowledgements and replay never add a quantity twice", async () => {
  const { service } = fixture(), change = op("lost-ack", [adjust(2)]);
  const first = await service.mutate(alice, change);
  assert.equal(first.state.cart[0].quantity, 2);
  await service.mutate(alice, op("other-device", [adjust(1)], 1));
  const replay = await service.mutate(alice, change);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.cart[0].quantity, 3);
  assert.equal(replay.state.revision, 2);
});

test("concurrent devices detect stale revisions and can rebase the same intent", async () => {
  const { service } = fixture();
  const result = await Promise.allSettled([
    service.mutate(alice, op("phone", [adjust(1)])),
    service.mutate(alice, op("website", [adjust(2)])),
  ]);
  assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
  const rejected = result.find(x => x.status === "rejected").reason;
  assert.equal(rejected.code, "SHOPPING_REVISION_CONFLICT");
  const retry = await service.mutate(alice, op("website", [adjust(2)], rejected.state.revision));
  assert.equal(retry.state.cart[0].quantity, 3);
});

test("receipt identifiers and shopping data remain isolated by account", async () => {
  const { service } = fixture();
  await service.mutate(alice, op("same-id", [adjust(2)]));
  assert.deepEqual((await service.read(bob)).cart, []);
  const other = await service.mutate(bob, op("same-id", [adjust(1)]));
  assert.equal(other.state.cart[0].quantity, 1);
  assert.equal((await service.read(alice)).cart[0].quantity, 2);
  await assert.rejects(service.mutate("other-account", op("invalid", [adjust(1)])), { code: "SHOPPING_AUTH_REQUIRED" });
});

test("a reused change id cannot hide a different payload", async () => {
  const { service } = fixture();
  await service.mutate(alice, op("same-id", [adjust(2)]));
  await assert.rejects(service.mutate(alice, op("same-id", [adjust(3)], 1)), { code: "SHOPPING_OPERATION_CONFLICT" });
  assert.equal((await service.read(alice)).cart[0].quantity, 2);
});

test("legacy device seeds merge by maximum while explicit guest additions add once", async () => {
  const { service } = fixture();
  const seed = quantity => ({ type: "seed", selection: { cart: [{ ...line, quantity }], wishlist: [line.productId] } });
  await service.mutate(alice, op("first-seed", [seed(3)]));
  await service.mutate(alice, op("second-seed", [seed(2)], 1));
  const guest = op("guest-transfer", [adjust(2)], 2);
  await service.mutate(alice, guest);
  const replay = await service.mutate(alice, guest);
  assert.equal(replay.state.cart[0].quantity, 5);
  assert.deepEqual(replay.state.wishlist, [line.productId]);
});

test("kit choices, variants and wishlist removals do not carry prices or checkout approval", async () => {
  const { service } = fixture();
  const group = { id: "kit_fixture_group", kitId: "507f1f77bcf86cd799439018", version: 1, name: "Fixture kit", level: "beginner", slotKey: "shirt" };
  const result = await service.mutate(alice, op("kit", [
    { type: "adjust", line: { ...line, kitGroup: group }, delta: 1 },
    { type: "adjust", line: { ...line, selectedSize: "L" }, delta: 2 },
    { type: "wish", productId: line.productId, saved: true },
  ]));
  assert.equal(result.state.cart.length, 2);
  assert.equal(result.state.cart[0].kitGroup.version, 1);
  const removed = await service.mutate(alice, op("remove-wish", [{ type: "wish", productId: line.productId, saved: false }], 1));
  assert.deepEqual(removed.state.wishlist, []);
  assert.throws(() => selection({ cart: [{ ...line, quantity: 1, price: 1 }], wishlist: [] }), { code: "SHOPPING_INPUT_INVALID" });
  assert.throws(() => selection({ cart: [{ ...line, quantity: 1, kitGroup: { ...group, checkoutReady: true } }], wishlist: [] }), { code: "SHOPPING_INPUT_INVALID" });
});

test("failed persistence rolls back the list and its receipt together", async () => {
  const f = fixture();
  f.failReceipt();
  await assert.rejects(f.service.mutate(alice, op("database-failure", [adjust(1)])));
  assert.equal((await f.service.read(alice)).revision, 0);
});

test("deleted/disabled accounts cannot recreate shopping records", async () => {
  const f = fixture();
  f.accounts.delete(alice);
  await assert.rejects(f.service.mutate(alice, op("deleted", [adjust(1)])), { code: "SHOPPING_AUTH_REQUIRED" });
  assert.deepEqual((await f.service.read(alice)).cart, []);
});

test("old offline changes require review; acknowledged replays remain harmless", async () => {
  const { service } = fixture();
  const original = op("old-but-accepted", [adjust(1)]);
  await service.mutate(alice, original);
  assert.equal((await service.mutate(alice, { ...original, issuedAt: now - 8 * 86400000 })).duplicate, true);
  await assert.rejects(service.mutate(alice, { ...op("too-old", [adjust(1)], 1), issuedAt: now - 8 * 86400000 }), { code: "SHOPPING_REVIEW_REQUIRED" });
  assert.equal((await service.read(alice)).cart[0].quantity, 1);
});

test("replacement requires explicit confirmation and a current account revision", async () => {
  const { service } = fixture();
  await service.mutate(alice, op("initial", [adjust(1)]));
  const replace = { type: "replace", selection: { cart: [], wishlist: [] }, confirmed: true };
  await assert.rejects(service.mutate(alice, op("stale-replace", [replace])), { code: "SHOPPING_REVISION_CONFLICT" });
  const saved = await service.mutate(alice, op("confirmed-replace", [replace], 1));
  assert.deepEqual(saved.state.cart, []);
});
