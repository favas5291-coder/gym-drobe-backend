"use strict";

const { getInventorySnapshot } = require("./orderInventory");
const { getDiscountedPrice } = require("./orderPricing");
const { isProductImageSource, normalizeColorImages, productImageSources } = require("./productImages");

const MAX_PRODUCT_BYTES = 2 * 1024 * 1024;
const brandFields = ["brand", "brand name"];
const variantKey = (size, color) => JSON.stringify([size ?? null, color ?? null]);
const safeNumber = value => (typeof value === "number" ||
  (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
const cleanBrand = value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

function checkPrices(product, stock, add) {
  const { price, discount = 0, variantPrices } = product;
  const priceValid = safeNumber(price) && Number(price) >= 0 && Number(price) <= 100000000;
  const discountValid = safeNumber(discount) && Number(discount) >= 0 && Number(discount) <= 100;
  if (!priceValid) add("PRICE_INVALID");
  if (!discountValid) add("DISCOUNT_INVALID");
  if (variantPrices == null || (Array.isArray(variantPrices) && !variantPrices.length)) {
    if (product.marketplaceListing || product.hasMarketplaceListing) add("VARIANT_PRICES_MISSING");
    else if (priceValid && discountValid && getDiscountedPrice(product) === 0) add("ZERO_SELLING_PRICE");
    return;
  }
  if (!Array.isArray(variantPrices) || variantPrices.length > 2500) {
    add("VARIANT_PRICES_INVALID");
    return;
  }
  const keys = new Set();
  let min = Infinity;
  function declared(value, options) {
    return Array.isArray(options) && options.length ? options.includes(value) : value == null || value === "";
  }
  for (const row of variantPrices) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      add("VARIANT_PRICES_INVALID");
      continue;
    }
    const key = variantKey(row.size || null, row.color || null);
    if (keys.has(key) || !declared(row.size, product.sizes) || !declared(row.color, product.colors)) {
      add("VARIANT_PRICE_SELECTION");
    }
    keys.add(key);
    if (!Number.isSafeInteger(row.customerUnitAmount) || row.customerUnitAmount < 1 ||
        (row.mrpUnitAmount != null && (!Number.isSafeInteger(row.mrpUnitAmount) || row.mrpUnitAmount < row.customerUnitAmount))) {
      add("VARIANT_PRICES_INVALID");
    } else min = Math.min(min, row.customerUnitAmount);
  }
  if (stock?.slots.some(slot => slot.available > 0 && !keys.has(variantKey(slot.size, slot.color)))) {
    add("IN_STOCK_VARIANT_WITHOUT_PRICE");
  }
  if (priceValid && Number.isFinite(min) && Math.round(Number(price) * 100) !== min) add("BASE_VARIANT_PRICE_MISMATCH");
}

function checkPhotos(product, add) {
  const gallery = product.images ?? [];
  if ((product.image && !isProductImageSource(product.image)) ||
      !Array.isArray(gallery) || gallery.some(image => !isProductImageSource(image))) add("PRODUCT_PHOTO_INVALID");
  try {
    normalizeColorImages(product.colorImages, Array.isArray(product.colors) ? product.colors : []);
  } catch {
    add("COLOUR_GALLERY_INVALID");
  }
  // Product cards and search can render before the buyer chooses a colour.
  if (!productImageSources(product, null).length) add("DEFAULT_PHOTO_MISSING");
}

function inspectProduct(product, position) {
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    throw new Error("Expected a product object at position " + position + ".");
  }
  if (Buffer.byteLength(JSON.stringify(product)) > MAX_PRODUCT_BYTES) throw new Error("Product exceeds the 2 MiB input limit.");
  const issues = new Set();
  const add = code => issues.add(code);
  let stock;
  let stockEvidence;
  try {
    stock = getInventorySnapshot(product);
    const expected = Math.max(product.colors?.length || 0, 1) * Math.max(product.sizes?.length || 0, 1);
    if (stock.slots.length !== expected && !product.variantPrices?.length && !product.hasMarketplaceListing && !product.marketplaceListing) {
      add("SPARSE_STOCK_MATRIX");
    }
    if (!safeNumber(product.stock) || Number(product.stock) !== stock.total) add("TOTAL_STOCK_MISMATCH");
    if (product.stockStatus != null && product.stockStatus !== stock.status) add("STOCK_STATUS_MISMATCH");
    if (issues.size) {
      stockEvidence = {
        recordedTotal: safeNumber(product.stock) ? Number(product.stock) : null, checkoutTotal: stock.total,
        expectedStatus: stock.status, recordedSlots: stock.slots.length, declaredCombinations: expected,
      };
    }
  } catch {
    add("INVENTORY_INVALID");
  }
  checkPrices(product, stock, add);
  checkPhotos(product, add);

  const brand = cleanBrand(product.brand);
  if (!brand) add("BRAND_MISSING");
  const conflicts = [];
  if (brand && product.specifications && typeof product.specifications === "object" && !Array.isArray(product.specifications)) {
    for (const [key, value] of Object.entries(product.specifications)) {
      const label = key.trim().toLowerCase();
      const declared = cleanBrand(value);
      if (brandFields.includes(label) && declared && brand.toLowerCase() !== declared.toLowerCase()) {
        add("EXPLICIT_BRAND_CONFLICT");
        if (conflicts.length < 4) conflicts.push({ field: "specifications." + key.trim().slice(0, 30), value: declared.slice(0, 100) });
      }
    }
  }
  const id = String(product._id ?? product.id ?? "");
  return {
    position,
    ...(/^[a-f\d]{24}$/i.test(id) || /^\d{1,16}$/.test(id) ? { id } : {}),
    issues: [...issues],
    ...(stockEvidence ? { stockEvidence } : {}),
    ...(conflicts.length ? { brandEvidence: { brand: brand.slice(0, 100), conflictingFields: conflicts } } : {}),
  };
}

module.exports = { inspectProduct };
