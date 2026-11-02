"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { inspectStagingConfiguration, assertStagingIsolation } = require("../utils/stagingReadiness");

function fixture(overrides = {}) {
  return {
    GYMDROBE_ENV: "staging", NODE_ENV: "production",
    GYMDROBE_STAGING_DATABASE: "gymdrobe_staging_fixture",
    MONGO_URI: "mongodb://fixture-user:private-database-password@127.0.0.1:27017/gymdrobe_staging_fixture?replicaSet=rs0",
    RAZORPAY_KEY_ID: "rzp_test_A1B2C3", RAZORPAY_KEY_SECRET: "private-provider-fixture-value",
    RAZORPAY_WEBHOOK_SECRET: "private-webhook-fixture-value", JWT_SECRET: "private-staging-jwt-value-at-least-32-characters",
    FRONTEND_URL: "https://gymdrobe-staging.example", PUSH_REGISTRATION_ENABLED: "false", PUSH_DELIVERY_ENABLED: "false",
    ...overrides,
  };
}

function blocked(env, id) {
  const result = inspectStagingConfiguration(env);
  assert.equal(result.status, "blocked");
  assert.equal(result.checks.find(item => item.id === id).status, "blocked");
}

test("staging configuration accepts a test-shaped isolated configuration without claiming provider/database verification", () => {
  const result = inspectStagingConfiguration(fixture());
  assert.equal(result.status, "configuration-passed");
  assert.match(result.limitations.join(" "), /still require separate staging verification/);
  assert.doesNotThrow(() => assertStagingIsolation(fixture()));
  assert.doesNotThrow(() => assertStagingIsolation(fixture({ GYMDROBE_ENV: " STAGING " })));
});

test("configuration results and guard errors exclude every supplied credential, URI and host", () => {
  const env = fixture({ RAZORPAY_KEY_ID: "rzp_live_PrivateLiveKey", FRONTEND_URL: "https://private-preview.example/path", MONGO_URI: "mongodb://private-user:super-private-password@private-db.example/production" });
  let message = "";
  try { assertStagingIsolation(env); } catch (error) { message = error.message; }
  const text = JSON.stringify(inspectStagingConfiguration(env)) + message;
  for (const name of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "JWT_SECRET", "MONGO_URI", "FRONTEND_URL"]) assert.equal(text.includes(env[name]), false, name);
  for (const token of ["private-db.example", "super-private-password", "private-user"]) assert.equal(text.includes(token), false);
});

test("live, absent and placeholder payment credentials are blocked", () => {
  for (const key of ["rzp_live_A1", "rzp_test_replace_me", "", "rzp_test_../private"]) blocked(fixture({ RAZORPAY_KEY_ID: key }), "test-payment-key");
  for (const value of ["", "replace-with-a-private-value", "your_secret", "${PAYMENT_SECRET}", "<secret>"]) {
    blocked(fixture({ RAZORPAY_KEY_SECRET: value }), "payment-secret");
    blocked(fixture({ RAZORPAY_WEBHOOK_SECRET: value }), "webhook-secret");
  }
  blocked(fixture({ JWT_SECRET: "short" }), "jwt-secret");
});

test("a database label never overrides the actual Mongo URI selection", () => {
  for (const uri of ["mongodb://127.0.0.1:27017/production", "mongodb://127.0.0.1:27017", "mongodb://bad:port/gymdrobe_staging_fixture", "https://db.example/gymdrobe_staging_fixture"]) blocked(fixture({ MONGO_URI: uri }), "staging-database");
  blocked(fixture({ GYMDROBE_STAGING_DATABASE: "production", MONGO_URI: "mongodb://127.0.0.1:27017/production" }), "staging-database");
});

test("the actual driver parses SRV, multi-host and encoded Mongo credentials without connecting", () => {
  for (const uri of [
    "mongodb+srv://u:p%40private@cluster.example/gymdrobe_staging_fixture",
    "mongodb://u:p%40private@one.example:27017,two.example:27017/gymdrobe_staging_fixture?replicaSet=rs0",
  ]) assert.equal(inspectStagingConfiguration(fixture({ MONGO_URI: uri })).status, "configuration-passed");
});

test("known production domains, credentials in URLs and remote HTTP are blocked", () => {
  for (const origin of ["https://gymdrobe.com", "https://WWW.GYMDROBE.COM./", "https://sub.gymdrobe.com", "https://gym-store-xi.vercel.app", "https://user:password@staging.example", "http://staging.example", "https://staging.example/path", "https://staging.example?token=private", "https://staging.example#private"]) blocked(fixture({ FRONTEND_URL: origin }), "staging-frontend");
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) assert.equal(inspectStagingConfiguration(fixture({ FRONTEND_URL: origin })).status, "configuration-passed");
});

test("staging payment checks block push and supplied outbound email/advertising credentials", () => {
  for (const key of ["PUSH_REGISTRATION_ENABLED", "PUSH_DELIVERY_ENABLED"]) {
    for (const flag of ["true", "TRUE", "enabled"]) blocked(fixture({ [key]: flag }), "push-disabled");
  }
  for (const key of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]) blocked(fixture({ [key]: "private-value" }), "email-disabled");
  blocked(fixture({ META_CAPI_ACCESS_TOKEN: "private-value" }), "marketing-disabled");
});

test("environment selector typos fail while existing non-staging modes keep their previous behavior", () => {
  for (const mode of [undefined, "production", "development", "test"]) assert.doesNotThrow(() => assertStagingIsolation({ GYMDROBE_ENV: mode }));
  assert.throws(() => assertStagingIsolation({ GYMDROBE_ENV: "stagng" }), { code: "GYMDROBE_ENV_INVALID" });
  blocked(fixture({ GYMDROBE_ENV: "production" }), "staging-environment");
});

test("CLI checks a private file offline, honors inherited blockers and prints no supplied secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gymdrobe-staging-check-"));
  try {
    const env = fixture();
    const envFile = path.join(dir, "private.env");
    fs.writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
    const preload = path.join(dir, "deny-network.cjs");
    fs.writeFileSync(preload, `
      const deny = () => { throw new Error('UNEXPECTED_NETWORK_REQUEST'); };
      require('node:net').Socket.prototype.connect = deny;
      require('node:tls').connect = deny;
      require('node:http').request = require('node:https').request = deny;
      require('node:dns').resolveSrv = deny;
      require('node:dns').promises.resolveSrv = deny;
      global.fetch = deny;
    `);
    const run = (args, extra = {}) => spawnSync(process.execPath, ["--require", preload, path.resolve(__dirname, "../scripts/checkStaging.cjs"), ...args], { env: { PATH: process.env.PATH, ...extra }, encoding: "utf8", timeout: 10000 });
    const success = run(["--staging-env", envFile]);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).status, "configuration-passed");
    for (const name of ["MONGO_URI", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "JWT_SECRET", "FRONTEND_URL"]) assert.equal(success.stdout.includes(env[name]), false, name);
    const inheritedLive = run(["--staging-env", envFile], { RAZORPAY_KEY_ID: "rzp_live_InheritedPrivateKey" });
    assert.equal(inheritedLive.status, 1);
    assert.equal(inheritedLive.stdout.includes("rzp_live_InheritedPrivateKey"), false);
    assert.equal(JSON.parse(inheritedLive.stdout).checks.find(item => item.id === "test-payment-key").status, "blocked");
    const badArg = run(["--private-secret-argument"]);
    assert.equal(badArg.status, 1);
    assert.equal(badArg.stdout.includes("private-secret-argument"), false);
    const missingFile = run(["--staging-env", path.join(dir, "private-missing-path")]);
    assert.equal(missingFile.status, 1);
    assert.equal(missingFile.stdout.includes("private-missing-path"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
