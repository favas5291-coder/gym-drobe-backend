"use strict";
// Isolated test server: no database, provider credentials or real customers.
// Uses the actual router, authorization middleware and shopping service.
const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const { createShoppingService } = require("../../utils/shoppingState");
const { createShoppingRouter } = require("../../routes/shoppingRoutes");

const ids = { alice: "507f1f77bcf86cd799439011", bob: "507f1f77bcf86cd799439012" };
async function startShoppingFixture() {
  const previousSecret = process.env.JWT_SECRET, previousFind = User.findById;
  process.env.JWT_SECRET = "isolated-shopping-fixture-not-a-production-secret";
  const users = new Map(Object.entries(ids).map(([name, _id]) => [_id, {
    _id, id: _id, role: "customer", isActive: true, authVersion: 0,
    name: `Fixture ${name}`, email: `${name}@example.test`,
  }]));
  User.findById = id => ({ select: async () => structuredClone(users.get(String(id))) });
  const states = new Map(), receipts = new Map();
  let tail = Promise.resolve();
  const store = {
    async read(user) { return structuredClone(states.get(user)); },
    transaction(user, work) {
      const next = tail.then(async () => {
        let state = structuredClone(states.get(user));
        const pending = new Map();
        const result = await work({
          touchAccount: async () => users.has(user),
          read: async () => structuredClone(state),
          receipt: async id => structuredClone(receipts.get(user + id)),
          save: async value => { state = structuredClone(value); },
          record: async (id, value) => pending.set(user + id, structuredClone(value)),
        });
        states.set(user, state);
        for (const [key, value] of pending) receipts.set(key, value);
        return result;
      });
      tail = next.catch(() => {});
      return next;
    },
  };
  const app = express();
  app.use(express.json({ limit: "128kb" }));
  app.use("/api/shopping-state", createShoppingRouter({ enabled: () => true, service: createShoppingService({ store }) }));
  let server;
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    ids,
    tokens: Object.fromEntries(Object.entries(ids).map(([name, userId]) => [name,
      jwt.sign({ userId, authVersion: 0 }, process.env.JWT_SECRET, { expiresIn: "1h", algorithm: "HS256" }),
    ])),
    state: user => structuredClone(states.get(user)),
    async close() {
      await new Promise(resolve => server.close(resolve));
      User.findById = previousFind;
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    },
  };
}
module.exports = { startShoppingFixture };
