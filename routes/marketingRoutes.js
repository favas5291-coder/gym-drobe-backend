"use strict";

const crypto = require("node:crypto");
const express = require("express");

const {
  protect,
  adminOnly,
} = require("../middleware/authMiddleware");

const {
  customerAccess,
} = require("../middleware/customerAccess");

const {
  Config,
  Event,
} = require("../models/MarketingStore");

const Order = require("../models/Order");

const {
  customerFilter,
} = require("../utils/customerAccess");

const {
  objectId,
  siteOrigin,
  text,
} = require("../utils/marketing/rules");

const {
  DEFAULTS,
  EVENT_NAMES,
  EDITABLE_FIELDS,
  validateConfigPatch,
  getConfig,
  publicConfig,
  adminConfig,
  ready,
} = require("../utils/marketing/config");

const {
  getPreference,
  savePreference,
  captureAttribution,
} = require("../utils/marketing/consent");

const {
  reportShoppingEvent,
} = require("../utils/marketing/shoppingEvents");

const {
  financialReceipts,
} = require("../utils/marketing/events");

const {
  serveFeed,
  feedAvailable,
  catalogFeedUrl,
} = require("../utils/marketing/feed");

const router = express.Router();

const buckets = new Map();

const WINDOW_MS = 60000;
const MAX_BUCKETS = 10000;
const MAX_BODY_BYTES = 32768;

let lastSweep = 0;

const STATES = [
  "queued",
  "processing",
  "accepted",
  "browser-only",
  "suppressed",
  "expired",
  "failed",
];

const ERROR_CODES = new Set([
  "WORKER_LEASE_LOST",
  "ORDER_EVENT_QUEUE_UNAVAILABLE",
  "MARKETING_WORKER_UNAVAILABLE",
  "EVENT_DELIVERY_NEEDS_REVIEW",
  "CONFIGURATION_CHANGED",
  "CAPI_NOT_READY",
  "EVENT_DELIVERY_WINDOW_CLOSED",
  "RETRY_LIMIT_REACHED",
  "CONSENT_WITHDRAWN",
  "ORDER_OR_PRODUCT_POLICY_CHANGED",
  "PREFERENCE_OR_CONFIGURATION_CHANGED",
  "WORKER_STOPPED",
  "EVENT_PAYLOAD_INVALID",
  "EVENT_AMOUNT_INVALID",
  "EVENT_CURRENCY_INVALID",
  "EVENT_CONTENT_INVALID",
  "EVENT_ORDER_INVALID",
  "EVENT_MODEL_INVALID",
  "EVENT_MATCHING_UNAVAILABLE",
  "EVENT_SOURCE_INVALID",
  "META_CONNECTION_FAILED",
  "META_REQUEST_TIMEOUT",
  "PREFERENCE_CHANGED",
  "CATALOG_LEASE_LOST",
  "CATALOG_SIZE_LIMIT",
  "CATALOG_ROW_LIMIT",
  "CATALOG_PRODUCT_LIMIT",
  "CATALOG_DUPLICATE_ID",
  "CATALOG_BUILD_TIMEOUT",
  "CATALOG_CONFIGURATION_CHANGED",
  "CATALOG_BUILD_UNAVAILABLE",
]);

function fail(status, code, message) {
  throw Object.assign(new Error(message), {
    status,
    code,
    marketingRoute: true,
  });
}

function plain(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(
      Object.getPrototypeOf(value),
    )
  );
}

function safeCode(value) {
  if (value === "consent-withdrawn") {
    return "CONSENT_WITHDRAWN";
  }

  const allowed =
    typeof value === "string" &&
    (
      ERROR_CODES.has(value) ||
      /^META_(?:HTTP_)?\d{1,6}$/.test(value)
    );

  return allowed
    ? value
    : value
      ? "DETAILS_REDACTED"
      : "";
}

function date(value) {
  if (!value) return null;

  const parsed = new Date(value);

  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : null;
}

function apiFailure(req, res, error) {
  const exposed =
    error.marketingRoute === true ||
    error.code === "INVALID_MARKETING_CONFIGURATION";

  const saving =
    !["GET", "HEAD"].includes(req.method);

  return res
    .status(exposed ? error.status || 400 : 503)
    .json({
      success: false,

      code: exposed
        ? error.code
        : "MARKETING_API_UNAVAILABLE",

      message: exposed
        ? error.message
        : saving
          ? "The marketing change could not be confirmed. Reload its status before retrying. Shopping and payment remain available."
          : "Marketing information is unavailable. Please retry. Shopping and payment remain available.",

      ...(saving
        ? { saveResultUnknown: !exposed }
        : {}),
    });
}

const handle = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    return apiFailure(req, res, error);
  }
};

function limit(prefix, maximum, identify) {
  return (req, res, next) => {
    const now = Date.now();

    if (now - lastSweep >= WINDOW_MS) {
      for (const [key, value] of buckets) {
        if (value.until <= now) {
          buckets.delete(key);
        }
      }

      lastSweep = now;
    }

    const identity = String(
      identify(req) || "unknown",
    ).slice(0, 512);

    const key =
      prefix +
      crypto
        .createHash("sha256")
        .update(identity)
        .digest("hex");

    let bucket = buckets.get(key);

    if (!bucket || bucket.until <= now) {
      if (buckets.size >= MAX_BUCKETS) {
        return res.status(503).json({
          success: false,
          code: "MARKETING_RATE_LIMIT_UNAVAILABLE",
          message:
            "Optional marketing requests are temporarily unavailable. Shopping can continue.",
        });
      }

      bucket = {
        count: 0,
        until: now + WINDOW_MS,
      };

      buckets.set(key, bucket);
    }

    bucket.count++;

    if (bucket.count > maximum) {
      res.set(
        "Retry-After",
        String(
          Math.max(
            1,
            Math.ceil(
              (bucket.until - now) / 1000,
            ),
          ),
        ),
      );

      return res.status(429).json({
        success: false,
        code: "MARKETING_RATE_LIMITED",
        message:
          "Please wait before retrying optional marketing requests. Shopping can continue.",
      });
    }

    return next();
  };
}

const byIP = (req) =>
  req.ip ||
  req.socket?.remoteAddress ||
  "unknown";

const ipLimit = limit(
  "ip:",
  600,
  byIP,
);

const actionLimit = limit(
  "action:",
  120,
  (req) => {
    const token = req.get(
      "X-GymDrobe-Marketing",
    );

    return (
      typeof token === "string" &&
      /^mkt_[a-f0-9]{64}$/.test(token)
    )
      ? token
      : byIP(req);
  },
);

const preferenceLimit = limit(
  "preference:",
  60,
  byIP,
);

function storefrontWrite(req, res, next) {
  const allowed = new Set([
    siteOrigin(),
  ]);

  if (
    [
      "https://gymdrobe.com",
      "https://www.gymdrobe.com",
    ].includes(siteOrigin())
  ) {
    allowed.add("https://gymdrobe.com");
    allowed.add("https://www.gymdrobe.com");
  }

  const configured = String(
    process.env.MARKETING_ALLOWED_ORIGINS || "",
  ).split(",");

  for (const value of configured) {
    try {
      const url = new URL(value.trim());

      const local = [
        "localhost",
        "127.0.0.1",
        "[::1]",
      ].includes(url.hostname);

      if (
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        (
          url.protocol === "https:" ||
          (
            process.env.NODE_ENV !== "production" &&
            local &&
            url.protocol === "http:"
          )
        )
      ) {
        allowed.add(url.origin);
      }
    } catch {
      // Invalid configured origins are never allowed.
    }
  }

  if (
    !allowed.has(req.get("Origin"))
  ) {
    return res.status(403).json({
      success: false,
      code: "MARKETING_ORIGIN_DENIED",
      message:
        "Use the GymDrobe website to update marketing preferences or report shopping activity.",
    });
  }

  return next();
}

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  return next();
});

router.use(
  express.json({
    limit: MAX_BODY_BYTES,
    strict: true,
  }),
);

// server.js may already have parsed the body.
// Enforce the marketing limit here too.
router.use((req, res, next) => {
  if (
    req.body !== undefined &&
    Buffer.byteLength(
      JSON.stringify(req.body),
      "utf8",
    ) > MAX_BODY_BYTES
  ) {
    return res.status(413).json({
      success: false,
      code: "MARKETING_REQUEST_TOO_LARGE",
      message:
        "The marketing request is too large.",
    });
  }

  return next();
});

// Public configuration. Never returns the access token.
router.get(
  "/config",
  ipLimit,
  handle(async (req, res) => {
    return res.json({
      success: true,

      configuration: publicConfig(
        await getConfig(),
      ),
    });
  }),
);

// Advertising preferences are independent of login.
router.get(
  "/preferences",
  ipLimit,
  actionLimit,
  getPreference,
);

router.put(
  "/preferences",
  ipLimit,
  preferenceLimit,
  storefrontWrite,
  savePreference,
);

router.post(
  "/attribution",
  ipLimit,
  actionLimit,
  storefrontWrite,
  captureAttribution,
);

router.post(
  "/events",
  ipLimit,
  actionLimit,
  storefrontWrite,

  (req, res, next) => {
    // Product/cart events need no account.
    // Payment-information events require verified
    // account or guest access.
    return req.body?.eventName === "AddPaymentInfo"
      ? customerAccess(req, res, next)
      : next();
  },

  reportShoppingEvent,
);

router.get(
  "/orders/:id/events",
  ipLimit,
  actionLimit,
  customerAccess,

  handle(async (req, res) => {
    const input = req.params.id;

    let id = objectId(input);

    if (!id) {
      if (
        !/^GD-[A-Z0-9-]{1,80}$/i.test(input)
      ) {
        fail(
          400,
          "INVALID_MARKETING_ORDER",
          "Enter a valid order number.",
        );
      }

      const order = await Order.findOne({
        orderNumber: input.toUpperCase(),
        ...customerFilter(req),
      })
        .select("_id")
        .read("primary")
        .maxTimeMS(2000)
        .lean();

      id = order
        ? objectId(order)
        : "";
    }

    return res.json({
      success: true,

      receipts: id
        ? await financialReceipts(req, id)
        : [],
    });
  }),
);

// Public catalogue contains only the feed
// generator's explicit product fields.
router.get(
  "/catalog.csv",
  serveFeed,
);

// Every route under /admin requires an admin.
router.use(
  "/admin",
  ipLimit,
  protect,
  adminOnly,
);

router.get(
  "/admin/settings",

  handle(async (req, res) => {
    return res.json({
      success: true,

      configuration: adminConfig(
        await getConfig(),
      ),
    });
  }),
);

async function ensureConfig() {
  try {
    await Config.updateOne(
      {
        _id: "meta",
      },
      {
        $setOnInsert: {
          ...DEFAULTS,
          allowedEvents: [],
        },
      },
      {
        upsert: true,
        runValidators: true,
        maxTimeMS: 2000,
      },
    );
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
  }
}

router.put(
  "/admin/settings",

  handle(async (req, res) => {
    if (
      !plain(req.body) ||
      Object.keys(req.body).some(
        (key) =>
          !["revision", "settings"].includes(key),
      ) ||
      !Number.isSafeInteger(
        req.body.revision,
      ) ||
      req.body.revision < 0
    ) {
      fail(
        400,
        "INVALID_MARKETING_CONFIGURATION",
        "Send the current revision and the settings to save.",
      );
    }

    const patch = validateConfigPatch(
      req.body.settings,
    );

    if (patch.allowedEvents) {
      patch.allowedEvents.sort();
    }

    await ensureConfig();

    const current =
      await getConfig();

    if (
      current.revision !==
      req.body.revision
    ) {
      fail(
        409,
        "MARKETING_CONFIGURATION_CHANGED",
        "Settings changed. Reload before saving.",
      );
    }

    const changed =
      EDITABLE_FIELDS.some((key) => {
        if (
          !Object.hasOwn(patch, key)
        ) {
          return false;
        }

        const before =
          key === "allowedEvents"
            ? [...current.allowedEvents].sort()
            : current[key];

        return (
          JSON.stringify(before) !==
          JSON.stringify(patch[key])
        );
      });

    if (!changed) {
      return res.json({
        success: true,
        configuration:
          adminConfig(current),
        cleanupPending: false,
      });
    }

    if (
      !Number.isSafeInteger(
        current.revision + 1,
      ) ||
      !Number.isSafeInteger(
        current.epoch + 1,
      )
    ) {
      throw new Error(
        "CONFIGURATION_VERSION_LIMIT",
      );
    }

    const actor = objectId(
      req.user._id,
    );

    if (!actor) {
      fail(
        403,
        "ADMIN_ACCESS_REQUIRED",
        "A verified admin account is required.",
      );
    }

    const next = {
      ...current,
      ...patch,
      revision:
        current.revision + 1,
      epoch:
        current.epoch + 1,
    };

    const result =
      await Config.updateOne(
        {
          _id: "meta",
          revision:
            current.revision,
          epoch:
            current.epoch,
        },
        {
          $set: {
            ...patch,

            revision:
              next.revision,

            epoch:
              next.epoch,

            reviewedBy:
              next.policiesReviewed
                ? actor
                : null,

            reviewedAt:
              next.policiesReviewed
                ? new Date()
                : null,

            "feed.refreshAfter":
              new Date(0),
          },
        },
        {
          runValidators: true,
          maxTimeMS: 2000,
        },
      );

    if (
      result.matchedCount !== 1
    ) {
      fail(
        409,
        "MARKETING_CONFIGURATION_CHANGED",
        "Settings changed while saving. Reload before trying again.",
      );
    }

    let cleanupPending = false;

    try {
      await Event.updateMany(
        {
          state: {
            $in: [
              "queued",
              "processing",
              "browser-only",
            ],
          },

          "payload._gymdrobeEpoch": {
            $ne: next.epoch,
          },
        },
        {
          $set: {
            state: "suppressed",

            suppression:
              "CONFIGURATION_CHANGED",
          },

          $unset: {
            payload: 1,
            userData: 1,
            leaseUntil: 1,
          },
        },
        {
          maxTimeMS: 2000,
        },
      );
    } catch {
      cleanupPending = true;
    }

    return res.json({
      success: true,

      configuration: adminConfig(
        await getConfig(),
      ),

      cleanupPending,
    });
  }),
);

router.post(
  "/admin/catalog/refresh",

  handle(async (req, res) => {
    if (
      !plain(req.body) ||
      Object.keys(req.body).some(
        (key) => key !== "revision",
      ) ||
      !Number.isSafeInteger(
        req.body.revision,
      ) ||
      req.body.revision < 0
    ) {
      fail(
        400,
        "INVALID_CATALOG_REFRESH",
        "Send the current settings revision.",
      );
    }

    const config =
      await getConfig();

    if (
      !ready(config, "feed")
    ) {
      fail(
        409,
        "CATALOG_NOT_READY",
        "Complete the catalogue configuration before requesting a refresh.",
      );
    }

    if (
      config.revision !==
      req.body.revision
    ) {
      fail(
        409,
        "MARKETING_CONFIGURATION_CHANGED",
        "Reload the latest settings before refreshing.",
      );
    }

    if (
      !Number.isSafeInteger(
        config.revision + 1,
      )
    ) {
      throw new Error(
        "CONFIGURATION_VERSION_LIMIT",
      );
    }

    const requestedAt =
      new Date();

    // Changing revision prevents an older build
    // from overwriting this refresh request.
    // Epoch stays unchanged, preserving event scope.
    const result =
      await Config.updateOne(
        {
          _id: "meta",
          revision:
            config.revision,
          epoch:
            config.epoch,
        },
        {
          $set: {
            revision:
              config.revision + 1,

            "feed.refreshAfter":
              new Date(0),

            "feed.refreshRequestedAt":
              requestedAt,
          },
        },
        {
          maxTimeMS: 2000,
        },
      );

    if (
      result.matchedCount !== 1
    ) {
      fail(
        409,
        "MARKETING_CONFIGURATION_CHANGED",
        "Settings changed. Reload and retry.",
      );
    }

    return res.status(202).json({
      success: true,
      refreshRequested: true,
      requestedAt,
      revision:
        config.revision + 1,

      message:
        "Refresh requested. The background worker must complete it before the new feed is available.",
    });
  }),
);

router.get(
  "/admin/diagnostics",

  handle(async (req, res) => {
    const config =
      await getConfig();

    const since = new Date(
      Date.now() -
        7 * 86400000,
    );

    const filter = {
      datasetId:
        config.datasetId,

      testMode:
        config.testMode !== false,

      createdAt: {
        $gte: since,
      },
    };

    const [counts, recent] =
      await Promise.all([
        Event.aggregate([
          {
            $match: filter,
          },
          {
            $group: {
              _id: {
                name: "$eventName",
                state: "$state",
              },

              count: {
                $sum: 1,
              },
            },
          },
          {
            $limit: 100,
          },
        ])
          .read("primary")
          .option({
            maxTimeMS: 2000,
          })
          .exec(),

        Event.find(filter)
          .select(
            "eventId eventName eventTime state attempts acceptedAt errorCode suppression createdAt nextAttemptAt",
          )
          .sort({
            createdAt: -1,
          })
          .limit(30)
          .read("primary")
          .maxTimeMS(2000)
          .lean(),
      ]);

    const settings =
      adminConfig(config);

    const feed =
      config.feed || {};

    const feedUrl =
      catalogFeedUrl();

    const outstanding = [
      ...new Set(
        Object.values(
          settings.issues,
        ).flat(),
      ),
    ];

    if (!feedUrl) {
      outstanding.push(
        "Set PUBLIC_API_URL to the backend's public HTTPS URL.",
      );
    }

    if (
      !config.lastWorkerAt
    ) {
      outstanding.push(
        "Connect the marketing worker to server startup.",
      );
    }

    if (
      !feedAvailable(config)
    ) {
      outstanding.push(
        "Generate a fresh catalogue after reviewing products for advertising.",
      );
    }

    outstanding.push(
      "Verify test events and browser/server deduplication in Meta Events Manager.",
    );

    return res.json({
      success: true,

      diagnostics: {
        period: {
          since,

          scope:
            "Current dataset and test/live mode, including earlier configuration epochs.",
        },

        configuration:
          settings,

        worker: {
          lastCheckedAt:
            date(config.lastWorkerAt),

          lastError:
            safeCode(config.lastWorkerError),
        },

        eventCounts: counts
          .filter(
            (row) =>
              EVENT_NAMES.includes(
                row._id?.name,
              ) &&
              STATES.includes(
                row._id?.state,
              ),
          )
          .map((row) => ({
            eventName:
              row._id.name,

            state:
              row._id.state,

            count:
              Number.isSafeInteger(
                row.count,
              )
                ? row.count
                : 0,
          })),

        recentEvents:
          recent.map((row) => ({
            eventId:
              /^gd_e_[a-f0-9]{64}$/.test(
                row.eventId || "",
              )
                ? row.eventId
                : "",

            eventName:
              EVENT_NAMES.includes(
                row.eventName,
              )
                ? row.eventName
                : "Unknown",

            state:
              STATES.includes(
                row.state,
              )
                ? row.state
                : "unknown",

            eventTime:
              Number.isSafeInteger(
                row.eventTime,
              )
                ? row.eventTime
                : null,

            attempts:
              Number.isSafeInteger(
                row.attempts,
              )
                ? row.attempts
                : 0,

            createdAt:
              date(row.createdAt),

            acceptedAt:
              date(row.acceptedAt),

            nextAttemptAt:
              date(row.nextAttemptAt),

            errorCode:
              safeCode(row.errorCode),

            suppression:
              safeCode(row.suppression),
          })),

        catalog: {
          url: feedUrl,

          available: Boolean(
            feedAvailable(config),
          ),

          generatedAt:
            date(feed.generatedAt),

          refreshAfter:
            date(feed.refreshAfter),

          refreshRequestedAt:
            date(feed.refreshRequestedAt),

          lastAttemptAt:
            date(feed.lastAttemptAt),

          lastError:
            safeCode(feed.lastError),

          rowCount:
            Number.isSafeInteger(
              feed.rowCount,
            )
              ? feed.rowCount
              : 0,

          includedProducts:
            Number.isSafeInteger(
              feed.includedProducts,
            )
              ? feed.includedProducts
              : 0,

          excludedProducts:
            Number.isSafeInteger(
              feed.excludedProducts,
            )
              ? feed.excludedProducts
              : 0,

          validationIssueCount:
            Number.isSafeInteger(
              feed.validationIssueCount,
            )
              ? feed.validationIssueCount
              : 0,

          validationIssues: (
            Array.isArray(
              feed.validationIssues,
            )
              ? feed.validationIssues
              : []
          )
            .slice(0, 100)
            .map((row) => ({
              productId:
                objectId(row.productId),

              name:
                text(row.name, 200),

              issues: (
                Array.isArray(row.issues)
                  ? row.issues
                  : []
              )
                .slice(0, 20)
                .map(
                  (issue) =>
                    text(issue, 250),
                ),
            })),

          imageChecks:
            "url-validation-only",

          metaVerification:
            "not-verified",
        },

        verification: {
          apiAcceptance:
            "An accepted event means the API acknowledged it. It does not prove attribution or sales.",

          eventsManager:
            "not-verified",

          attributedSales:
            "not-verified",
        },

        outstandingSetup:
          outstanding,
      },
    });
  }),
);

router.use(
  (error, req, res, next) => {
    if (
      res.headersSent
    ) {
      return next(error);
    }

    if (
      error.type ===
      "entity.too.large"
    ) {
      return res.status(413).json({
        success: false,

        code:
          "MARKETING_REQUEST_TOO_LARGE",

        message:
          "The marketing request is too large.",
      });
    }

    if (
      error.type ===
      "entity.parse.failed"
    ) {
      return res.status(400).json({
        success: false,

        code:
          "INVALID_MARKETING_JSON",

        message:
          "Enter a valid JSON marketing request.",
      });
    }

    return apiFailure(
      req,
      res,
      error,
    );
  },
);

module.exports = router;