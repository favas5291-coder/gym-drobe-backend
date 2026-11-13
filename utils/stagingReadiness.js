"use strict";

const value = (env, name) => String(env[name] || "").trim();
const mode = (env) => value(env, "GYMDROBE_ENV").toLowerCase();
const placeholder = (text) => !text || /^(?:(?:your|paste|replace|example)(?:[_ -]|$)|changeme$|password$|secret$|<|\$\{)/i.test(text);

// Parse only. Constructing the driver does not connect; never import db.js,
// models, server.js or provider clients from this configuration check.
function databaseName(uri) {
  try {
    if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) return null;
    return new (require("mongoose").mongo.MongoClient)(uri).options.dbName;
  } catch {
    // Driver errors can include credentials/hosts from the URI.
    return null;
  }
}

function stagingOrigin(origin) {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
    const live = ["gymdrobe.com", "www.gymdrobe.com", "gym-store-xi.vercel.app"].includes(host);
    return !live && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
      && (url.protocol === "https:" || (local && url.protocol === "http:"));
  } catch {
    return false;
  }
}

function inspectStagingConfiguration(env) {
  const checks = [];
  const check = (id, passed, message) => checks.push({ id, status: passed ? "pass" : "blocked", message });
  const expectedDatabase = value(env, "GYMDROBE_STAGING_DATABASE");
  check("staging-environment", mode(env) === "staging", "Set GYMDROBE_ENV=staging for this dedicated test service.");
  check("staging-database", /^gymdrobe_staging_[a-z0-9][a-z0-9_]{0,38}$/.test(expectedDatabase)
    && databaseName(value(env, "MONGO_URI")) === expectedDatabase,
  "Set GYMDROBE_STAGING_DATABASE to a dedicated gymdrobe_staging_ name and select that same database in MONGO_URI.");
  check("test-payment-key", /^rzp_test_[A-Za-z0-9]+$/.test(value(env, "RAZORPAY_KEY_ID")), "Use a Razorpay Test Mode key ID; live and placeholder key IDs are blocked.");
  check("payment-secret", !placeholder(value(env, "RAZORPAY_KEY_SECRET")), "Configure the corresponding test key secret privately.");
  check("webhook-secret", !placeholder(value(env, "RAZORPAY_WEBHOOK_SECRET")), "Configure a separate test webhook secret privately.");
  check("jwt-secret", !placeholder(value(env, "JWT_SECRET")) && value(env, "JWT_SECRET").length >= 32, "Configure a dedicated staging JWT secret of at least 32 characters.");
  check("staging-frontend", stagingOrigin(value(env, "FRONTEND_URL")), "Use a staging HTTPS origin or loopback HTTP origin; known GymDrobe production origins are blocked.");
  check("push-disabled", ["PUSH_REGISTRATION_ENABLED", "PUSH_DELIVERY_ENABLED"].every(name => ["", "false"].includes(value(env, name).toLowerCase())), "Keep push registration and delivery disabled for payment staging.");
  check("whatsapp-disabled", ["", "false"].includes(value(env, "WHATSAPP_ORDER_DELIVERY_ENABLED").toLowerCase()), "Keep WhatsApp delivery disabled for payment staging.");
  check("email-disabled", ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"].every(name => !value(env, name)), "Leave Gmail sender credentials empty during the payment test.");
  check("marketing-disabled", !value(env, "META_CAPI_ACCESS_TOKEN"), "Leave the Meta CAPI access token empty during the payment test.");
  return {
    status: checks.every(item => item.status === "pass") ? "configuration-passed" : "blocked",
    checks,
    limitations: [
      "No network requests, database connection, writes, payment, refund, email or push send were performed.",
      "Key validity, database ownership/permissions/topology, webhook delivery and the end-to-end payment journey still require separate staging verification.",
      "Database names and URL syntax cannot prove isolation. Use an empty dedicated database, restricted credentials and a separate staging service.",
    ],
  };
}

function assertStagingIsolation(env) {
  const selected = mode(env);
  if (!selected || ["production", "development", "test"].includes(selected)) return;
  if (selected !== "staging") {
    throw Object.assign(new Error("GYMDROBE_ENV_INVALID"), { code: "GYMDROBE_ENV_INVALID" });
  }
  const result = inspectStagingConfiguration(env);
  if (result.status !== "configuration-passed") {
    throw Object.assign(new Error("STAGING_CONFIGURATION_BLOCKED: " + result.checks.filter(item => item.status === "blocked").map(item => item.id).join(", ")),
      { code: "STAGING_CONFIGURATION_BLOCKED" });
  }
}

module.exports = { inspectStagingConfiguration, assertStagingIsolation };
