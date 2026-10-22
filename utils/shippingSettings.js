"use strict";

const LIST_FIELDS = Object.freeze({
  eligibleProductIds: 500,
  eligibleCategories: 100,
  eligiblePincodes: 10000,
  excludedProductIds: 500,
  excludedCategories: 100,
  excludedPincodes: 10000,
});

function defaultShippingSettings() {
  return {
    version: 0,

    freeShipping: {
      enabled: true,
      minimumSubtotalPaise: 50000,

      eligibleProductIds: [],
      eligibleCategories: [],
      eligiblePincodes: [],

      excludedProductIds: [],
      excludedCategories: [],
      excludedPincodes: [],

      additionalChargesNotice:
        "Express delivery is charged separately.",
    },
  };
}

function invalid(message) {
  throw Object.assign(
    new Error(message),
    {
      status: 400,
      code: "INVALID_SHIPPING_SETTINGS",
    },
  );
}

function object(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    invalid(`${label} must be an object.`);
  }

  if (
    Object.keys(value).some(
      (key) => !keys.includes(key),
    )
  ) {
    invalid(
      `${label} contains unsupported fields.`,
    );
  }

  if (
    keys.some(
      (key) => !Object.hasOwn(value, key),
    )
  ) {
    invalid(
      `${label} is incomplete. Reload the settings before saving.`,
    );
  }
}

function text(
  value,
  maximum,
  label,
  allowEmpty = false,
) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.trim().length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(
      `${label} must be valid text of at most ${maximum} characters.`,
    );
  }

  return value.trim();
}

function normalizeShippingSettings(value) {
  object(
    value,
    ["version", "freeShipping"],
    "Shipping settings",
  );

  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    value.version >= Number.MAX_SAFE_INTEGER
  ) {
    invalid(
      "Include the version returned when loading shipping settings.",
    );
  }

  const offer = value.freeShipping;

  object(
    offer,
    [
      "enabled",
      "minimumSubtotalPaise",
      ...Object.keys(LIST_FIELDS),
      "additionalChargesNotice",
    ],
    "Free shipping",
  );

  if (
    typeof offer.enabled !== "boolean"
  ) {
    invalid(
      "Free shipping must be enabled or disabled with a boolean value.",
    );
  }

  if (
    !Number.isSafeInteger(
      offer.minimumSubtotalPaise,
    ) ||
    offer.minimumSubtotalPaise < 0 ||
    offer.minimumSubtotalPaise > 100000000
  ) {
    invalid(
      "The minimum purchase must be between ₹0 and ₹10,00,000, in whole paise.",
    );
  }

  const result = {
    enabled: offer.enabled,

    minimumSubtotalPaise:
      offer.minimumSubtotalPaise,
  };

  for (
    const [key, maximum] of
    Object.entries(LIST_FIELDS)
  ) {
    if (
      !Array.isArray(offer[key]) ||
      offer[key].length > maximum
    ) {
      invalid(
        `${key} must be a list with at most ${maximum} entries.`,
      );
    }

    result[key] = Array.from(
      offer[key],
      (entry) => {
        const cleaned = text(
          entry,
          100,
          key,
        );

        if (
          key.endsWith("ProductIds")
        ) {
          if (
            !/^[a-f0-9]{24}$/i.test(cleaned)
          ) {
            invalid(
              `${key} contains an invalid product ID.`,
            );
          }

          return cleaned.toLowerCase();
        }

        if (
          key.endsWith("Pincodes") &&
          !/^[1-9]\d{5}$/.test(cleaned)
        ) {
          invalid(
            `${key} contains an invalid delivery pincode.`,
          );
        }

        return cleaned;
      },
    );

    const keys = result[key].map(
      (entry) => entry.toLowerCase(),
    );

    if (
      new Set(keys).size !== keys.length
    ) {
      invalid(
        `${key} contains duplicate entries.`,
      );
    }
  }

  for (
    const suffix of [
      "ProductIds",
      "Categories",
      "Pincodes",
    ]
  ) {
    const excluded = new Set(
      result[`excluded${suffix}`].map(
        (entry) => entry.toLowerCase(),
      ),
    );

    if (
      result[`eligible${suffix}`].some(
        (entry) =>
          excluded.has(
            entry.toLowerCase(),
          ),
      )
    ) {
      invalid(
        `The same ${suffix.toLowerCase()} cannot be both eligible and excluded.`,
      );
    }
  }

  result.additionalChargesNotice = text(
    offer.additionalChargesNotice,
    500,
    "Additional charges notice",
    true,
  );

  return {
    version: value.version,
    freeShipping: result,
  };
}

module.exports = {
  LIST_FIELDS,
  defaultShippingSettings,
  normalizeShippingSettings,
};