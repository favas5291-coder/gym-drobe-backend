const {
  selectedProductImage,
} = require("./productImages");

const {
  calculateKitQuote,
} = require("./kitPricing");

const {
  reference,
} = require("./kitDefinitions");

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
  reserveVariantStock,
} = require("./orderInventory");

const MAX_PAISE = 10000000000;

function fail(
  message,
  code = "INVALID_KIT_CHECKOUT",
  status = 400,
) {
  throw Object.assign(new Error(message), {
    status,
    code,
    gymdrobe: true,
  });
}

function paise(value) {
  const amount = Math.round(value * 100);

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(amount) ||
    amount > MAX_PAISE ||
    Math.abs(value * 100 - amount) > 0.00001
  ) {
    fail(
      "An order amount is invalid or exceeds the supported limit.",
      "INVALID_AMOUNT",
      409,
    );
  }

  return amount;
}

function plain(value) {
  const source =
    typeof value?.toObject === "function"
      ? value.toObject({ transform: false })
      : value;

  return JSON.parse(JSON.stringify(source));
}

// Allocate a discount exactly in integer paise.
// Stable ordering resolves equal remainder amounts.
function allocate(amount, weights) {
  const total = weights.reduce(
    (sum, value) => sum + value,
    0,
  );

  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > total
  ) {
    fail(
      "Order discounts could not be allocated.",
      "INVALID_AMOUNT",
      409,
    );
  }

  if (!amount) {
    return weights.map(() => 0);
  }

  const rows = weights.map((weight, index) => {
    const numerator =
      BigInt(amount) * BigInt(weight);

    return {
      index,
      value: Number(numerator / BigInt(total)),
      remainder: numerator % BigInt(total),
    };
  });

  const ranked = [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );

  let remaining =
    amount -
    rows.reduce(
      (sum, row) => sum + row.value,
      0,
    );

  for (const row of ranked) {
    if (!remaining) {
      break;
    }

    row.value += 1;
    remaining -= 1;
  }

  return rows.map((row) => row.value);
}

function snapshotItem(
  product,
  quantity,
  size,
  color,
) {
  if (!product || product.isActive === false) {
    fail(
      "A selected product is unavailable.",
      "PRODUCT_UNAVAILABLE",
      409,
    );
  }

  if (
    typeof product.price !== "number" ||
    !Number.isFinite(product.price) ||
    product.price < 0 ||
    !Number.isFinite(
      Number(product.discount ?? 0),
    ) ||
    Number(product.discount ?? 0) < 0 ||
    Number(product.discount ?? 0) > 100
  ) {
    fail(
      "A selected product needs a price correction.",
      "PRODUCT_PRICE_INVALID",
      409,
    );
  }

  let sku;

  try {
    sku = getVariantSku(product, size, color);
  } catch (error) {
    fail(error.message, "INVALID_VARIANT");
  }

  return {
    product: reference(
      product._id || product.id,
    ),

    legacyId: product.legacyId ?? null,
    slug: product.slug || "",
    sku,
    name: product.name,
    brand: product.brand || "",

    image: selectedProductImage(
      product,
      color,
    ),

    originalPrice: getOriginalPrice(product),
    price: getDiscountedPrice(product),
    discount: Number(product.discount || 0),

    quantity,
    selectedSize: size,
    selectedColor: color,

    returnPolicy: product.returnPolicy || "",

    returnsEligible: ["yes", "no"].includes(
      product.returnsEligible,
    )
      ? product.returnsEligible
      : "unconfirmed",

    returnConditions:
      product.returnConditions || "",

    returnWindowDays:
      Number.isSafeInteger(
        product.returnWindowDays,
      ) &&
      product.returnWindowDays >= 1 &&
      product.returnWindowDays <= 7
        ? product.returnWindowDays
        : 7,
  };
}

// Products and templates must be loaded by the backend.
// Never supply browser-provided catalogue documents here.
//
// This prepares prices and snapshots only.
// It does not authorize payment or reserve database inventory.
function buildKitCheckoutPricing({
  items,
  kits,
  products,
  coupon = "",
  deliveryMethod = "standard",
  paymentMethod = "razorpay",
}) {
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > 50 ||
    !Array.isArray(kits) ||
    !Array.isArray(products)
  ) {
    fail(
      "Choose between 1 and 50 order components.",
    );
  }

  if (
    !["standard", "express"].includes(
      deliveryMethod,
    ) ||
    !["razorpay", "cod-partial"].includes(
      paymentMethod,
    )
  ) {
    fail(
      "Choose a supported delivery and payment method.",
    );
  }

  if (
    typeof coupon !== "string" ||
    coupon.length > 50
  ) {
    fail("Enter a coupon code as text.");
  }

  const catalogue = products.map(plain);

  const templates = new Map(
    kits.map((value) => {
      const kit = plain(value);

      return [
        reference(kit._id || kit.id),
        kit,
      ];
    }),
  );

  const groups = new Map();
  const ordinary = new Map();
  const order = [];

  for (const raw of items) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    ) {
      fail("Check the selected components.");
    }

    const supplied =
      raw.id ?? raw.productId ?? raw.product;

    if (
      !["string", "number"].includes(
        typeof supplied,
      )
    ) {
      fail("Choose an existing product ID.");
    }

    const product = catalogue.find((value) =>
      [
        value._id,
        value.id,
        value.legacyId,
        value.slug,
      ].some(
        (id) =>
          id != null &&
          String(id) === String(supplied),
      ),
    );

    if (
      !product ||
      !reference(product._id || product.id)
    ) {
      fail(
        "A selected product is unavailable.",
        "PRODUCT_UNAVAILABLE",
        409,
      );
    }

    const quantity = Number(raw.quantity);

    if (
      !["number", "string"].includes(
        typeof raw.quantity,
      ) ||
      !String(raw.quantity).trim() ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 99
    ) {
      fail(
        "Choose whole-number quantities from 1 to 99.",
      );
    }

    const size =
      raw.selectedSize == null ||
      raw.selectedSize === ""
        ? null
        : raw.selectedSize;

    const color =
      raw.selectedColor == null ||
      raw.selectedColor === ""
        ? null
        : raw.selectedColor;

    if (
      [size, color].some(
        (value) =>
          value !== null &&
          typeof value !== "string",
      ) ||
      (size?.length || 0) > 50 ||
      (color?.length || 0) > 80
    ) {
      fail("Check the selected variants.");
    }

    const id = reference(
      product._id || product.id,
    );

    if (
      Object.prototype.hasOwnProperty.call(
        raw,
        "kitGroup",
      )
    ) {
      const group = raw.kitGroup;

      if (
        !group ||
        typeof group !== "object" ||
        Array.isArray(group) ||
        typeof group.id !== "string" ||
        typeof group.kitId !== "string" ||
        typeof group.slotKey !== "string" ||
        !/^[a-zA-Z0-9_-]{8,80}$/.test(
          group.id,
        ) ||
        !reference(group.kitId) ||
        !Number.isSafeInteger(group.version) ||
        group.version < 0 ||
        !/^[a-z][a-z0-9-]{0,59}$/.test(
          group.slotKey,
        )
      ) {
        fail(
          "A kit grouping is invalid. Reopen the kit builder.",
        );
      }

      if (!groups.has(group.id)) {
        const value = {
          id: group.id,
          kitId: reference(group.kitId),
          version: group.version,
          selections: [],
        };

        groups.set(group.id, value);

        order.push({
          type: "kit",
          value,
        });
      }

      const value = groups.get(group.id);

      if (
        value.kitId !== reference(group.kitId) ||
        value.version !== group.version
      ) {
        fail(
          "Kit components must use the same template and version.",
        );
      }

      value.selections.push({
        slotKey: group.slotKey,
        productId: id,
        selectedSize: size,
        selectedColor: color,
        quantity,
      });
    } else {
      const key = JSON.stringify([
        id,
        size,
        color,
      ]);

      if (!ordinary.has(key)) {
        const value = snapshotItem(
          product,
          quantity,
          size,
          color,
        );

        ordinary.set(key, value);

        order.push({
          type: "product",
          value,
        });
      } else {
        const value = ordinary.get(key);

        value.quantity += quantity;

        if (value.quantity > 99) {
          fail(
            "Combined product quantities cannot exceed 99.",
          );
        }
      }
    }
  }

  if (groups.size > 20) {
    fail(
      "Use at most 20 kit groups per order.",
    );
  }

  const rows = [];
  const kitSnapshots = [];
  let couponBlocked = false;

  for (const entry of order) {
    if (entry.type === "product") {
      rows.push({
        ...entry.value,
        kit: null,
        kitDiscountPaise: 0,
      });

      continue;
    }

    const group = entry.value;
    const kit = templates.get(group.kitId);

    if (!kit || kit.status !== "published") {
      fail(
        "A selected kit is not available.",
        "KIT_UNAVAILABLE",
        409,
      );
    }

    if (
      (kit.__v ?? kit.version ?? 0) !==
      group.version
    ) {
      fail(
        "A kit template changed. Reopen the builder and review your choices.",
        "KIT_VERSION_CHANGED",
        409,
      );
    }

    if (
      ![
        "packed-together",
        "separate-shipments",
      ].includes(kit.fulfillment?.mode)
    ) {
      fail(
        "The kit fulfillment arrangement is not configured.",
        "KIT_FULFILLMENT_UNAVAILABLE",
        409,
      );
    }

    let quote;

    try {
      quote = calculateKitQuote({
        kit,
        products: catalogue,
        selections: group.selections,
        coupon: null,
        deliveryMethod,
        paymentMethod: "razorpay",
      });
    } catch (error) {
      fail(
        error.message,
        error.code || "INVALID_KIT_SELECTION",
        error.status || 400,
      );
    }

    if (
      quote.pricing.kitDiscount > 0 &&
      kit.discount?.allowCouponStacking !== true
    ) {
      couponBlocked = true;
    }

    kitSnapshots.push({
      groupId: group.id,
      template: group.kitId,
      templateVersion: group.version,
      kitCode: kit.kitCode || "",
      name: kit.name,
      level: kit.level,
      audience: kit.audience || "",
      explanation: kit.explanation || "",
      supplementNote: kit.supplementNote || "",
      fulfillmentMode: kit.fulfillment.mode,

      customerNote:
        kit.fulfillment.customerNote || "",

      subtotalPaise: 0,
      kitDiscountPaise: 0,
      couponDiscountPaise: 0,
      linePaidPaise: 0,
    });

    for (const item of quote.items) {
      const product = catalogue.find(
        (value) =>
          reference(value._id || value.id) ===
          item.productId,
      );

      rows.push({
        ...snapshotItem(
          product,
          item.quantity,
          item.selectedSize,
          item.selectedColor,
        ),

        kit: {
          groupId: group.id,
          slotKey: item.slotKey,
          role: item.role,
        },

        kitDiscountPaise: paise(
          item.kitDiscount,
        ),
      });
    }
  }

  // Use private copies to check shared stock.
  // No database inventory is deducted here.
  const inventory = new Map(
    catalogue.map((product) => [
      reference(product._id || product.id),
      plain(product),
    ]),
  );

  for (const row of rows) {
    const product = inventory.get(
      row.product,
    );

    if (
      getVariantStock(
        product,
        row.selectedSize,
        row.selectedColor,
      ) < row.quantity
    ) {
      fail(
        `${row.name}: insufficient stock across the complete bag.`,
        "STOCK_UNAVAILABLE",
        409,
      );
    }

    try {
      reserveVariantStock(
        product,
        row.quantity,
        row.selectedSize,
        row.selectedColor,
      );
    } catch (error) {
      fail(
        error.message,
        "STOCK_UNAVAILABLE",
        409,
      );
    }
  }

  const subtotals = rows.map(
    (row) => paise(row.price) * row.quantity,
  );

  const subtotal = subtotals.reduce(
    (sum, amount) => sum + amount,
    0,
  );

  const kitDiscount = rows.reduce(
    (sum, row) =>
      sum + row.kitDiscountPaise,
    0,
  );

  if (
    !Number.isSafeInteger(subtotal) ||
    subtotal > MAX_PAISE
  ) {
    fail(
      "The bag exceeds supported amount limits.",
      "INVALID_AMOUNT",
      409,
    );
  }

  const afterKit = subtotal - kitDiscount;
  const code = coupon.trim().toUpperCase();

  const resolved = code
    ? resolveCoupon(code)
    : null;

  if (code && !resolved) {
    fail(
      "This coupon is unavailable.",
      "COUPON_INVALID",
    );
  }

  if (resolved && couponBlocked) {
    fail(
      "This bag includes a kit discount that cannot be combined with a coupon.",
      "KIT_COUPON_NOT_ALLOWED",
    );
  }

  if (
    resolved &&
    afterKit < paise(resolved.minimum)
  ) {
    fail(
      `Coupon ${resolved.code} requires ₹${resolved.minimum} after kit discounts.`,
      "COUPON_MINIMUM_NOT_MET",
    );
  }

  const couponDiscount = paise(
    calculateCouponDiscount(
      afterKit / 100,
      resolved,
    ),
  );

  const allocations = allocate(
    couponDiscount,
    subtotals.map(
      (amount, index) =>
        amount -
        rows[index].kitDiscountPaise,
    ),
  );

  const snapshots = new Map(
    kitSnapshots.map((kit) => [
      kit.groupId,
      kit,
    ]),
  );

  const purchasedItems = rows.map(
    (row, index) => {
      const {
        kitDiscountPaise,
        ...item
      } = row;

      const linePaidPaise =
        subtotals[index] -
        kitDiscountPaise -
        allocations[index];

      const allocation = {
        quantity: row.quantity,
        lineSubtotalPaise: subtotals[index],
        kitDiscountPaise,
        couponDiscountPaise: allocations[index],
        linePaidPaise,

        unitBasePaise: Math.floor(
          linePaidPaise / row.quantity,
        ),

        extraPaiseUnits:
          linePaidPaise % row.quantity,
      };

      if (row.kit) {
        const kit = snapshots.get(
          row.kit.groupId,
        );

        kit.subtotalPaise +=
          allocation.lineSubtotalPaise;

        kit.kitDiscountPaise +=
          allocation.kitDiscountPaise;

        kit.couponDiscountPaise +=
          allocation.couponDiscountPaise;

        kit.linePaidPaise +=
          allocation.linePaidPaise;
      }

      return {
        ...item,
        priceAllocation: allocation,
      };
    },
  );

  const merchandise =
    afterKit - couponDiscount;

  const shipping = paise(
    calculateShipping(
      merchandise / 100,
      deliveryMethod,
    ),
  );

  const total = merchandise + shipping;

  if (
    !Number.isSafeInteger(total) ||
    total > MAX_PAISE
  ) {
    fail(
      "The order exceeds supported amount limits.",
      "INVALID_AMOUNT",
      409,
    );
  }

  const payNow =
    paymentMethod === "cod-partial"
      ? Math.round(merchandise / 10)
      : total;

  if (payNow < 100) {
    fail(
      "The online payment amount must be at least ₹1.",
      "PAYMENT_AMOUNT_TOO_LOW",
    );
  }

  return {
    items: purchasedItems,
    kitSnapshots,
    coupon: resolved,
    method: deliveryMethod,

    pricing: {
      subtotal: subtotal / 100,
      kitDiscount: kitDiscount / 100,
      couponDiscount: couponDiscount / 100,
      totalAfterCoupon: merchandise / 100,
      shipping: shipping / 100,
      finalTotal: total / 100,
      currency: "INR",
    },

    payment: {
      method: paymentMethod,
      amountToPayNow: payNow / 100,
      amountDue: (total - payNow) / 100,

      advancePercentage:
        paymentMethod === "cod-partial"
          ? 10
          : 0,
    },

    previewOnly: true,
    purchaseEnabled: false,
    inventoryReserved: false,
    shippingIsEstimate: true,

    notice:
      "Pricing preview only. Confirm fulfillment arrangements, package contents, preparation times, delivery coverage and final shipping before payment.",
  };
}

module.exports = {
  buildKitCheckoutPricing,
};