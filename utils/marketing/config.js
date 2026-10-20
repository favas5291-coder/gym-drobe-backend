"use strict";

const { Config } = require("../../models/MarketingStore");

const API_VERSION = "v26.0";

const EVENT_NAMES = Object.freeze([
  "PageView",
  "ViewContent",
  "AddToCart",
  "AddToWishlist",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Purchase",
  "OrderPlaced",
  "CODAdvancePaid",
]);

const FINANCIAL_EVENTS = Object.freeze([
  "Purchase",
  "OrderPlaced",
  "CODAdvancePaid",
]);

const COD_MODELS = Object.freeze([
  "delivered-collected",
  "order-acceptance",
]);

const BOOLEAN_FIELDS = Object.freeze([
  "enabled",
  "pixelEnabled",
  "capiEnabled",
  "feedEnabled",
  "testMode",
  "policiesReviewed",
]);

const DEFAULTS = Object.freeze({
  enabled: false,
  pixelEnabled: false,
  capiEnabled: false,
  feedEnabled: false,
  datasetId: "",
  apiVersion: API_VERSION,
  testMode: true,
  testEventCode: "",
  policiesReviewed: false,
  allowedEvents: Object.freeze([]),
  codModel: "delivered-collected",
  epoch: 0,
  revision: 0,
});

const EDITABLE_FIELDS = Object.freeze([
  ...BOOLEAN_FIELDS,
  "datasetId",
  "apiVersion",
  "testEventCode",
  "allowedEvents",
  "codModel",
]);

function invalid(message) {
  return Object.assign(new Error(message), {
    status: 400,
    code: "INVALID_MARKETING_CONFIGURATION",
  });
}

function validDataset(value) {
  return (
    typeof value === "string" &&
    /^\d{5,30}$/.test(value)
  );
}

function getAccessToken() {
  // Never include this value in API responses, URLs or logs.
  return String(
    process.env.META_CAPI_ACCESS_TOKEN || "",
  ).trim();
}

function validateConfigPatch(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw invalid(
      "Marketing settings must be an object.",
    );
  }

  const result = {};

  for (const [key, input] of Object.entries(value)) {
    if (!EDITABLE_FIELDS.includes(key)) {
      throw invalid(
        `Unsupported marketing setting: ${key}.`,
      );
    }

    if (BOOLEAN_FIELDS.includes(key)) {
      if (typeof input !== "boolean") {
        throw invalid(
          `${key} must be true or false.`,
        );
      }

      result[key] = input;
      continue;
    }

    if (key === "allowedEvents") {
      if (
        !Array.isArray(input) ||
        input.length > EVENT_NAMES.length ||
        input.some(
          (name) => !EVENT_NAMES.includes(name),
        )
      ) {
        throw invalid(
          "Choose only supported Meta event names.",
        );
      }

      result[key] = [...new Set(input)];
      continue;
    }

    if (typeof input !== "string") {
      throw invalid(`${key} must be text.`);
    }

    const text = input.trim();

    if (
      key === "datasetId" &&
      text &&
      !validDataset(text)
    ) {
      throw invalid(
        "Enter a valid numeric Meta Pixel/dataset ID.",
      );
    }

    if (
      key === "apiVersion" &&
      text !== API_VERSION
    ) {
      throw invalid(
        `This integration currently uses ${API_VERSION}.`,
      );
    }

    if (
      key === "testEventCode" &&
      text &&
      !/^[A-Za-z0-9_-]{1,100}$/.test(text)
    ) {
      throw invalid(
        "Enter a valid Meta test-event code without spaces.",
      );
    }

    if (
      key === "codModel" &&
      !COD_MODELS.includes(text)
    ) {
      throw invalid(
        "Choose a supported COD measurement model.",
      );
    }

    result[key] = text;
  }

  return result;
}

async function getConfig() {
  // Read the primary each time so disabled tracking
  // is not served from a cache.
  if (Config.db.readyState !== 1) {
    throw Object.assign(
      new Error(
        "Marketing settings are unavailable.",
      ),
      {
        code:
          "MARKETING_CONFIGURATION_UNAVAILABLE",
      },
    );
  }

  const row = await Config.findById("meta")
    .read("primary")
    .maxTimeMS(2000)
    .lean();

  return {
    ...DEFAULTS,
    ...(row || {}),

    allowedEvents: Array.isArray(row?.allowedEvents)
      ? row.allowedEvents.filter(
          (name) => EVENT_NAMES.includes(name),
        )
      : [],
  };
}

function configurationIssues(
  config,
  channel = "pixel",
) {
  if (
    !["pixel", "capi", "feed"].includes(channel)
  ) {
    throw invalid("Unknown marketing channel.");
  }

  const issues = [];

  if (config?.enabled !== true) {
    issues.push(
      "Marketing integration is disabled.",
    );
  }

  if (config?.policiesReviewed !== true) {
    issues.push(
      "Complete the Meta policy review.",
    );
  }

  if (!validDataset(config?.datasetId)) {
    issues.push(
      "Add a valid Pixel/dataset ID.",
    );
  }

  if (
    config?.[`${channel}Enabled`] !== true
  ) {
    issues.push(`${channel} is disabled.`);
  }

  if (
    channel !== "feed" &&
    !config?.allowedEvents?.some(
      (name) => EVENT_NAMES.includes(name),
    )
  ) {
    issues.push(
      "Enable only the event types permitted for your dataset.",
    );
  }

  if (channel === "capi") {
    if (
      config?.apiVersion !== API_VERSION
    ) {
      issues.push(
        "Check the Graph API version.",
      );
    }

    if (!getAccessToken()) {
      issues.push(
        "Set META_CAPI_ACCESS_TOKEN on the backend.",
      );
    }

    if (
      config?.testMode !== false &&
      !config?.testEventCode
    ) {
      issues.push(
        "Add the test-event code before sending server test events.",
      );
    }
  }

  return issues;
}

function ready(config, channel = "pixel") {
  return (
    configurationIssues(config, channel)
      .length === 0
  );
}

function publicConfig(config) {
  const pixelEnabled = ready(
    config,
    "pixel",
  );

  const capiEnabled = ready(
    config,
    "capi",
  );

  // Explicit public fields only.
  // Never spread the database document here.
  return {
    enabled: pixelEnabled || capiEnabled,
    pixelEnabled,
    capiEnabled,

    datasetId: pixelEnabled
      ? config.datasetId
      : "",

    testMode: config?.testMode !== false,

    allowedEvents:
      pixelEnabled || capiEnabled
        ? [
            ...new Set(
              config.allowedEvents.filter(
                (name) =>
                  EVENT_NAMES.includes(name),
              ),
            ),
          ]
        : [],
  };
}

function adminConfig(config) {
  const result = {};

  for (const key of Object.keys(DEFAULTS)) {
    result[key] =
      config?.[key] ?? DEFAULTS[key];
  }

  return {
    ...result,

    accessTokenConfigured:
      Boolean(getAccessToken()),

    issues: {
      pixel: configurationIssues(
        config,
        "pixel",
      ),

      capi: configurationIssues(
        config,
        "capi",
      ),

      feed: configurationIssues(
        config,
        "feed",
      ),
    },
  };
}

function graphEventsUrl(config) {
  if (
    !validDataset(config?.datasetId) ||
    config?.apiVersion !== API_VERSION
  ) {
    throw invalid(
      "Meta API configuration is incomplete.",
    );
  }

  return (
    `https://graph.facebook.com/` +
    `${API_VERSION}/` +
    `${config.datasetId}/events`
  );
}

module.exports = {
  API_VERSION,
  EVENT_NAMES,
  FINANCIAL_EVENTS,
  COD_MODELS,
  DEFAULTS,
  EDITABLE_FIELDS,
  validateConfigPatch,
  getAccessToken,
  getConfig,
  configurationIssues,
  ready,
  publicConfig,
  adminConfig,
  graphEventsUrl,
};