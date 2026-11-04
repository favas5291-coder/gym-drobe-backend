"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const initializeIndexes = require("../utils/initializeIndexes");

// Execute the actual server bootstrap with controlled database readiness.
// No listener, database connection or provider request leaves this fixture.
function application(held, syncEnabled = false, pushEnabled = false, env = {}) {
  let release;
  let reject;
  let listening = 0;
  let connected = 0;
  let disconnected = false;
  const waiting = new Promise((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  // Baseline code may never request this collection. Keep that intentional
  // missing-readiness regression from creating an unrelated unhandled error.
  waiting.catch(() => {});
  const models = new Map();
  const model = (name) => {
    if (!models.has(name)) models.set(name, {
      db: { readyState: 1 },
      createIndexes: () => name === held ? waiting : Promise.resolve(),
      updateOne: async () => ({ matchedCount: 1 }),
    });
    return models.get(name);
  };
  const app = {
    use() {},
    get() {},
    listen() {
      listening++;
      const server = new EventEmitter();
      server.listening = true;
      server.close = (done) => { server.listening = false; done(); };
      server.closeAllConnections = () => {};
      queueMicrotask(() => server.emit("listening"));
      return server;
    },
  };
  const express = () => app;
  express.raw = express.json = () => (_req, _res, next) => next();
  const requireFixture = (id) => {
    if (id === "express") return express;
    if (id === "dotenv") return { config() {} };
    if (id === "cors") return () => (_req, _res, next) => next();
    if (id === "mongoose") return { disconnect: async () => { disconnected = true; } };
    if (id === "./config/db") return async () => { connected++; };
    if (id === "./utils/visualSearch/model") return { close: async () => {} };
    if (id === "./utils/stagingReadiness") return require("../utils/stagingReadiness");
    if (id === "./utils/initializeIndexes") return initializeIndexes;
    if (id === "./utils/marketing/config") return { DEFAULTS: {} };
    if (id === "./utils/marketing/worker") return { startMarketingWorker() {}, stopMarketingWorker() {} };
    if (id === "./utils/notifications/domain") return { encryptionKey() {} };
    if (id === "./utils/notifications/worker") return { startNotificationWorker() {}, stopNotificationWorker() {} };
    if (id === "./models/NotificationStore") return Object.fromEntries(["Device", "Delivery", "Control"].map(name => [name, model(`Notification${name}`)]));
    if (id === "./routes/notificationRoutes") return { createNotificationRouter: () => () => {} };
    if (id === "./models/MarketingStore") return Object.fromEntries(
      ["Config", "Consent", "Event", "Checkpoint", "FeedChunk"].map((name) => [name, model(`Marketing${name}`)]),
    );
    if (id === "./models/SupplierPortal") return {};
    if (id === "./routes/supplierPortalRoutes") return { createSupplierPortalRouter: () => () => {} };
    if (id === "./routes/shoppingRoutes") return { createShoppingRouter: () => () => {} };
    if (id.startsWith("./routes/")) return () => {};
    if (id.startsWith("./models/")) return model(id.split("/").at(-1));
    throw new Error(`Unexpected bootstrap dependency: ${id}`);
  };
  const moduleFixture = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"), {
    require: requireFixture,
    module: moduleFixture,
    process: { env: { APPLE_SIGN_IN_ENABLED: "false", SUPPLIER_PORTAL_ENABLED: "false", SHOPPING_SYNC_ENABLED: String(syncEnabled), PUSH_REGISTRATION_ENABLED: String(pushEnabled), PORT: "0", ...env } },
    console: { log() {}, error() {} },
    setTimeout,
    clearTimeout,
  });
  return {
    ...moduleFixture.exports,
    release,
    reject,
    get listening() { return listening; },
    get connected() { return connected; },
    get disconnected() { return disconnected; },
  };
}

for (const collection of ["Order", "User", "GuestCheckoutSession", "ShoppingState", "ShoppingOperation", "NotificationDevice", "NotificationDelivery", "NotificationControl"]) {
  test(`HTTP traffic waits for ${collection} constraints with Apple sign-in disabled`, async () => {
    const app = application(collection, collection.startsWith("Shopping"), collection.startsWith("Notification"));
    const startup = app.startServer();
    try {
      await new Promise(setImmediate);
      assert.equal(app.listening, 0, "Do not accept commerce/auth traffic while its database constraints are pending");
      app.release();
      await startup;
      assert.equal(app.listening, 1);
    } finally {
      app.release();
      await startup.catch(() => {});
      await app.shutdown();
    }
    assert.equal(app.disconnected, true);
  });
}

test("failed order constraints keep the HTTP listener closed", async () => {
  const app = application("Order");
  const failure = new Error("Fixture order index unavailable");
  const startup = app.startServer();
  const checked = assert.rejects(startup, (error) => error === failure);
  app.reject(failure);
  try {
    await checked;
    assert.equal(app.listening, 0);
  } finally {
    await app.shutdown();
  }
});

test("unsafe staging configuration fails the real bootstrap before database access or listening", async () => {
  const app = application(null, false, false, {
    GYMDROBE_ENV: "staging", RAZORPAY_KEY_ID: "rzp_live_PrivateFixture",
    MONGO_URI: "mongodb://private:password@database.example/production",
  });
  try {
    await assert.rejects(app.startServer(), error => error.code === "STAGING_CONFIGURATION_BLOCKED" && !error.message.includes("PrivateFixture") && !error.message.includes("password"));
    assert.equal(app.connected, 0);
    assert.equal(app.listening, 0);
  } finally { await app.shutdown(); }
});

test("a valid staging configuration reaches the existing index and listener readiness path", async () => {
  const app = application(null, false, false, {
    GYMDROBE_ENV: "staging", GYMDROBE_STAGING_DATABASE: "gymdrobe_staging_bootstrap",
    MONGO_URI: "mongodb://127.0.0.1:27017/gymdrobe_staging_bootstrap",
    RAZORPAY_KEY_ID: "rzp_test_Fixture", RAZORPAY_KEY_SECRET: "private-provider-fixture",
    RAZORPAY_WEBHOOK_SECRET: "private-webhook-fixture", JWT_SECRET: "a-dedicated-private-fixture-jwt-at-least-32-characters",
    FRONTEND_URL: "http://localhost:5173",
  });
  try {
    await app.startServer();
    assert.equal(app.connected, 1);
    assert.equal(app.listening, 1);
  } finally { await app.shutdown(); }
});
