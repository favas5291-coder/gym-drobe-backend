const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const apple = require("../utils/appleIdentity");
const User = require("../models/User");
const { appleLogin, appleChallenge } = require("../middleware/controllers/appleAuthController");

function response() { return { statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; }, set() {} }; }

test("Apple login fails closed before touching provider or account data when unconfigured", async () => {
  const before = process.env.APPLE_SIGN_IN_ENABLED;
  process.env.APPLE_SIGN_IN_ENABLED = "false";
  try {
    const res = response(); await appleChallenge({}, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "APPLE_UNAVAILABLE");
  } finally { if (before === undefined) delete process.env.APPLE_SIGN_IN_ENABLED; else process.env.APPLE_SIGN_IN_ENABLED = before; }
});

test("Apple verification checks signature, provider, audience, freshness, nonce and verified email", async () => {
  const before = global.fetch, previous = process.env.APPLE_CLIENT_ID;
  process.env.APPLE_CLIENT_ID = "com.gymdrobe.app";
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: "jwk" }), kid: "test-apple-key", alg: "RS256" };
  global.fetch = async (url) => { assert.equal(url, "https://appleid.apple.com/auth/keys"); return { ok: true, json: async () => ({ keys: [key] }) }; };
  const nonce = "a".repeat(64);
  const payload = { sub: "apple-user", email_verified: true, email: "person@privaterelay.appleid.com", nonce };
  function sign(overrides = {}, options = {}) { return jwt.sign({ ...payload, ...overrides }, privateKey, { algorithm: "RS256", keyid: key.kid, issuer: "https://appleid.apple.com", audience: "com.gymdrobe.app", expiresIn: "5m", ...options }); }
  try {
    assert.equal((await apple.verifyIdentity(sign(), nonce)).sub, "apple-user");
    await assert.rejects(apple.verifyIdentity(sign(), "b".repeat(64)));
    for (const value of [false, "false", null]) await assert.rejects(apple.verifyIdentity(sign({ email_verified: value }), nonce));
    for (const options of [{ audience: "wrong-app" }, { issuer: "https://evil.test" }, { expiresIn: -1 }]) await assert.rejects(apple.verifyIdentity(sign({}, options), nonce));
    await assert.rejects(apple.verifyIdentity(sign({ iat: Math.floor(Date.now() / 1000) - 1200 }, { expiresIn: 3600 }), nonce));
    await assert.rejects(apple.verifyIdentity(jwt.sign(payload, "attacker", { algorithm: "HS256" }), nonce));
    const wrong = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    await assert.rejects(apple.verifyIdentity(jwt.sign(payload, wrong.privateKey, { algorithm: "RS256", keyid: key.kid }), nonce));
  } finally { global.fetch = before; if (previous === undefined) delete process.env.APPLE_CLIENT_ID; else process.env.APPLE_CLIENT_ID = previous; }
});

test("Apple refresh tokens are encrypted and authenticated, and never serialized in a user response", () => {
  const before = process.env.APPLE_TOKEN_ENCRYPTION_KEY;
  process.env.APPLE_TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
  try {
    const encrypted = apple.encryptToken("private-provider-refresh-token");
    assert.ok(!encrypted.includes("private-provider"));
    assert.equal(apple.decryptToken(encrypted), "private-provider-refresh-token");
    const parts = encrypted.split("."); parts[1] = Buffer.alloc(16).toString("base64url");
    assert.throws(() => apple.decryptToken(parts.join(".")));
    const user = new User({ name: "Apple Customer", email: "person@privaterelay.appleid.com", appleId: "apple-user", appleRefreshToken: encrypted });
    assert.equal(user.validateSync(), undefined);
    assert.equal(user.toJSON().appleId, undefined);
    assert.equal(user.toJSON().appleRefreshToken, undefined);
  } finally { if (before === undefined) delete process.env.APPLE_TOKEN_ENCRYPTION_KEY; else process.env.APPLE_TOKEN_ENCRYPTION_KEY = before; }
});

test("Apple login never links another account by email and cannot replay without code exchange", async () => {
  const originals = { configured: apple.configured, exchange: apple.exchange, verifyIdentity: apple.verifyIdentity, encryptToken: apple.encryptToken, findOne: User.findOne, exists: User.exists };
  const secret = process.env.JWT_SECRET; process.env.JWT_SECRET = "apple-test-secret";
  const nonce = "a".repeat(64);
  let exchanges = 0;
  apple.configured = () => true;
  apple.exchange = async () => { if (++exchanges > 1) throw new Error("used code"); return { id_token: "provider-token", refresh_token: "refresh" }; };
  apple.verifyIdentity = async (token, actualNonce) => { assert.equal(actualNonce, nonce); return { sub: "apple-user", email: "existing@example.com" }; };
  apple.encryptToken = () => "encrypted";
  User.findOne = () => ({ select: async () => null });
  User.exists = async () => ({ _id: "existing" });
  const challenge = jwt.sign({ nonce }, process.env.JWT_SECRET, { audience: "gymdrobe-apple-login", expiresIn: "5m" });
  try {
    const first = response(); await appleLogin({ body: { code: "single-use", challenge } }, first);
    assert.equal(first.statusCode, 409); assert.equal(first.body.code, "APPLE_ACCOUNT_LINK_REQUIRED");
    const replay = response(); await appleLogin({ body: { code: "single-use", challenge } }, replay);
    assert.equal(replay.statusCode, 401);
    const wrongChallenge = response(); await appleLogin({ body: { code: "another", challenge: jwt.sign({ nonce }, process.env.JWT_SECRET, { audience: "gymdrobe-google-login" }) } }, wrongChallenge);
    assert.equal(wrongChallenge.statusCode, 401); assert.equal(exchanges, 2);
  } finally { Object.assign(apple, { configured: originals.configured, exchange: originals.exchange, verifyIdentity: originals.verifyIdentity, encryptToken: originals.encryptToken }); User.findOne = originals.findOne; User.exists = originals.exists; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});
