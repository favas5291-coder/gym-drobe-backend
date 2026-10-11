"use strict";

// Keep this limit aligned with models/Product.js.
const MAX_STOCK = 1000000;

const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(
    object || {},
    key,
  );
}

function record(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.toString.call(value) ===
      "[object Object]"
  );
}

function quantity(value, message) {
  if (
    !["number", "string"].includes(typeof value) ||
    (typeof value === "string" && !value.trim())
  ) {
    throw new Error(message);
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_STOCK
  ) {
    throw new Error(message);
  }

  return parsed;
}

function optionList(value, label, maximumLength) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(
      `Product ${label} options need an admin correction.`,
    );
  }

  const seen = new Set();

  return value.map((option) => {
    if (
      !["string", "number"].includes(typeof option) ||
      (
        typeof option === "number" &&
        !Number.isFinite(option)
      )
    ) {
      throw new Error(
        `Product ${label} options need an admin correction.`,
      );
    }

    const name = String(option);
    const key = name.toLowerCase();

    if (
      !name ||
      name.trim() !== name ||
      name.length > maximumLength ||
      name === "default" ||
      FORBIDDEN_KEYS.has(name) ||
      name.startsWith("$") ||
      name.includes(".") ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      seen.has(key)
    ) {
      throw new Error(
        `Product ${label} options need an admin correction.`,
      );
    }

    seen.add(key);
    return name;
  });
}

function options(product) {
  if (
    !product ||
    typeof product !== "object" ||
    Array.isArray(product)
  ) {
    throw new Error("Product is unavailable.");
  }

  return {
    sizes: optionList(product.sizes, "size", 50),
    colors: optionList(product.colors, "colour", 80),
  };
}

function selected(value, label) {
  if (value == null || value === "") {
    return null;
  }

  if (
    !["string", "number"].includes(typeof value) ||
    (
      typeof value === "number" &&
      !Number.isFinite(value)
    )
  ) {
    throw new Error(`Invalid product ${label}.`);
  }

  return String(value);
}

function validateVariant(
  product,
  selectedSize,
  selectedColor,
) {
  const { sizes, colors } = options(product);

  const size = selected(selectedSize, "size");
  const color = selected(selectedColor, "colour");

  if (
    sizes.length
      ? !size || !sizes.includes(size)
      : size !== null
  ) {
    throw new Error(
      "The selected product size is unavailable or no longer exists.",
    );
  }

  if (
    colors.length
      ? !color || !colors.includes(color)
      : color !== null
  ) {
    throw new Error(
      "The selected product colour is unavailable or no longer exists.",
    );
  }

  return {
    sizes,
    colors,
    size,
    color,
  };
}

function listedKeys(value, allowed) {
  const names = new Set(allowed);

  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !names.has(key),
    )
  ) {
    throw new Error(
      "Variant stock contains an invalid or unlisted size or colour.",
    );
  }
}

// Read and change the same stock entries for every supported shape.
function inventory(
  product,
  declared = options(product),
) {
  const { sizes, colors } = declared;
  const variants = product.variants;

  const slots = [];
  let total = 0;

  function add(
    target,
    key,
    mixed,
    size = null,
    color = null,
    fallback = false,
  ) {
    const available = quantity(
      fallback
        ? target[key] ?? 0
        : target[key],

      "Stock must be a whole number from 0 to 1,000,000. Ask an admin to correct it.",
    );

    total += available;

    if (
      !Number.isSafeInteger(total) ||
      total > MAX_STOCK
    ) {
      throw new Error(
        "Combined product stock cannot exceed 1,000,000.",
      );
    }

    slots.push({
      target,
      key,
      mixed,
      size,
      color,
      available,
    });
  }

  if (!sizes.length && !colors.length) {
    if (
      variants != null &&
      (
        !record(variants) ||
        Object.keys(variants).length
      )
    ) {
      throw new Error(
        "Product options and variant stock do not match. Ask an admin to correct them.",
      );
    }

    // Ordinary products can have Mongoose's default empty variants object.
    add(
      product,
      "stock",
      false,
      null,
      null,
      true,
    );

    return { slots, total };
  }

  if (
    !record(variants) ||
    !Object.keys(variants).length
  ) {
    throw new Error(
      "Stock for the listed sizes or colours has not been configured.",
    );
  }

  listedKeys(
    variants,
    colors.length ? colors : sizes,
  );

  if (colors.length) {
    for (const color of colors) {
      if (!own(variants, color)) {
        continue;
      }

      const group = variants[color];

      if (sizes.length) {
        listedKeys(group, sizes);

        for (const size of sizes) {
          if (own(group, size)) {
            add(
              group,
              size,
              true,
              size,
              color,
            );
          }
        }
      } else if (record(group)) {
        listedKeys(group, ["default"]);

        if (own(group, "default")) {
          add(
            group,
            "default",
            true,
            null,
            color,
          );
        }
      } else {
        // Legacy colour-only shape:
        // { Black: 5, Blue: 0 }
        add(
          variants,
          color,
          true,
          null,
          color,
        );
      }
    }
  } else {
    for (const size of sizes) {
      if (own(variants, size)) {
        add(
          variants,
          size,
          true,
          size,
          null,
        );
      }
    }
  }

  return { slots, total };
}

function stockSlot(state, selection) {
  const slot = state.slots.find(
    (row) =>
      row.size === selection.size &&
      row.color === selection.color,
  );

  if (!slot) {
    throw new Error(
      "The original product stock variant no longer exists. Ask an admin to review the order.",
    );
  }

  return slot;
}

function getTotalStock(product) {
  try {
    return inventory(product).total;
  } catch {
    return 0;
  }
}

function getVariantStock(
  product,
  selectedSize = null,
  selectedColor = null,
) {
  try {
    const selection = validateVariant(
      product,
      selectedSize,
      selectedColor,
    );

    return stockSlot(
      inventory(product, selection),
      selection,
    ).available;
  } catch {
    return 0;
  }
}

// Older products without a matching variant SKU keep their parent SKU.
function getVariantSku(
  product,
  selectedSize = null,
  selectedColor = null,
) {
  const { size, color } = validateVariant(
    product,
    selectedSize,
    selectedColor,
  );

  const normalize = (value) =>
    value == null ? "" : String(value);

  const rows = Array.isArray(product.variantSkus)
    ? product.variantSkus
    : [];

  const variant = rows.find(
    (row) =>
      row &&
      typeof row === "object" &&
      normalize(row.size) === normalize(size) &&
      normalize(row.color) === normalize(color),
  );

  if (
    typeof variant?.sku === "string" &&
    variant.sku.trim()
  ) {
    return variant.sku.trim();
  }

  return typeof product.sku === "string"
    ? product.sku.trim()
    : "";
}

function applyStockStatus(product, total) {
  product.stock = total;

  product.stockStatus =
    total <= 0
      ? "out-of-stock"
      : total <= 10
        ? "low-stock"
        : "in-stock";

  return product;
}

function updateStockStatus(product) {
  return applyStockStatus(
    product,
    inventory(product).total,
  );
}

function changeStock(
  product,
  value,
  selectedSize,
  selectedColor,
  restoring,
) {
  const message = restoring
    ? "Invalid inventory restore quantity."
    : "Invalid order quantity.";

  const qty = quantity(value, message);

  if (qty < 1) {
    throw new Error(message);
  }

  const selection = validateVariant(
    product,
    selectedSize,
    selectedColor,
  );

  const state = inventory(product, selection);
  const slot = stockSlot(state, selection);

  if (!restoring && slot.available < qty) {
    throw new Error(
      slot.available > 0
        ? `Only ${slot.available} available for this selection.`
        : "This product selection is out of stock.",
    );
  }

  const next = restoring
    ? slot.available + qty
    : slot.available - qty;

  const nextTotal = restoring
    ? state.total + qty
    : state.total - qty;

  if (
    !Number.isSafeInteger(next) ||
    next < 0 ||
    next > MAX_STOCK ||
    !Number.isSafeInteger(nextTotal) ||
    nextTotal < 0 ||
    nextTotal > MAX_STOCK
  ) {
    throw new Error(
      "Inventory quantity exceeds the supported limit of 1,000,000.",
    );
  }

  // Complete validation before changing any quantities.
  slot.target[slot.key] = next;

  if (
    slot.mixed &&
    typeof product.markModified === "function"
  ) {
    product.markModified("variants");
  }

  return applyStockStatus(product, nextTotal);
}

// These functions change the document in memory.
// Controllers save it inside their order/payment transaction and
// guard against repeated reservation or restoration.
function reserveVariantStock(
  product,
  quantity,
  selectedSize = null,
  selectedColor = null,
) {
  return changeStock(
    product,
    quantity,
    selectedSize,
    selectedColor,
    false,
  );
}

function restoreVariantStock(
  product,
  quantity,
  selectedSize = null,
  selectedColor = null,
) {
  return changeStock(
    product,
    quantity,
    selectedSize,
    selectedColor,
    true,
  );
}

module.exports = {
  getTotalStock,
  getVariantStock,
  getVariantSku,
  reserveVariantStock,
  restoreVariantStock,
  updateStockStatus,
};