const mongoose = require("mongoose");
const User = require("../../models/User");
const Address = require("../../models/Address");
const Review = require("../../models/Review");
const SupportTicket = require("../../models/SupportTicket");
const apple = require("../../utils/appleIdentity");

function policy() {
  const notice = (process.env.ACCOUNT_ORDER_RETENTION_NOTICE || "").trim();
  return { enabled: process.env.ACCOUNT_DELETION_ENABLED === "true" && notice.length >= 40,
    retentionNotice: notice };
}
function deletionPolicy(req, res) {
  const settings = policy();
  return res.json({ success: true, enabled: settings.enabled, retentionNotice: settings.enabled ? settings.retentionNotice : "" });
}
async function deleteAccount(req, res) {
  if (!policy().enabled) return res.status(503).json({ success: false, code: "DELETION_UNAVAILABLE", message: "Account deletion is awaiting the store’s data-retention configuration. Please contact GymDrobe support." });
  if (req.user.role !== "customer") return res.status(403).json({ success: false, message: "Store staff accounts require administrator assistance." });
  if (req.body?.confirmation !== "DELETE") return res.status(400).json({ success: false, message: "Type DELETE to confirm permanent account deletion." });
  const age = Date.now() / 1000 - req.authIssuedAt;
  if (!Number.isFinite(age) || age < -30 || age > 600) return res.status(401).json({ success: false, code: "REAUTH_REQUIRED", message: "Sign out and sign in again, then confirm deletion within 10 minutes." });
  let session;
  try {
    const customer = await User.findById(req.user._id).select("+appleRefreshToken");
    if (!customer) return res.status(401).json({ success: false, message: "Your account no longer exists." });
    // Revocation is idempotent. Fail before deleting data if Apple is unavailable.
    if (customer.appleRefreshToken) {
      if (!apple.configured()) throw new Error("Apple revocation configuration missing");
      await apple.revoke(customer.appleRefreshToken);
    }
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // Keep immutable financial/fulfillment records under the configured retention
      // policy. Do not delete unpaid/paid orders or alter stock/payment state.
      await Address.deleteMany({ user: customer._id }, { session });
      await Review.deleteMany({ user: customer._id }, { session });
      await SupportTicket.deleteMany({ user: customer._id }, { session });
      await User.deleteOne({ _id: customer._id, role: "customer" }, { session });
    });
    return res.json({ success: true, deleted: true, retentionNotice: policy().retentionNotice });
  } catch {
    return res.status(503).json({ success: false, code: "DELETION_FAILED", message: "Deletion could not complete. Please retry. Your order and payment records have not been changed." });
  } finally { if (session) await session.endSession(); }
}
module.exports = { deletionPolicy, deleteAccount };
