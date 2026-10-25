"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { once } = require("node:events");

const express = require("express");
const jwt = require("jsonwebtoken");

const {
  createSupplierPortalRouter,
} = require("../routes/supplierPortalRoutes");

const {
  createSupplierPortalHandlers,
} = require(
  "../middleware/controllers/supplierPortalController",
);

const {
  createSupplierPortalService,
} = require("../utils/supplierPortalService");

const {
  createSupplierPortalRateLimit,
} = require("../middleware/supplierPortalRateLimit");

const {
  memoryStore,
} = require("./helpers/supplierPortalStore.cjs");

// Test fixtures only.
const secret =
  "supplier-http-test-secret-never-used-outside-tests";

const users = [
  {
    _id: "507f1f77bcf86cd799439011",
    email: "supplier@example.test",
    role: "customer",
    isActive: true,
    authVersion: 0,
  },

  {
    _id: "507f1f77bcf86cd799439012",
    email: "admin@example.test",
    role: "admin",
    isActive: true,
    authVersion: 0,
  },

  {
    _id: "507f1f77bcf86cd799439013",
    email: "other@example.test",
    role: "customer",
    isActive: true,
    authVersion: 0,
  },
];

// Every token claims admin so the tests verify that current
// database roles control access rather than the token's role.
const tokens = users.map((user) =>
  jwt.sign(
    {
      userId: user._id,
      authVersion: 0,
      role: "admin",
    },
    secret,
  ),
);

function authentication() {
  const filename = path.resolve(
    __dirname,
    "../middleware/authMiddleware.js",
  );

  const base = createRequire(filename);
  const module = { exports: {} };

  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,

      require: (name) =>
        name === "../models/User"
          ? {
              findById(id) {
                return {
                  select: async () =>
                    users.find(
                      (user) => user._id === id,
                    ) || null,
                };
              },
            }
          : base(name),

      process: {
        env: {
          JWT_SECRET: secret,
        },
      },

      console,
    },
  );

  return module.exports;
}

async function http(
  t,
  {
    enabled = true,
    service,
  } = {},
) {
  const auth = authentication();
  const store = memoryStore();

  const actualService =
    service ||
    createSupplierPortalService({
      ...store,

      now: () =>
        new Date("2026-10-24T12:00:00Z"),
    });

  const app = express();

  app.use(
    express.json({
      limit: "100kb",
    }),
  );

  app.use(
    "/api/supplier-portal",
    createSupplierPortalRouter({
      authenticate: auth.protect,
      requireAdmin: auth.adminOnly,

      rateLimit: (req, res, next) => next(),

      enabled: () => enabled,

      handlers:
        createSupplierPortalHandlers(
          actualService,
        ),
    }),
  );

  const server = app.listen(
    0,
    "127.0.0.1",
  );

  await once(server, "listening");

  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );

  const request = async (
    route,
    {
      token,
      method = "GET",
      body,
    } = {},
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/supplier-portal${route}`,
      {
        method,

        headers: {
          ...(token
            ? {
                Authorization: `Bearer ${token}`,
              }
            : {}),

          "Content-Type": "application/json",
        },

        body:
          body === undefined
            ? undefined
            : JSON.stringify(body),
      },
    );

    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  };

  return {
    request,
    store,
  };
}

test(
  "portal routes enforce real JWT verification, current DB roles and no-store responses",
  async (t) => {
    const { request } = await http(t);

    assert.equal(
      (await request("/me")).status,
      401,
    );

    assert.equal(
      (
        await request("/me", {
          token: "forged",
        })
      ).status,
      401,
    );

    assert.equal(
      (
        await request("/admin/workspaces", {
          token: tokens[0],
        })
      ).status,
      403,
    );

    const admin = await request(
      "/admin/workspaces",
      {
        token: tokens[1],
      },
    );

    assert.equal(
      admin.status,
      200,
    );

    assert.equal(
      admin.headers.get("cache-control"),
      "no-store",
    );

    assert.deepEqual(
      admin.body.workspaces,
      [],
    );

    const stale = jwt.sign(
      {
        userId: users[0]._id,
        authVersion: 1,
      },
      secret,
    );

    assert.equal(
      (
        await request("/me", {
          token: stale,
        })
      ).status,
      401,
    );
  },
);

test(
  "HTTP application, offer, acceptance and approval preserve ownership and exact terms",
  async (t) => {
    const { request } = await http(t);

    const profile = {
      legalName: "Test Fitness",
      contactName: "Test Owner",
      phone: "918888888888",
      gstin: "",

      dispatchAddress: {
        addressLine: "123 Test Street",
        city: "Kozhikode",
        state: "Kerala",
        pincode: "673001",
        country: "IN",
      },
    };

    let response = await request(
      "/applications",
      {
        token: tokens[0],
        method: "POST",
        body: { profile },
      },
    );

    assert.equal(
      response.status,
      201,
    );

    const id = response.body.workspace.id;

    const terms = {
      title: "Trial offer",

      text:
        "Fixture commercial terms. No automatic renewal or commission increase.",

      commissionBps: 500,
      shippingResponsibility: "supplier",
      gatewayFeeResponsibility: "gymdrobe",

      returnResponsibility:
        "Agreed responsibility for eligible returns.",

      effectiveFrom: "2026-10-24T12:00:00Z",
      offerExpiresAt: "2026-10-31T12:00:00Z",
    };

    response = await request(
      `/admin/workspaces/${id}/terms`,
      {
        token: tokens[1],
        method: "POST",

        body: {
          revision:
            response.body.workspace.revision,

          terms,
        },
      },
    );

    assert.equal(
      response.status,
      200,
    );

    const offered = response.body.workspace;

    const body = {
      revision: offered.revision,
      agreementId: offered.offeredAgreement.id,
      digest: offered.offeredAgreement.digest,
      signerName: "Test Owner",
      accepted: true,
      authorized: true,
    };

    assert.equal(
      (
        await request("/me/accept-terms", {
          token: tokens[2],
          method: "POST",
          body,
        })
      ).status,
      404,
    );

    response = await request(
      "/me/accept-terms",
      {
        token: tokens[0],
        method: "POST",
        body,
      },
    );

    assert.equal(
      response.status,
      200,
    );

    assert.equal(
      response.body.workspace.status,
      "pending-verification",
    );

    response = await request(
      `/admin/workspaces/${id}/status`,
      {
        token: tokens[1],
        method: "PATCH",

        body: {
          revision:
            response.body.workspace.revision,

          status: "approved",

          reason:
            "Reviewed applicable business documents",
        },
      },
    );

    assert.equal(
      response.status,
      200,
    );

    assert.equal(
      response.body.workspace
        .acceptedAgreement.terms.commissionBps,
      500,
    );

    assert.equal(
      response.body.workspace
        .capabilities.orderRouting,
      false,
    );

    assert.equal(
      response.body.workspace.supplier.status,
      "draft",
    );

    assert.equal(
      (
        await request(
          "/me?ownerUser=" + users[0]._id,
          {
            token: tokens[2],
          },
        )
      ).status,
      404,
    );

    const history = await request(
      "/me/history",
      {
        token: tokens[0],
      },
    );

    assert.equal(
      history.body.events.length,
      4,
    );

    assert.equal(
      JSON.stringify(
        response.body,
      ).includes("tokenHash"),
      false,
    );
  },
);

test(
  "feature flag fails closed before authentication and service errors never expose internal details",
  async (t) => {
    const disabled = await http(t, {
      enabled: false,
    });

    const response = await disabled.request(
      "/me",
      {
        token: tokens[0],
      },
    );

    assert.equal(
      response.status,
      404,
    );

    assert.equal(
      response.body.code,
      "SUPPLIER_PORTAL_DISABLED",
    );

    const failed = await http(t, {
      service: {
        get() {
          throw new Error(
            "Internal database credentials and private details",
          );
        },
      },
    });

    const failure = await failed.request(
      "/me",
      {
        token: tokens[0],
      },
    );

    assert.equal(
      failure.status,
      503,
    );

    assert.equal(
      JSON.stringify(
        failure.body,
      ).includes("credentials"),
      false,
    );
  },
);

test(
  "shared rate limits span instances and reset by time window; database failures block access",
  async () => {
    let time = 0;

    const counts = new Map();

    const model = {
      findOneAndUpdate(filter) {
        return {
          lean: async () => {
            const count =
              (counts.get(filter._id) || 0) + 1;

            counts.set(
              filter._id,
              count,
            );

            return { count };
          },
        };
      },
    };

    const first = createSupplierPortalRateLimit({
      model,
      clock: () => time,
    });

    const second = createSupplierPortalRateLimit({
      model,
      clock: () => time,
    });

    const req = {
      method: "POST",
      user: users[0],
    };

    let allowed = 0;

    const res = {
      statusCode: 200,

      set() {},

      status(value) {
        this.statusCode = value;
        return this;
      },

      json() {},
    };

    for (let i = 0; i < 31; i++) {
      await (i % 2 ? first : second)(
        req,
        res,
        () => allowed++,
      );
    }

    assert.equal(allowed, 30);
    assert.equal(res.statusCode, 429);

    time = 15 * 60000;

    await second(
      req,
      res,
      () => allowed++,
    );

    assert.equal(allowed, 31);

    const unavailable =
      createSupplierPortalRateLimit({
        model: {
          findOneAndUpdate() {
            throw new Error("Unavailable");
          },
        },
      });

    await unavailable(
      req,
      res,
      () => assert.fail("Must fail closed"),
    );

    assert.equal(
      res.statusCode,
      503,
    );
  },
);