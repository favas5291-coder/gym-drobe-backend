function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function count(value) {
  return Math.max(0, Math.floor(number(value)));
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(
    object || {},
    key
  );
}

function calculateVariantTotal(value) {
  if (value && typeof value === "object") {
    return Object.values(value).reduce(
      (total, child) => total + calculateVariantTotal(child),
      0
    );
  }

  return count(value);
}

function getTotalStock(product) {
  if (!product) return 0;

  return product.variants
    ? calculateVariantTotal(product.variants)
    : count(product.stock);
}

function validateVariant(
  product,
  selectedSize = null,
  selectedColor = null
) {
  if (!product) {
    throw new Error("Product is unavailable.");
  }

  const sizes = (product.sizes || []).map(String);
  const colors = (product.colors || []).map(String);

  const size = sizes.length
    ? selectedSize == null
      ? null
      : String(selectedSize)
    : null;

  const color = colors.length
    ? selectedColor == null
      ? null
      : String(selectedColor)
    : null;

  if (sizes.length && (!size || !sizes.includes(size))) {
    throw new Error("Invalid product size.");
  }

  if (colors.length && (!color || !colors.includes(color))) {
    throw new Error("Invalid product colour.");
  }

  return { sizes, colors, size, color };
}

function getVariantStock(
  product,
  selectedSize = null,
  selectedColor = null
) {
  if (!product) return 0;

  let selection;

  try {
    selection = validateVariant(
      product,
      selectedSize,
      selectedColor
    );
  } catch {
    return 0;
  }

  if (!product.variants) {
    return count(product.stock);
  }

  const { sizes, colors, size, color } = selection;
  let group = product.variants;

  if (colors.length) {
    if (!own(group, color)) return 0;
    group = group[color];
  }

  if (sizes.length) {
    if (!own(group, size)) return 0;
    return count(group[size]);
  }

  return group && typeof group === "object"
    ? count(group.default)
    : count(group);
}

// Return the SKU belonging to the selected size and colour.
// Older products without variant SKUs retain their parent SKU.
function getVariantSku(
  product,
  selectedSize = null,
  selectedColor = null
) {
  const { size, color } = validateVariant(
    product,
    selectedSize,
    selectedColor
  );

  const normalize = (value) =>
    value == null ? "" : String(value);

  const rows = Array.isArray(product.variantSkus)
    ? product.variantSkus
    : [];

  const variant = rows.find(
    (row) =>
      normalize(row.size) === normalize(size) &&
      normalize(row.color) === normalize(color)
  );

  if (
    variant &&
    typeof variant.sku === "string" &&
    variant.sku.trim()
  ) {
    return variant.sku.trim();
  }

  return String(product.sku || "").trim();
}

function updateStockStatus(product) {
  const total = getTotalStock(product);

  product.stock = total;
  product.stockStatus =
    total <= 0
      ? "out-of-stock"
      : total <= 10
        ? "low-stock"
        : "in-stock";

  return product;
}

function stockSlot(product, selection) {
  const { sizes, colors, size, color } = selection;

  if (!product.variants) {
    return { target: product, key: "stock", mixed: false };
  }

  let target = product.variants;

  if (colors.length) {
    if (!own(target, color)) {
      throw new Error(
        "The original product colour variant no longer exists."
      );
    }

    target = target[color];
  }

  const key = sizes.length ? size : "default";

  if (
    !target ||
    typeof target !== "object" ||
    !own(target, key)
  ) {
    throw new Error(
      "The original product stock variant no longer exists."
    );
  }

  return { target, key, mixed: true };
}

function changeStock(
  product,
  quantity,
  selectedSize,
  selectedColor,
  restoring
) {
  const qty = Number(quantity);

  if (!Number.isSafeInteger(qty) || qty < 1) {
    throw new Error(
      restoring
        ? "Invalid inventory restore quantity."
        : "Invalid order quantity."
    );
  }

  const selection = validateVariant(
    product,
    selectedSize,
    selectedColor
  );

  const slot = stockSlot(product, selection);
  const available = count(slot.target[slot.key]);

  if (!restoring && available < qty) {
    throw new Error(
      available > 0
        ? `Only ${available} available for this selection.`
        : "This product selection is out of stock."
    );
  }

  const next = restoring
    ? available + qty
    : available - qty;

  if (!Number.isSafeInteger(next)) {
    throw new Error("Inventory quantity exceeds the supported limit.");
  }

  slot.target[slot.key] = next;

  if (
    slot.mixed &&
    typeof product.markModified === "function"
  ) {
    product.markModified("variants");
  }

  return updateStockStatus(product);
}

function reserveVariantStock(
  product,
  quantity,
  selectedSize = null,
  selectedColor = null
) {
  return changeStock(
    product,
    quantity,
    selectedSize,
    selectedColor,
    false
  );
}

function restoreVariantStock(
  product,
  quantity,
  selectedSize = null,
  selectedColor = null
) {
  return changeStock(
    product,
    quantity,
    selectedSize,
    selectedColor,
    true
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