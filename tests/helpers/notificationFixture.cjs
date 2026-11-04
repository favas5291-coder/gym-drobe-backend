"use strict";
// Isolated contract fixture, never imported by the application/server.
const express = require("express");
const { once } = require("node:events");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const { registration, registrationUpdate } = require("../../utils/notifications/domain");
const { createNotificationRouter } = require("../../routes/notificationRoutes");
async function startNotificationFixture() {
  const ids = { alice: "507f1f77bcf86cd799439011", bob: "507f1f77bcf86cd799439012" };
  const secret = crypto.randomBytes(32).toString("hex"), encryption = crypto.randomBytes(32), rows = new Map();
  const original = User.findById, previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  User.findById = id => ({ select: async () => Object.values(ids).includes(String(id)) ? { _id: String(id), isActive: true, role: "customer", authVersion: 0 } : null });
  const repository = {
    async devices(user) { return [...rows.values()].filter(row => row.user === String(user)).map(({ _id, binding, enabled, platform, environment, expiresAt }) => ({ _id, binding, enabled, platform, environment, expiresAt })); },
    async register(user, row) {
      const saved = registrationUpdate(rows.get(row._id), row, user);
      rows.set(row._id, { ...saved, user: String(user) });
      return { device: saved._id, binding: saved.binding, enabled: true, expiresAt: saved.expiresAt };
    },
    async disable(user, input) { const row = rows.get(input.device); if (row?.user === String(user) && row.binding === input.binding) row.enabled = false; },
  };
  const app = express(); app.use(express.json());
  app.use("/api/notifications", createNotificationRouter({ repository, enabled: () => true, register: body => registration(body, Date.now(), encryption) }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  return { ids, tokens: Object.fromEntries(Object.entries(ids).map(([name, userId]) => [name, jwt.sign({ userId }, secret, { expiresIn: "15m" })])),
    url: `http://127.0.0.1:${server.address().port}`,
    devices: user => [...rows.values()].filter(row => row.user === String(user)).map(({ _id, binding, enabled }) => ({ _id, binding, enabled })),
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); User.findById = original; if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; },
  };
}
module.exports = { startNotificationFixture };
