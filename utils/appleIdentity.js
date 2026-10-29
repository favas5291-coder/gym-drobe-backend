const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
let cachedKeys;
let keysExpire = 0;
let refreshing;

function configured() {
  return process.env.APPLE_SIGN_IN_ENABLED === "true" &&
    process.env.APPLE_CLIENT_ID === "com.gymdrobe.app" &&
    Boolean(process.env.JWT_SECRET && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY) &&
    /^[a-f\d]{64}$/i.test(process.env.APPLE_TOKEN_ENCRYPTION_KEY || "");
}
function clientSecret() {
  return jwt.sign({}, process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"), {
    algorithm: "ES256", keyid: process.env.APPLE_KEY_ID,
    issuer: process.env.APPLE_TEAM_ID, subject: process.env.APPLE_CLIENT_ID,
    audience: "https://appleid.apple.com", expiresIn: "5m",
  });
}
async function appleRequest(path, fields) {
  const response = await fetch(`https://appleid.apple.com/auth/${path}`, {
    method: "POST", signal: AbortSignal.timeout(12000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.APPLE_CLIENT_ID, client_secret: clientSecret(), ...fields }),
  }).catch(() => { throw Object.assign(new Error("Apple service unavailable."), { status: 503 }); });
  if (!response.ok) throw Object.assign(new Error("Apple authorization failed."), { status: response.status >= 500 ? 503 : 401 });
  return path === "revoke" ? null : response.json();
}
async function keys(force = false) {
  if (!force && cachedKeys && keysExpire > Date.now()) return cachedKeys;
  if (!refreshing) refreshing = (async () => {
    const response = await fetch("https://appleid.apple.com/auth/keys", { signal: AbortSignal.timeout(12000) }).catch(() => { throw Object.assign(new Error("Apple keys unavailable."), { status: 503 }); });
    if (!response.ok) throw Object.assign(new Error("Apple keys unavailable."), { status: 503 });
    const data = await response.json();
    if (!Array.isArray(data.keys)) throw new Error("Invalid Apple keys.");
    cachedKeys = data.keys; keysExpire = Date.now() + 3600000;
    return cachedKeys;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
async function verifyIdentity(token, nonce) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || decoded.header.alg !== "RS256" || typeof decoded.header.kid !== "string") throw new Error("Invalid Apple token.");
  let key = (await keys()).find((key) => key.kid === decoded.header.kid && key.kty === "RSA" && key.alg === "RS256");
  if (!key) key = (await keys(true)).find((key) => key.kid === decoded.header.kid && key.kty === "RSA" && key.alg === "RS256");
  if (!key) throw new Error("Unknown Apple signing key.");
  const publicKey = crypto.createPublicKey({ key, format: "jwk" });
  const claims = jwt.verify(token, publicKey, { algorithms: ["RS256"], issuer: "https://appleid.apple.com", audience: process.env.APPLE_CLIENT_ID, maxAge: "10m" });
  if (claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || ![true, "true"].includes(claims.email_verified)) throw new Error("Invalid Apple identity.");
  return claims;
}
function encryptToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(process.env.APPLE_TOKEN_ENCRYPTION_KEY, "hex"), iv);
  cipher.setAAD(Buffer.from("gymdrobe-apple-refresh-v1"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}
function decryptToken(value) {
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const cipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(process.env.APPLE_TOKEN_ENCRYPTION_KEY, "hex"), iv);
  cipher.setAAD(Buffer.from("gymdrobe-apple-refresh-v1")); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString("utf8");
}
module.exports = { configured, verifyIdentity, encryptToken, decryptToken,
  exchange: (code) => appleRequest("token", { code, grant_type: "authorization_code" }),
  revoke: (encrypted) => appleRequest("revoke", { token: decryptToken(encrypted), token_type_hint: "refresh_token" }) };
