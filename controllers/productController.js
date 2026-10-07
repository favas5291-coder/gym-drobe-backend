const mongoose = require("mongoose");
const Product = require("../models/Product");
const { attachReviews } = require("../utils/productReviews");

const own = (object, key) =>
  Object.prototype.hasOwnProperty.call(object || {}, key);

const forbiddenKeys = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function text(value, maximum = 500) {
  if (value != null && typeof value !== "string") {
    throw httpError(400, "Text fields must contain text.");
  }

  return String(value ?? "").trim().slice(0, maximum);
}

function slugify(value) {
  return text(value, 300)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boolean(value) {
  if ([true, "true", 1, "1"].includes(value)) return true;
  if ([false, "false", 0, "0"].includes(value)) return false;

  throw httpError(400, "Invalid checkbox value.");
}

function number(value, label, maximum, integer = false) {
  if (
    value == null ||
    value === "" ||
    !["number", "string"].includes(typeof value)
  ) {
    throw httpError(400, `Enter a valid ${label}.`);
  }

  const result = Number(value);

  if (
    !Number.isFinite(result) ||
    result < 0 ||
    result > maximum ||
    (integer && !Number.isSafeInteger(result))
  ) {
    throw httpError(
      400,
      `${label} must be ${
        integer ? "a whole number" : "a number"
      } from 0 to ${maximum}.`
    );
  }

  return result;
}

function array(value, maximum = 100, length = 300) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw httpError(
      400,
      `Provide a list containing no more than ${maximum} entries.`
    );
  }

  const seen = new Set();

  return value
    .map((item) => text(item, length))
    .filter((item) => {
      const key = item.toLowerCase();

      if (!item || seen.has(key)) return false;

      seen.add(key);
      return true;
    });
}

function object(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw httpError(400, `${label} must be an object.`);
  }
}

function safeKey(value, maximum = 100) {
  const key = text(value, maximum);

  if (
    !key ||
    forbiddenKeys.has(key) ||
    key.startsWith("$") ||
    key.includes(".")
  ) {
    throw httpError(
      400,
      "Option and specification names cannot contain dots, start with $, or use reserved names."
    );
  }

  return key;
}

function normalizeVariants(value) {
  if (value == null) return {};

  object(value, "Variant stock");

  const entries = Object.entries(value);

  if (entries.length > 50) {
    throw httpError(400, "Use no more than 50 size or colour groups.");
  }

  const result = {};

  for (const [first, group] of entries) {
    const key = safeKey(first, 80);

    if (group && typeof group === "object") {
      object(group, "Variant options");

      const options = Object.entries(group);

      if (options.length > 50) {
        throw httpError(400, "Use no more than 50 options per group.");
      }

      result[key] = {};

      for (const [second, quantity] of options) {
        const option = safeKey(second, 80);

        result[key][option] = number(
          quantity,
          `${key} / ${option} stock`,
          1000000,
          true
        );
      }
    } else {
      // Preserve size-only stock.
      result[key] = number(
        group,
        `${key} stock`,
        1000000,
        true
      );
    }
  }

  return result;
}

function normalizeSpecifications(value) {
  object(value, "Specifications");

  const entries = Object.entries(value);

  if (entries.length > 100) {
    throw httpError(400, "Use no more than 100 specifications.");
  }

  const result = {};

  for (const [rawKey, value] of entries) {
    const key = safeKey(rawKey);

    if (Array.isArray(value)) {
      result[key] = array(value, 50, 300);
    } else if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      result[key] = value;
    } else {
      result[key] = text(value, 1000);
    }
  }

  return result;
}

function normalizeDelivery(value) {
  object(value, "Delivery settings");

  const result = {};

  if (own(value, "available")) {
    result.available = boolean(value.available);
  }

  if (own(value, "estimatedDays")) {
    result.estimatedDays = text(value.estimatedDays, 100) || null;
  }

  if (own(value, "freeDeliveryAbove")) {
    result.freeDeliveryAbove = number(
      value.freeDeliveryAbove,
      "free delivery threshold",
      100000000
    );
  }

  return result;
}

function normalizePayload(body, creating = false) {
  object(body, "Product data");

  const result = {};

  const strings = {
    name: 200,
    category: 100,
    subcategory: 100,
    brand: 100,
    gender: 50,
    badge: 80,
    material: 500,
    whatsIncluded: 1000,
    image: 2000,
    description: 5000,
    returnPolicy: 2000,
  };

  for (const [key, maximum] of Object.entries(strings)) {
    if (own(body, key)) result[key] = text(body[key], maximum);
  }

  if (own(body, "slug")) {
    result.slug = slugify(body.slug);

    if (!result.slug) {
      throw httpError(400, "Enter a valid product URL name.");
    }
  }

  if (own(body, "price")) {
    result.price = number(body.price, "price", 100000000);
  }

  if (own(body, "discount")) {
    result.discount = number(body.discount, "discount", 100);
  }

  if (own(body, "stock")) {
    result.stock = number(body.stock, "stock", 1000000, true);
  }

  if (own(body, "legacyId")) {
    result.legacyId =
      body.legacyId == null || body.legacyId === ""
        ? null
        : number(body.legacyId, "legacy ID", Number.MAX_SAFE_INTEGER, true);

    if (result.legacyId === 0) {
      throw httpError(400, "Legacy ID must be a positive integer.");
    }
  }

  const lists = {
    tags: [50, 100],
    highlights: [30, 500],
    careInstructions: [30, 500],
    sizes: [50, 50],
    colors: [50, 80],
    images: [20, 2000],
  };

  for (const [key, limits] of Object.entries(lists)) {
    if (own(body, key)) result[key] = array(body[key], ...limits);
  }

  if (own(body, "variants")) {
    result.variants = normalizeVariants(body.variants);
  }

  if (own(body, "specifications")) {
    result.specifications = normalizeSpecifications(body.specifications);
  }

  if (own(body, "delivery")) {
    result.delivery = normalizeDelivery(body.delivery);
  }

  for (const key of ["isFeatured", "isBestSeller", "isActive"]) {
    if (own(body, key)) result[key] = boolean(body[key]);
  }

  if (own(body, "isNewArrival")) {
    result.isNewArrival = boolean(body.isNewArrival);
  } else if (own(body, "isNew")) {
    result.isNewArrival = boolean(body.isNew);
  }

  // The server owns product codes and variant SKUs.
  // Preserve compatibility with older clients sending a parent SKU
  // during creation, but do not allow later SKU changes.
  if (creating && own(body, "sku") && text(body.sku, 100)) {
    result.sku = text(body.sku, 100).toUpperCase();
  }

  return result;
}

function ensureAdmin(req, res) {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Please sign in with an admin account.",
    });

    return false;
  }

  if (req.user.role !== "admin") {
    res.status(403).json({
      success: false,
      message: "Admin access is required.",
    });

    return false;
  }

  return true;
}

function sendError(res, error, fallback) {
  if (error.code === 11000) {
    const field = Object.keys(
      error.keyPattern || error.keyValue || {}
    )[0];

    return res.status(409).json({
      success: false,
      message:
        field === "slug"
          ? "This product URL name is already used. Choose another."
          : "This product code or SKU is already used. Refresh and try again.",
    });
  }

  if (error.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      message:
        Object.values(error.errors || {})[0]?.message ||
        "Please check the product details.",
    });
  }

  if (error.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: "A product value is invalid.",
    });
  }

  const status =
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : 500;

  if (status >= 500) {
    console.error("Product request failed:", error.name);
  }

  return res.status(status).json({
    success: false,
    message: status >= 500 ? fallback : error.message,
  });
}

async function findProduct(identifier, activeOnly = false) {
  const value = text(identifier, 200);

  if (!value) return null;

  const alternatives = [{ slug: value.toLowerCase() }];

  if (/^[a-f0-9]{24}$/i.test(value)) {
    alternatives.push({ _id: value });
  }

  if (/^\d+$/.test(value)) {
    const legacyId = Number(value);

    if (Number.isSafeInteger(legacyId) && legacyId > 0) {
      alternatives.push({ legacyId });
    }
  }

  const filter = { $or: alternatives };

  if (activeOnly) filter.isActive = true;

  return Product.findOne(filter);
}

function hasVariants(value) {
  return Boolean(value && Object.keys(value).length);
}

function applyPatch(product, payload) {
  const patch = { ...payload };

  if (own(patch, "delivery")) {
    const current =
      product.delivery?.toObject?.() || product.delivery || {};

    product.delivery = { ...current, ...patch.delivery };
    delete patch.delivery;
  }

  product.set(patch);

  for (const key of ["variants", "specifications"]) {
    if (own(payload, key)) product.markModified(key);
  }
}

async function getProducts(req, res) {
  try {
    const products = await Product.find({ isActive: true });
    const reviewed = await attachReviews(products);

    res.json({
      success: true,
      count: reviewed.length,
      products: reviewed,
    });
  } catch (error) {
    sendError(res, error, "Unable to load products.");
  }
}

async function getProductById(req, res) {
  try {
    const product = await findProduct(req.params.id, true);

    if (!product) throw httpError(404, "Product not found.");

    const [reviewed] = await attachReviews([product]);

    res.json({ success: true, product: reviewed });
  } catch (error) {
    sendError(res, error, "Unable to load this product.");
  }
}

async function getAdminProductOptions(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    // Includes archived products so their categories/brands remain usable.
    const [categories, brands, pairs] = await Promise.all([
      Product.distinct("category"),
      Product.distinct("brand"),
      Product.aggregate([
        {
          $match: {
            category: { $type: "string" },
            subcategory: { $type: "string", $ne: "" },
          },
        },
        {
          $group: {
            _id: {
              category: "$category",
              subcategory: "$subcategory",
            },
          },
        },
        {
          $sort: {
            "_id.category": 1,
            "_id.subcategory": 1,
          },
        },
      ]),
    ]);

    const subcategories = {};

    for (const { _id } of pairs) {
      const category = _id.category;

      if (!own(subcategories, category)) {
        Object.defineProperty(subcategories, category, {
          value: [],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      subcategories[category].push(_id.subcategory);
    }

    res.json({
      success: true,
      categories: categories.filter(Boolean).sort(),
      brands: brands.filter(Boolean).sort(),
      subcategories,
    });
  } catch (error) {
    sendError(res, error, "Unable to load category and brand options.");
  }
}

async function getAdminProducts(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    const search = text(req.query.search, 150);
    const category = text(req.query.category, 100);
    const active = text(req.query.active, 20);

    const page = Math.min(
      1000000,
      Math.max(1, parseInt(req.query.page, 10) || 1)
    );

    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 25)
    );

    const filter = {};

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");

      filter.$or = [
        "name",
        "slug",
        "sku",
        "productCode",
        "variantSkus.sku",
        "brand",
        "category",
        "subcategory",
      ].map((field) => ({ [field]: regex }));
    }

    if (category) {
      filter.category = new RegExp(
        `^${escapeRegex(category)}$`,
        "i"
      );
    }

    if (
      ["in-stock", "low-stock", "out-of-stock"].includes(
        req.query.stockStatus
      )
    ) {
      filter.stockStatus = req.query.stockStatus;
    }

    if (["true", "false"].includes(active)) {
      filter.isActive = active === "true";
    }

    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
    ]);

    res.json({
      success: true,
      count: products.length,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      limit,
      products,
    });
  } catch (error) {
    sendError(res, error, "Unable to load admin products.");
  }
}

async function getAdminProductById(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    const product = await findProduct(req.params.id);

    if (!product) throw httpError(404, "Product not found.");

    res.json({ success: true, product });
  } catch (error) {
    sendError(res, error, "Unable to load this product.");
  }
}

async function createProduct(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    const payload = normalizePayload(req.body, true);

    if (!payload.name || payload.name.length < 2) {
      throw httpError(400, "Enter a product name.");
    }

    if (!payload.category) {
      throw httpError(400, "Choose a product category.");
    }

    if (!Number.isFinite(payload.price)) {
      throw httpError(400, "Enter a valid product price.");
    }

    const id = new mongoose.Types.ObjectId();

    if (!payload.slug) {
      const base = slugify(payload.name) || "product";
      payload.slug = `${base.slice(0, 150)}-${String(id)}`;
    }

    const product = new Product({
      ...payload,
      _id: id,
      isActive: true,
    });

    await product.save();

    res.status(201).json({
      success: true,
      message: "Product and stock saved successfully.",
      product,
    });
  } catch (error) {
    sendError(res, error, "Unable to create this product.");
  }
}

async function updateProduct(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    const product = await findProduct(req.params.id);

    if (!product) throw httpError(404, "Product not found.");

    const payload = normalizePayload(req.body);

    if (!Object.keys(payload).length) {
      throw httpError(400, "No product changes were provided.");
    }

    if (
      own(payload, "stock") &&
      !own(payload, "variants") &&
      hasVariants(product.variants)
    ) {
      throw httpError(
        400,
        "Update individual variant quantities for this product."
      );
    }

    applyPatch(product, payload);
    await product.save();

    res.json({
      success: true,
      message: "Product and stock updated successfully.",
      product,
    });
  } catch (error) {
    sendError(res, error, "Unable to update this product.");
  }
}

async function updateProductInventory(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    const product = await findProduct(req.params.id);

    if (!product) throw httpError(404, "Product not found.");

    object(req.body, "Inventory");

    const hasMatrix = own(req.body, "variants");
    const hasStock = own(req.body, "stock");

    if (!hasMatrix && !hasStock) {
      throw httpError(400, "Provide stock quantities.");
    }

    if (hasMatrix) {
      const variants = normalizeVariants(req.body.variants);

      if (
        (product.colors.length || product.sizes.length) &&
        !hasVariants(variants)
      ) {
        throw httpError(
          400,
          "Provide the quantities for this product's options."
        );
      }

      product.variants = variants;
      product.markModified("variants");
    }

    if (hasStock) {
      if (hasVariants(product.variants)) {
        throw httpError(
          400,
          "Update individual variant quantities instead of total stock."
        );
      }

      product.stock = number(
        req.body.stock,
        "stock",
        1000000,
        true
      );
    }

    await product.save();

    res.json({
      success: true,
      message: "Inventory updated successfully.",
      product,
    });
  } catch (error) {
    sendError(res, error, "Unable to update inventory.");
  }
}

async function setVisibility(req, res, isActive) {
  if (!ensureAdmin(req, res)) return;

  try {
    const product = await findProduct(req.params.id);

    if (!product) throw httpError(404, "Product not found.");

    product.isActive = isActive;
    await product.save();

    res.json({
      success: true,
      message: isActive ? "Product restored." : "Product archived.",
      product,
    });
  } catch (error) {
    sendError(res, error, "Unable to change product visibility.");
  }
}

const deleteProduct = (req, res) => setVisibility(req, res, false);
const restoreProduct = (req, res) => setVisibility(req, res, true);

module.exports = {
  getProducts,
  getProductById,
  getAdminProducts,
  getAdminProductById,
  getAdminProductOptions,
  createProduct,
  updateProduct,
  updateProductInventory,
  deleteProduct,
  restoreProduct,
};