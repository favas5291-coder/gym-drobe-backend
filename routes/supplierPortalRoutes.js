"use strict";

const express = require("express");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  createSupplierPortalRateLimit,
} = require("../middleware/supplierPortalRateLimit");

const {
  createSupplierPortalHandlers,
} = require("../middleware/controllers/supplierPortalController");

function createSupplierPortalRouter({
  authenticate = protect,

  requireAdmin = adminOnly,

  rateLimit = createSupplierPortalRateLimit(),

  handlers = createSupplierPortalHandlers(),

  enabled = () =>
    process.env.SUPPLIER_PORTAL_ENABLED === "true",
} = {}) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");

    if (!enabled()) {
      return res.status(404).json({
        success: false,
        code: "SUPPLIER_PORTAL_DISABLED",
        message:
          "Supplier onboarding is not open yet.",
      });
    }

    return next();
  });

  router.use(
    authenticate,
    rateLimit
  );

  router.get(
    "/me",
    handlers.me
  );

  router.post(
    "/applications",
    handlers.apply
  );

  router.put(
    "/me/profile",
    handlers.profile
  );

  router.post(
    "/invitations/claim",
    handlers.claim
  );

  router.post(
    "/me/accept-terms",
    handlers.accept
  );

  router.get(
    "/me/history",
    handlers.history
  );

  router.use(
    "/admin",
    requireAdmin
  );

  router.get(
    "/admin/workspaces",
    handlers.adminList
  );

  router.post(
    "/admin/invitations",
    handlers.adminInvite
  );

  router.get(
    "/admin/workspaces/:id",
    handlers.adminGet
  );

  router.post(
    "/admin/workspaces/:id/invitation",
    handlers.adminInvite
  );

  router.post(
    "/admin/workspaces/:id/terms",
    handlers.adminOffer
  );

  router.patch(
    "/admin/workspaces/:id/status",
    handlers.adminStatus
  );

  router.get(
    "/admin/workspaces/:id/history",
    handlers.adminHistory
  );

  return router;
}

module.exports = {
  createSupplierPortalRouter,
};