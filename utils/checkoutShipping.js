"use strict";

const ShippingSettings = require("../models/ShippingSettings");

const {
  defaultShippingSettings,
  normalizeShippingSettings,
} = require("./shippingSettings");

const {
  STANDARD_SHIPPING,
  EXPRESS_SHIPPING,
} = require("./orderPricing");

function fail(status, code, message) {
  throw Object.assign(new Error(message), {
    status,
    code,
    gymdrobe: true,
  });
}

async function loadShippingSettings() {
  try {
    const stored = await ShippingSettings.findById("store")
      .lean()
      .maxTimeMS(5000);

    return stored
      ? normalizeShippingSettings({
          version: stored.version,
          freeShipping: stored.freeShipping,
        })
      : defaultShippingSettings();
  } catch {
    fail(
      503,
      "SHIPPING_SETTINGS_UNAVAILABLE",
      "Delivery charges could not be checked. Please retry before paying.",
    );
  }
}

function paise(value) {
  const result = Math.round(value * 100);

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(result) ||
    Math.abs(value * 100 - result) > 0.00001
  ) {
    fail(
      409,
      "INVALID_AMOUNT",
      "The order amounts need review. Refresh checkout before paying.",
    );
  }

  return result;
}

// Call only with items, products and pricing calculated by the backend.
// The flat standard-delivery fee is waived only when every item qualifies.
// Kit parcel charges are calculated separately by the verified shipping flow.
function priceCheckoutShipping({
  settings,
  pricing,
  items,
  products,
  deliveryMethod = "standard",
  paymentMethod = "razorpay",
  pincode = "",
}) {
  if (
    !["standard", "express"].includes(deliveryMethod) ||
    !["razorpay", "cod-partial"].includes(paymentMethod) ||
    !Array.isArray(items) ||
    !items.length ||
    !Array.isArray(products) ||
    items.some(
      (item) =>
        item?.kit ||
        Object.hasOwn(item || {}, "kitGroup"),
    )
  ) {
    fail(
      400,
      "INVALID_CHECKOUT",
      "Check the delivery method and ordinary product selection.",
    );
  }

  const config = normalizeShippingSettings(settings);
  const offer = config.freeShipping;

  const subtotal = paise(pricing.subtotal);
  const discount = paise(pricing.couponDiscount);
  const merchandise = paise(pricing.totalAfterCoupon);

  if (
    discount > subtotal ||
    subtotal - discount !== merchandise ||
    (pricing.kitDiscount || 0) !== 0
  ) {
    fail(
      409,
      "INVALID_AMOUNT",
      "The merchandise total needs review before applying delivery charges.",
    );
  }

  const catalog = new Map(
    products.map((product) => [
      String(product._id || product.id).toLowerCase(),
      product,
    ]),
  );

  const lower = (values) =>
    new Set(
      values.map((value) => value.toLowerCase()),
    );

  const eligibleIds = lower(
    offer.eligibleProductIds,
  );

  const eligibleCategories = lower(
    offer.eligibleCategories,
  );

  const excludedIds = lower(
    offer.excludedProductIds,
  );

  const excludedCategories = lower(
    offer.excludedCategories,
  );

  const selected = items.map((item) => {
    const id = String(
      item.product || item.id,
    ).toLowerCase();

    const product = catalog.get(id);

    if (!product) {
      fail(
        409,
        "PRODUCT_UNAVAILABLE",
        "A product changed. Refresh checkout before paying.",
      );
    }

    const category = String(
      product.category || "",
    )
      .trim()
      .toLowerCase();

    const included =
      (!eligibleIds.size &&
        !eligibleCategories.size) ||
      eligibleIds.has(id) ||
      eligibleCategories.has(category);

    return (
      included &&
      !excludedIds.has(id) &&
      !excludedCategories.has(category)
    );
  });

  const code =
    typeof pincode === "string"
      ? pincode.trim()
      : "";

  const validPincode =
    /^[1-9]\d{5}$/.test(code);

  const regional =
    offer.eligiblePincodes.length > 0 ||
    offer.excludedPincodes.length > 0;

  let reason = "qualified";

  if (!offer.enabled) {
    reason = "disabled";
  } else if (deliveryMethod === "express") {
    reason = "express-delivery";
  } else if (!selected.every(Boolean)) {
    reason = "products-excluded";
  } else if (regional && !validPincode) {
    reason = "pincode-required";
  } else if (
    offer.excludedPincodes.includes(code)
  ) {
    reason = "pincode-excluded";
  } else if (
    offer.eligiblePincodes.length &&
    !offer.eligiblePincodes.includes(code)
  ) {
    reason = "outside-eligible-region";
  } else if (
    merchandise < offer.minimumSubtotalPaise
  ) {
    reason = "below-minimum";
  }

  const qualified =
    reason === "qualified";

  const progressAvailable =
    qualified ||
    reason === "below-minimum";

  const shipping =
    deliveryMethod === "express"
      ? EXPRESS_SHIPPING * 100
      : qualified
        ? 0
        : STANDARD_SHIPPING * 100;

  const total =
    merchandise + shipping;

  const now =
    paymentMethod === "cod-partial"
      ? Math.round(merchandise / 10)
      : total;

  if (
    !Number.isSafeInteger(total) ||
    total > 10000000000
  ) {
    fail(
      409,
      "INVALID_AMOUNT",
      "The order exceeds the supported amount limit.",
    );
  }

  if (now < 100) {
    fail(
      400,
      "PAYMENT_AMOUNT_TOO_LOW",
      "The online payment amount must be at least ₹1.",
    );
  }

  return {
    pricing: {
      ...pricing,
      shipping: shipping / 100,
      finalTotal: total / 100,
    },

    payment: {
      method: paymentMethod,
      amountToPayNow: now / 100,
      amountDue: (total - now) / 100,

      advancePercentage:
        paymentMethod === "cod-partial"
          ? 10
          : 0,
    },

    freeShipping: {
      version: config.version,
      enabled: offer.enabled,

      scope:
        "ordinary-standard-basket",

      minimumSubtotalPaise:
        offer.minimumSubtotalPaise,

      qualifyingSubtotalPaise:
        progressAvailable
          ? merchandise
          : 0,

      remainingPaise:
        progressAvailable
          ? Math.max(
              0,
              offer.minimumSubtotalPaise -
                merchandise,
            )
          : null,

      progressPercent:
        progressAvailable
          ? offer.minimumSubtotalPaise === 0
            ? 100
            : Math.min(
                100,
                Math.floor(
                  (
                    merchandise /
                    offer.minimumSubtotalPaise
                  ) * 100,
                ),
              )
          : null,

      qualified,
      reason,
      allItemsMustQualify: true,

      additionalChargesNotice:
        offer.additionalChargesNotice,
    },
  };
}

module.exports = {
  loadShippingSettings,
  priceCheckoutShipping,
};