"use strict";

const {
  createSupplierPortalService,
} = require("../../utils/supplierPortalService");

function sendError(res, error) {
  if (
    error.code === 11000 ||
    [
      "VersionError",
      "DocumentNotFoundError",
    ].includes(error.name)
  ) {
    return res.status(409).json({
      success: false,
      code: "SUPPLIER_CHANGED",
      message:
        "This supplier record already exists or changed. Reload it before retrying.",
    });
  }

  if (
    error.name === "ValidationError" ||
    error.name === "StrictModeError"
  ) {
    return res.status(400).json({
      success: false,
      code: "INVALID_SUPPLIER_INPUT",
      message:
        "Check the supplier details and required fields.",
    });
  }

  const known =
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status < 500 &&
    typeof error.code === "string";

  return res
    .status(known ? error.status : 503)
    .json({
      success: false,

      code: known
        ? error.code
        : "SUPPLIER_PORTAL_UNAVAILABLE",

      message: known
        ? error.message
        : "The result could not be confirmed. Reload the supplier record before trying again.",
    });
}

function createSupplierPortalHandlers(
  service = createSupplierPortalService()
) {
  const handler =
    (fn, status = 200) =>
    async (req, res) => {
      try {
        return res.status(status).json({
          success: true,
          ...(await fn(req)),
        });
      } catch (error) {
        return sendError(res, error);
      }
    };

  return {
    me: handler(async (req) => ({
      workspace: await service.get(req.user),
    })),

    apply: handler(
      async (req) => ({
        workspace: await service.apply(
          req.user,
          req.body
        ),
      }),
      201
    ),

    profile: handler(async (req) => ({
      workspace: await service.updateProfile(
        req.user,
        req.body
      ),
    })),

    claim: handler(async (req) => ({
      workspace: await service.claim(
        req.user,
        req.body
      ),
    })),

    accept: handler(async (req) => ({
      workspace: await service.accept(
        req.user,
        req.body
      ),
    })),

    history: handler((req) =>
      service.history(
        req.user,
        undefined,
        req.query.page
      )
    ),

    adminList: handler((req) =>
      service.list(
        req.user,
        req.query
      )
    ),

    adminGet: handler(async (req) => ({
      workspace: await service.get(
        req.user,
        req.params.id
      ),
    })),

    adminInvite: handler((req) =>
      service.invite(
        req.user,
        req.body,
        req.params.id
      )
    ),

    adminOffer: handler(async (req) => ({
      workspace: await service.offer(
        req.user,
        req.params.id,
        req.body
      ),
    })),

    adminStatus: handler(async (req) => ({
      workspace: await service.setStatus(
        req.user,
        req.params.id,
        req.body
      ),
    })),

    adminHistory: handler((req) =>
      service.history(
        req.user,
        req.params.id,
        req.query.page
      )
    ),
  };
}

module.exports = {
  createSupplierPortalHandlers,
};