"use strict";

const {
  getOriginalPrice,
  getDiscountedPrice,
  resolveCoupon,
  calculateCouponDiscount,
  calculateShipping,
} = require("./orderPricing");

const {
  getVariantStock,
  getVariantSku,
} = require("./orderInventory");

const {
  KIT_ROLES,
  reference,
  money,
  kitStructureIssues,
} = require("./kitDefinitions");

const MAX_PAISE = 10000000000;

function fail(
  message,
  code = "INVALID_KIT_SELECTION",
  status = 400,
) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function validateObject(value, allowedKeys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(`${label} must be an object.`);
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      fail(`Unsupported ${label} field: ${key}.`);
    }
  }
}

function paise(value) {
  const amount = Math.round(value * 100);

  if (
    !money(value) ||
    !Number.isSafeInteger(amount) ||
    amount > MAX_PAISE
  ) {
    fail(
      "The kit amount exceeds the supported price limits.",
    );
  }

  return amount;
}

function normalizeSelections(selections) {
  if (
    !Array.isArray(selections) ||
    !selections.length ||
    selections.length > 20
  ) {
    fail(
      "Select between 1 and 20 kit items. Omit categories you want to skip.",
    );
  }

  const seen = new Set();

  return selections.map((row) => {
    validateObject(
      row,
      [
        "slotKey",
        "productId",
        "selectedSize",
        "selectedColor",
        "quantity",
      ],
      "selection",
    );

    if (
      typeof row.slotKey !== "string" ||
      !/^[a-z][a-z0-9-]{0,59}$/.test(row.slotKey) ||
      seen.has(row.slotKey)
    ) {
      fail(
        "Choose each kit section only once using its valid section key.",
      );
    }

    seen.add(row.slotKey);

    if (
      typeof row.productId !== "string" ||
      !reference(row.productId)
    ) {
      fail(
        `${row.slotKey}: choose an existing product ID.`,
      );
    }

    if (
      typeof row.quantity !== "number" ||
      !Number.isSafeInteger(row.quantity) ||
      row.quantity < 1 ||
      row.quantity > 99
    ) {
      fail(
        `${row.slotKey}: quantity must be a whole number from 1 to 99.`,
      );
    }

    for (const [key, limit] of [
      ["selectedSize", 50],
      ["selectedColor", 80],
    ]) {
      if (
        row[key] != null &&
        (
          typeof row[key] !== "string" ||
          !row[key] ||
          row[key].length > limit
        )
      ) {
        fail(
          `${row.slotKey}: ${key} must be a valid option or null.`,
        );
      }
    }

    return {
      slotKey: row.slotKey,
      productId: reference(row.productId),
      selectedSize: row.selectedSize ?? null,
      selectedColor: row.selectedColor ?? null,
      quantity: row.quantity,
    };
  });
}

// Allocate discounts in integer paise.
// This ensures component totals exactly match the order totals.
function allocate(amount, weights) {
  const total = weights.reduce(
    (sum, value) => sum + value,
    0,
  );

  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > total ||
    weights.some(
      (value) =>
        !Number.isSafeInteger(value) ||
        value < 0,
    )
  ) {
    fail("Discount allocation is invalid.");
  }

  if (!amount || !total) {
    return weights.map(() => 0);
  }

  const denominator = BigInt(total);

  const rows = weights.map((weight, index) => {
    const numerator =
      BigInt(amount) * BigInt(weight);

    return {
      index,
      value: Number(numerator / denominator),
      remainder: numerator % denominator,
    };
  });

  let remaining =
    amount -
    rows.reduce((sum, row) => sum + row.value, 0);

  const ordered = [...rows].sort((a, b) => {
    if (a.remainder === b.remainder) {
      return a.index - b.index;
    }

    return a.remainder > b.remainder ? -1 : 1;
  });

  for (const row of ordered) {
    if (!remaining) break;

    row.value += 1;
    remaining -= 1;
  }

  return rows.map((row) => row.value);
}

function calculateKitQuote({
  kit,
  products,
  selections,
  coupon = null,
  deliveryMethod = "standard",
  paymentMethod = "razorpay",
}) {
  const issues = kitStructureIssues(kit);

  if (issues.length) {
    fail(
      issues.join(" "),
      "KIT_CONFIGURATION_INVALID",
      409,
    );
  }

  if (kit.status === "archived") {
    fail(
      "This kit is archived.",
      "KIT_UNAVAILABLE",
      409,
    );
  }

  if (!["standard", "express"].includes(deliveryMethod)) {
    fail("Choose standard or express delivery.");
  }

  if (!["razorpay", "cod-partial"].includes(paymentMethod)) {
    fail(
      "Choose online payment or COD with a 10% advance.",
    );
  }

  if (
    coupon !== null &&
    (
      typeof coupon !== "string" ||
      coupon.length > 50
    )
  ) {
    fail("Enter a coupon code as text.");
  }

  const chosen = normalizeSelections(selections);

  const sections = new Map(
    kit.slots.map((slot, index) => [
      slot.key,
      { slot, index },
    ]),
  );

  if (
    chosen.some((row) => !sections.has(row.slotKey))
  ) {
    fail(
      "A selected section no longer belongs to this kit.",
    );
  }

  // Stable template order also makes discount rounding predictable.
  chosen.sort(
    (a, b) =>
      sections.get(a.slotKey).index -
      sections.get(b.slotKey).index,
  );

  if (!Array.isArray(products)) {
    fail(
      "The product catalogue could not be read.",
      "KIT_CATALOG_UNAVAILABLE",
      503,
    );
  }

  const catalogue = new Map(
    products.map((product) => [
      reference(product._id || product.id),
      product,
    ]),
  );

  const stockRequired = new Map();

  const items = chosen.map((row) => {
    const slot = sections.get(row.slotKey).slot;
    const product = catalogue.get(row.productId);
    const label = slot.label || slot.key;

    if (
      !slot.allowedProducts
        .map(reference)
        .includes(row.productId)
    ) {
      fail(
        `${label}: this replacement is not allowed.`,
      );
    }

    if (
      !product ||
      product.isActive !== true ||
      product.delivery?.available !== true
    ) {
      fail(
        `${label}: this product is currently unavailable.`,
        "KIT_PRODUCT_UNAVAILABLE",
        409,
      );
    }

    if (
      product.kitSettings?.eligible !== true ||
      !product.kitSettings.roles?.includes(slot.role)
    ) {
      fail(
        `${label}: this product is no longer eligible for this category.`,
        "KIT_PRODUCT_UNAVAILABLE",
        409,
      );
    }

    if (row.quantity > slot.maximumQuantity) {
      fail(
        `${label}: choose no more than ${slot.maximumQuantity}.`,
      );
    }

    if (
      typeof product.price !== "number" ||
      !Number.isFinite(product.price) ||
      product.price < 0 ||
      product.price > 100000000 ||
      typeof product.discount !== "number" ||
      !Number.isFinite(product.discount) ||
      product.discount < 0 ||
      product.discount > 100
    ) {
      fail(
        `${label}: product pricing needs an admin correction.`,
        "KIT_PRICE_UNAVAILABLE",
        409,
      );
    }

    let sku;
    let available;

    try {
      sku = getVariantSku(
        product,
        row.selectedSize,
        row.selectedColor,
      );

      available = getVariantStock(
        product,
        row.selectedSize,
        row.selectedColor,
      );
    } catch (error) {
      fail(
        `${label}: ${error.message}`,
        "KIT_VARIANT_UNAVAILABLE",
        409,
      );
    }

    const stockKey = JSON.stringify([
      row.productId,
      row.selectedSize,
      row.selectedColor,
    ]);

    const combined =
      (stockRequired.get(stockKey) || 0) +
      row.quantity;

    stockRequired.set(stockKey, combined);

    if (available < combined) {
      fail(
        `${label}: only ${available} available for this variant across the kit.`,
        "KIT_STOCK_UNAVAILABLE",
        409,
      );
    }

    const unitPrice = getDiscountedPrice(product);

    const lineSubtotalPaise =
      paise(unitPrice) * row.quantity;

    if (
      !Number.isSafeInteger(lineSubtotalPaise) ||
      lineSubtotalPaise > MAX_PAISE
    ) {
      fail(
        "The kit amount exceeds supported limits.",
      );
    }

    return {
      slotKey: slot.key,
      role: slot.role,
      productId: row.productId,
      name: product.name || "",
      brand: product.brand || "",
      sku,
      selectedSize: row.selectedSize,
      selectedColor: row.selectedColor,
      quantity: row.quantity,
      unitPrice,
      originalUnitPrice: getOriginalPrice(product),
      availableStock: available,
      lineSubtotalPaise,
    };
  });

  const subtotalPaise = items.reduce(
    (sum, item) => sum + item.lineSubtotalPaise,
    0,
  );

  if (
    !Number.isSafeInteger(subtotalPaise) ||
    subtotalPaise < 1 ||
    subtotalPaise > MAX_PAISE
  ) {
    fail(
      "Select a kit with a positive item subtotal within supported limits.",
    );
  }

  const discount = kit.discount;

  if (
    !money(discount.minimumSubtotal) ||
    !Number.isSafeInteger(discount.minimumCategories) ||
    discount.minimumCategories < 1 ||
    discount.minimumCategories > 7 ||
    !Array.isArray(discount.requiredRoles) ||
    discount.requiredRoles.some(
      (role) => !KIT_ROLES.includes(role),
    ) ||
    new Set(discount.requiredRoles).size !==
      discount.requiredRoles.length ||
    typeof discount.allowCouponStacking !== "boolean"
  ) {
    fail(
      "Kit discount eligibility needs an admin correction.",
      "KIT_CONFIGURATION_INVALID",
      409,
    );
  }

  const roles = new Set(
    items.map((item) => item.role),
  );

  const discountReasons = [];

  if (
    subtotalPaise < paise(discount.minimumSubtotal)
  ) {
    discountReasons.push(
      `Add items to reach ₹${discount.minimumSubtotal} before kit discounts.`,
    );
  }

  if (roles.size < discount.minimumCategories) {
    discountReasons.push(
      `Choose at least ${discount.minimumCategories} different categories.`,
    );
  }

  for (const role of discount.requiredRoles) {
    if (!roles.has(role)) {
      discountReasons.push(
        `The kit discount requires the ${role} category.`,
      );
    }
  }

  const kitDiscountEligible =
    discount.type !== "none" &&
    !discountReasons.length;

  let kitDiscountPaise = 0;

  if (kitDiscountEligible) {
    if (discount.type === "fixed") {
      kitDiscountPaise = paise(discount.value);
    } else {
      const percentageUnits =
        Math.round(discount.value * 100);

      kitDiscountPaise = Number(
        (
          BigInt(subtotalPaise) *
          BigInt(percentageUnits) +
          5000n
        ) / 10000n,
      );
    }

    kitDiscountPaise = Math.min(
      subtotalPaise,
      kitDiscountPaise,
    );
  }

  const afterKitPaise =
    subtotalPaise - kitDiscountPaise;

  const code = typeof coupon === "string"
    ? coupon.trim().toUpperCase()
    : "";

  const resolved = code
    ? resolveCoupon(code)
    : null;

  if (code && !resolved) {
    fail(
      "This coupon code is not available.",
      "INVALID_COUPON",
    );
  }

  if (
    resolved &&
    kitDiscountPaise > 0 &&
    !discount.allowCouponStacking
  ) {
    fail(
      "This kit discount cannot be combined with an order coupon. Remove the coupon to continue.",
      "KIT_COUPON_NOT_ALLOWED",
    );
  }

  if (
    resolved &&
    afterKitPaise < paise(resolved.minimum)
  ) {
    fail(
      `Coupon ${resolved.code} requires an item subtotal of ₹${resolved.minimum} after kit discounts.`,
      "COUPON_MINIMUM_NOT_MET",
    );
  }

  const couponDiscountPaise = paise(
    calculateCouponDiscount(
      afterKitPaise / 100,
      resolved,
    ),
  );

  const kitAllocations = allocate(
    kitDiscountPaise,
    items.map((item) => item.lineSubtotalPaise),
  );

  const remainingWeights = items.map(
    (item, index) =>
      item.lineSubtotalPaise -
      kitAllocations[index],
  );

  const couponAllocations = allocate(
    couponDiscountPaise,
    remainingWeights,
  );

  const totalAfterCouponPaise =
    afterKitPaise - couponDiscountPaise;

  const shippingPaise = paise(
    calculateShipping(
      totalAfterCouponPaise / 100,
      deliveryMethod,
    ),
  );

  const totalPaise =
    totalAfterCouponPaise + shippingPaise;

  if (
    !Number.isSafeInteger(totalPaise) ||
    totalPaise > MAX_PAISE
  ) {
    fail(
      "The order amount exceeds supported limits.",
    );
  }

  // Existing COD rule:
  // 10% of merchandise after all discounts.
  // Shipping remains in the delivery balance.
  const payNowPaise = paymentMethod === "cod-partial"
    ? Math.round(totalAfterCouponPaise / 10)
    : totalPaise;

  if (payNowPaise < 100) {
    fail(
      paymentMethod === "cod-partial"
        ? "This kit amount is too low for a COD advance."
        : "The payment amount must be at least ₹1.",
      "PAYMENT_AMOUNT_TOO_LOW",
    );
  }

  return {
    kitId: reference(kit._id || kit.id),
    kitCode: kit.kitCode || "",
    name: kit.name,
    level: kit.level,
    templateVersion: kit.__v ?? kit.version ?? 0,

    previewOnly: true,
    purchaseEnabled: false,
    inventoryReserved: false,

    items: items.map((item, index) => {
      const paidPaise =
        remainingWeights[index] -
        couponAllocations[index];

      return {
        ...item,
        lineSubtotal: item.lineSubtotalPaise / 100,
        kitDiscount: kitAllocations[index] / 100,
        couponDiscount: couponAllocations[index] / 100,
        linePaid: paidPaise / 100,

        refundAllocation: {
          quantity: item.quantity,
          linePaidPaise: paidPaise,
          unitBasePaise: Math.floor(
            paidPaise / item.quantity,
          ),
          extraPaiseUnits: paidPaise % item.quantity,
        },
      };
    }),

    skippedCategories: [
      ...new Set(
        kit.slots.map((slot) => slot.role),
      ),
    ].filter((role) => !roles.has(role)),

    discountEligibility: {
      eligible: kitDiscountEligible,
      reasons: discountReasons,
    },

    pricing: {
      subtotal: subtotalPaise / 100,
      kitDiscount: kitDiscountPaise / 100,
      totalAfterKitDiscount: afterKitPaise / 100,
      couponDiscount: couponDiscountPaise / 100,
      totalAfterCoupon: totalAfterCouponPaise / 100,
      shipping: shippingPaise / 100,
      finalTotal: totalPaise / 100,
    },

    payment: {
      method: paymentMethod,
      amountToPayNow: payNowPaise / 100,
      amountDue: (totalPaise - payNowPaise) / 100,
      advancePercentage:
        paymentMethod === "cod-partial" ? 10 : 0,
    },

    coupon: resolved?.code || null,
    deliveryMethod,
    shippingIsEstimate: true,

    notice:
      "Admin preview only. Shipping uses the existing store rates. Delivery coverage, supplier readiness and actual shipment charges must be checked before payment. Stock is not reserved.",
  };
}

// Later refund integration must use the allocation saved
// in the server-side order, never an allocation from the client.
function componentRefundPaise(
  allocation,
  quantity,
  alreadyRefundedQuantity = 0,
) {
  const {
    quantity: total,
    linePaidPaise,
    unitBasePaise,
    extraPaiseUnits,
  } = allocation || {};

  const values = [
    total,
    linePaidPaise,
    unitBasePaise,
    extraPaiseUnits,
    quantity,
    alreadyRefundedQuantity,
  ];

  if (
    !values.every(Number.isSafeInteger) ||
    total < 1 ||
    quantity < 1 ||
    alreadyRefundedQuantity < 0 ||
    quantity + alreadyRefundedQuantity > total ||
    linePaidPaise < 0 ||
    unitBasePaise < 0 ||
    extraPaiseUnits < 0 ||
    extraPaiseUnits >= total ||
    unitBasePaise * total + extraPaiseUnits !==
      linePaidPaise
  ) {
    fail(
      "The saved component refund allocation is invalid.",
      "REFUND_ALLOCATION_INVALID",
      409,
    );
  }

  const extrasBefore = Math.min(
    alreadyRefundedQuantity,
    extraPaiseUnits,
  );

  const extrasAfter = Math.min(
    alreadyRefundedQuantity + quantity,
    extraPaiseUnits,
  );

  return (
    unitBasePaise * quantity +
    extrasAfter -
    extrasBefore
  );
}

module.exports = {
  normalizeSelections,
  calculateKitQuote,
  componentRefundPaise,
};