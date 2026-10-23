"use strict";

const MAX_SUGGESTIONS = 3;
const MAX_CONFIGURED_PAIRS = 200;
const MAX_EXCLUDED_PRODUCTS = 500;

const MAX_SETTINGS_VERSION =
  Number.MAX_SAFE_INTEGER - 1;

const SETTINGS_FIELDS = Object.freeze([
  "version",
  "enabled",
  "useCategoryRules",
  "maxSuggestions",
  "excludedProductIds",
  "configuredPairs",
]);

const PAIR_FIELDS = Object.freeze([
  "sourceId",
  "productId",
  "enabled",
  "compatibilityConfirmed",
]);

function invalid(message) {
  const error = new Error(message);

  error.status = 400;
  error.code = "INVALID_CART_ADDON_SETTINGS";
  error.gymdrobe = true;

  return error;
}

function requireFields(
  value,
  fields,
  label,
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw invalid(
      `${label} must be an object.`,
    );
  }

  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      throw invalid(
        `${label} contains an unsupported field.`,
      );
    }
  }

  for (const key of fields) {
    if (
      !Object.prototype.hasOwnProperty.call(
        value,
        key,
      )
    ) {
      throw invalid(
        `Send the complete ${label.toLowerCase()}.`,
      );
    }
  }
}

function productId(
  value,
  label,
) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{24}$/i.test(
      value.trim(),
    )
  ) {
    throw invalid(
      `${label} must be a valid product ID.`,
    );
  }

  return value
    .trim()
    .toLowerCase();
}

function requireBoolean(
  value,
  label,
) {
  if (typeof value !== "boolean") {
    throw invalid(
      `${label} must be true or false.`,
    );
  }

  return value;
}

function defaultCartAddonSettings() {
  return {
    version: 0,
    enabled: false,
    useCategoryRules: true,
    maxSuggestions: MAX_SUGGESTIONS,
    excludedProductIds: [],
    configuredPairs: [],
  };
}

function normalizeCartAddonSettings(
  input,
) {
  requireFields(
    input,
    SETTINGS_FIELDS,
    "Cart add-on settings",
  );

  if (
    !Number.isSafeInteger(
      input.version,
    ) ||
    input.version < 0 ||
    input.version >
      MAX_SETTINGS_VERSION
  ) {
    throw invalid(
      "Load the current settings version before saving.",
    );
  }

  const enabled = requireBoolean(
    input.enabled,
    "Enabled",
  );

  const useCategoryRules =
    requireBoolean(
      input.useCategoryRules,
      "Use category rules",
    );

  if (
    !Number.isSafeInteger(
      input.maxSuggestions,
    ) ||
    input.maxSuggestions < 1 ||
    input.maxSuggestions >
      MAX_SUGGESTIONS
  ) {
    throw invalid(
      `Choose between 1 and ${MAX_SUGGESTIONS} suggestions.`,
    );
  }

  if (
    !Array.isArray(
      input.excludedProductIds,
    ) ||
    input.excludedProductIds.length >
      MAX_EXCLUDED_PRODUCTS
  ) {
    throw invalid(
      `Choose up to ${MAX_EXCLUDED_PRODUCTS} excluded products.`,
    );
  }

  const excludedProductIds =
    input.excludedProductIds.map(
      (value) =>
        productId(
          value,
          "Excluded product",
        ),
    );

  if (
    new Set(
      excludedProductIds,
    ).size !==
    excludedProductIds.length
  ) {
    throw invalid(
      "List each excluded product only once.",
    );
  }

  if (
    !Array.isArray(
      input.configuredPairs,
    ) ||
    input.configuredPairs.length >
      MAX_CONFIGURED_PAIRS
  ) {
    throw invalid(
      `Configure up to ${MAX_CONFIGURED_PAIRS} product pairings.`,
    );
  }

  const seen = new Set();

  const configuredPairs =
    input.configuredPairs.map(
      (pair) => {
        requireFields(
          pair,
          PAIR_FIELDS,
          "Product pairing",
        );

        const sourceId =
          productId(
            pair.sourceId,
            "Source product",
          );

        const targetId =
          productId(
            pair.productId,
            "Recommended product",
          );

        const pairEnabled =
          requireBoolean(
            pair.enabled,
            "Pairing enabled",
          );

        const compatibilityConfirmed =
          requireBoolean(
            pair.compatibilityConfirmed,
            "Compatibility confirmed",
          );

        if (
          sourceId === targetId
        ) {
          throw invalid(
            "A product cannot be its own add-on.",
          );
        }

        const key =
          `${sourceId}:${targetId}`;

        if (seen.has(key)) {
          throw invalid(
            "List each source and recommended product pairing only once.",
          );
        }

        seen.add(key);

        if (
          pairEnabled &&
          !compatibilityConfirmed
        ) {
          throw invalid(
            "Confirm product compatibility before enabling this pairing.",
          );
        }

        return {
          sourceId,
          productId: targetId,
          enabled: pairEnabled,
          compatibilityConfirmed,
        };
      },
    );

  // Exclusions take priority when recommendations are selected.
  // Disabled pairs suppress their source/product category relationship.
  // Pair order is retained as the admin's recommendation priority.
  return {
    version: input.version,
    enabled,
    useCategoryRules,
    maxSuggestions:
      input.maxSuggestions,
    excludedProductIds,
    configuredPairs,
  };
}

module.exports = {
  MAX_SUGGESTIONS,
  MAX_CONFIGURED_PAIRS,
  MAX_EXCLUDED_PRODUCTS,
  MAX_SETTINGS_VERSION,
  defaultCartAddonSettings,
  normalizeCartAddonSettings,
};