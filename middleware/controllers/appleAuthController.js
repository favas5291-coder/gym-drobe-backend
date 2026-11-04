const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const apple = require("../../utils/appleIdentity");
const { sendSession } = require("./authController");

function fail(res, status, code, message) { return res.status(status).json({ success: false, code, message }); }
function available(res) {
  if (apple.configured()) return true;
  fail(res, 503, "APPLE_UNAVAILABLE", "Apple sign-in is awaiting configuration. Continue as a guest or use Google.");
  return false;
}
async function appleChallenge(req, res) {
  if (!available(res)) return;
  const nonce = crypto.randomBytes(32).toString("hex");
  const challenge = jwt.sign({ nonce }, process.env.JWT_SECRET, { algorithm: "HS256", audience: "gymdrobe-apple-login", expiresIn: "5m" });
  return res.json({ success: true, nonce, challenge });
}
async function appleLogin(req, res) {
  if (!available(res)) return;
  const { code, challenge, name } = req.body || {};
  if (typeof code !== "string" || !code || code.length > 4096 || typeof challenge !== "string" || challenge.length > 2000) return fail(res, 400, "SIGNIN_RESTART_REQUIRED", "Start a new Apple sign-in attempt.");
  let attempt;
  try {
    attempt = jwt.verify(challenge, process.env.JWT_SECRET, { algorithms: ["HS256"], audience: "gymdrobe-apple-login" });
    if (!/^[a-f\d]{64}$/.test(attempt.nonce)) throw new Error("nonce");
  } catch { return fail(res, 401, "SIGNIN_RESTART_REQUIRED", "Your Apple sign-in attempt expired. Start again."); }
  try {
    // Apple's single-use authorization code prevents replay, including across backend instances.
    const tokens = await apple.exchange(code);
    const claims = await apple.verifyIdentity(tokens.id_token, attempt.nonce);
    if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) throw new Error("Apple refresh token missing");
    let user = await User.findOne({ appleId: claims.sub }).select("+appleId +authVersion");
    if (user?.isActive === false) return fail(res, 403, "ACCOUNT_DISABLED", "This account is disabled. Contact support.");
    const encrypted = apple.encryptToken(tokens.refresh_token);
    if (user) {
      user = await User.findOneAndUpdate({ _id: user._id, isActive: { $ne: false } }, { $set: { appleRefreshToken: encrypted } }, { new: true, runValidators: true }).select("+authVersion");
      if (!user) return fail(res, 409, "ACCOUNT_CHANGED", "Your account changed. Start sign-in again.");
    } else {
      const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
      if (email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, "APPLE_EMAIL_INVALID", "Apple did not provide a verified email address.");
      // Never silently link a Google/admin account by an email claim from another provider.
      if (await User.exists({ email })) return fail(res, 409, "APPLE_ACCOUNT_LINK_REQUIRED", "You already have a GymDrobe account with this email. Use your existing sign-in method. Contact support to link Apple.");
      const displayName = typeof name === "string" && name.trim().length >= 2 ? name.trim().slice(0, 60) : "GymDrobe Customer";
      user = await User.create({ name: displayName, email, appleId: claims.sub, appleRefreshToken: encrypted, role: "customer" });
    }
    return sendSession(res, user);
  } catch (error) {
    if (error.code === 11000) return fail(res, 409, "ACCOUNT_CHANGED", "Your account changed. Start sign-in again.");
    // Provider responses and tokens must never enter logs.
    return fail(res, error.status === 503 || error.name === "TimeoutError" ? 503 : 401, "APPLE_VERIFICATION_FAILED", "Apple sign-in could not be verified. Please start again.");
  }
}
module.exports = { appleChallenge, appleLogin };
