const mongoose = require("mongoose");
const Product = require("../models/Product");

const {
  attachReviews,
} = require("../utils/productReviews");

// ======================================================
// HELPERS
// ======================================================

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(
    object || {},
    key,
  );
}

function cleanString(value, maxLength = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function slugify(value) {
  return cleanString(value, 300)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function escapeRegex(value) {
  return String(value ?? "").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (
    value === 1 ||
    value === "1" ||
    value === "true"
  ) {
    return true;
  }

  if (
    value === 0 ||
    value === "0" ||
    value === "false"
  ) {
    return false;
  }

  return fallback;
}

function cleanStringArray(
  value,
  maxItems = 100,
  maxLength = 300,
) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const item of value) {
    const text = cleanString(item, maxLength);

    if (!text) {
      continue;
    }

    const key = text.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(text);

    if (result.length >= maxItems) {
      break;
    }
  }

  return result;
}

function hasVariantMatrix(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0,
  );
}

function cleanVariantKey(value, label) {
  const key = cleanString(value, 80);

  if (!key) {
    throw httpError(
      400,
      `${label} cannot be empty.`,
    );
  }

  if (
    key.startsWith("$") ||
    key.includes(".")
  ) {
    throw httpError(
      400,
      `${label} cannot start with $ or contain a dot.`,
    );
  }

  return key;
}

// ======================================================
// NORMALIZE VARIANTS
// ======================================================

function normalizeVariants(value) {
  if (value == null) {
    return {};
  }

  if (
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw httpError(
      400,
      "Variants must be an object.",
    );
  }

  const result = {};

  const colorEntries = Object.entries(value).slice(
    0,
    100,
  );

  for (const [rawColor, rawOptions] of colorEntries) {
    const color = cleanVariantKey(
      rawColor,
      "Variant colour",
    );

    if (
      !rawOptions ||
      typeof rawOptions !== "object" ||
      Array.isArray(rawOptions)
    ) {
      throw httpError(
        400,
        `Variant ${color} must contain stock values.`,
      );
    }

    const options = {};

    const optionEntries = Object.entries(
      rawOptions,
    ).slice(0, 100);

    for (const [rawOption, rawQuantity] of optionEntries) {
      const option = cleanVariantKey(
        rawOption,
        "Variant option",
      );

      const quantity = Number(rawQuantity);

      if (
        !Number.isFinite(quantity) ||
        quantity < 0 ||
        quantity > 1000000
      ) {
        throw httpError(
          400,
          `Invalid stock quantity for ${color} / ${option}.`,
        );
      }

      options[option] = Math.floor(quantity);
    }

    result[color] = options;
  }

  return result;
}

// ======================================================
// NORMALIZE SPECIFICATIONS
// ======================================================

function normalizeSpecifications(value) {
  if (value == null) {
    return {};
  }

  if (
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw httpError(
      400,
      "Specifications must be an object.",
    );
  }

  const result = {};

  for (const [rawKey, rawValue] of Object.entries(
    value,
  ).slice(0, 100)) {
    const key = cleanString(rawKey, 100);

    if (!key) {
      continue;
    }

    if (
      key.startsWith("$") ||
      key.includes(".")
    ) {
      throw httpError(
        400,
        "Specification names cannot start with $ or contain a dot.",
      );
    }

    if (typeof rawValue === "string") {
      result[key] = cleanString(rawValue, 1000);
    } else if (
      typeof rawValue === "number" &&
      Number.isFinite(rawValue)
    ) {
      result[key] = rawValue;
    } else if (typeof rawValue === "boolean") {
      result[key] = rawValue;
    } else if (Array.isArray(rawValue)) {
      result[key] = cleanStringArray(
        rawValue,
        50,
        300,
      );
    } else if (rawValue == null) {
      result[key] = "";
    } else {
      result[key] = cleanString(rawValue, 1000);
    }
  }

  return result;
}

// ======================================================
// NORMALIZE DELIVERY
// ======================================================

function normalizeDelivery(value) {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw httpError(
      400,
      "Delivery settings must be an object.",
    );
  }

  const result = {};

  if (hasOwn(value, "available")) {
    result.available = parseBoolean(
      value.available,
      true,
    );
  }

  if (hasOwn(value, "estimatedDays")) {
    result.estimatedDays =
      value.estimatedDays == null ||
      value.estimatedDays === ""
        ? null
        : cleanString(value.estimatedDays, 100);
  }

  if (hasOwn(value, "freeDeliveryAbove")) {
    const amount = Number(value.freeDeliveryAbove);

    if (
      !Number.isFinite(amount) ||
      amount < 0
    ) {
      throw httpError(
        400,
        "Free delivery amount must be zero or more.",
      );
    }

    result.freeDeliveryAbove = amount;
  }

  return result;
}

// ======================================================
// NORMALIZE PRODUCT PAYLOAD
// ======================================================

function normalizeProductPayload(
  body = {},
  { creating = false } = {},
) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw httpError(
      400,
      "Product data is invalid.",
    );
  }

  const payload = {};

  const stringFields = [
    ["name", 200],
    ["category", 100],
    ["subcategory", 100],
    ["brand", 100],
    ["gender", 50],
    ["badge", 80],
    ["material", 500],
    ["whatsIncluded", 1000],
    ["image", 2000],
    ["description", 5000],
    ["returnPolicy", 2000],
  ];

  for (const [field, maxLength] of stringFields) {
    if (hasOwn(body, field)) {
      payload[field] = cleanString(
        body[field],
        maxLength,
      );
    }
  }

  if (hasOwn(body, "slug")) {
    payload.slug = slugify(body.slug);
  } else if (creating && hasOwn(body, "name")) {
    payload.slug = slugify(body.name);
  }

  if (hasOwn(body, "sku")) {
    payload.sku = cleanString(
      body.sku,
      100,
    ).toUpperCase();
  }

  if (hasOwn(body, "legacyId")) {
    if (
      body.legacyId == null ||
      body.legacyId === ""
    ) {
      payload.legacyId = null;
    } else {
      const legacyId = Number(body.legacyId);

      if (
        !Number.isSafeInteger(legacyId) ||
        legacyId < 1
      ) {
        throw httpError(
          400,
          "Legacy product ID must be a positive integer.",
        );
      }

      payload.legacyId = legacyId;
    }
  }

  if (hasOwn(body, "price")) {
    const price = Number(body.price);

    if (
      !Number.isFinite(price) ||
      price < 0
    ) {
      throw httpError(
        400,
        "Product price must be zero or more.",
      );
    }

    payload.price = price;
  }

  if (hasOwn(body, "discount")) {
    const discount = Number(body.discount);

    if (
      !Number.isFinite(discount) ||
      discount < 0 ||
      discount > 100
    ) {
      throw httpError(
        400,
        "Discount must be between 0 and 100.",
      );
    }

    payload.discount = discount;
  }

  if (hasOwn(body, "stock")) {
    const stock = Number(body.stock);

    if (
      !Number.isFinite(stock) ||
      stock < 0 ||
      stock > 1000000
    ) {
      throw httpError(
        400,
        "Stock must be a valid quantity of zero or more.",
      );
    }

    payload.stock = Math.floor(stock);
  }

  if (hasOwn(body, "tags")) {
    payload.tags = cleanStringArray(
      body.tags,
      50,
      100,
    );
  }

  if (hasOwn(body, "highlights")) {
    payload.highlights = cleanStringArray(
      body.highlights,
      30,
      500,
    );
  }

  if (hasOwn(body, "careInstructions")) {
    payload.careInstructions = cleanStringArray(
      body.careInstructions,
      30,
      500,
    );
  }

  if (hasOwn(body, "sizes")) {
    payload.sizes = cleanStringArray(
      body.sizes,
      50,
      50,
    );
  }

  if (hasOwn(body, "colors")) {
    payload.colors = cleanStringArray(
      body.colors,
      50,
      80,
    );
  }

  if (hasOwn(body, "images")) {
    payload.images = cleanStringArray(
      body.images,
      20,
      2000,
    );
  }

  if (hasOwn(body, "variants")) {
    payload.variants = normalizeVariants(
      body.variants,
    );
  }

  if (hasOwn(body, "specifications")) {
    payload.specifications = normalizeSpecifications(
      body.specifications,
    );
  }

  if (hasOwn(body, "delivery")) {
    payload.delivery = normalizeDelivery(
      body.delivery,
    );
  }

  const booleanFields = [
    "isFeatured",
    "isBestSeller",
    "isActive",
  ];

  for (const field of booleanFields) {
    if (hasOwn(body, field)) {
      payload[field] = parseBoolean(body[field]);
    }
  }

  if (hasOwn(body, "isNewArrival")) {
    payload.isNewArrival = parseBoolean(
      body.isNewArrival,
    );
  } else if (hasOwn(body, "isNew")) {
    payload.isNewArrival = parseBoolean(
      body.isNew,
    );
  }

  return payload;
}

// ======================================================
// CREATE VALIDATION
// ======================================================

function validateCreatePayload(payload) {
  if (
    !payload.name ||
    payload.name.length < 2
  ) {
    throw httpError(
      400,
      "Enter a product name.",
    );
  }

  if (!payload.slug) {
    throw httpError(
      400,
      "A valid product slug is required.",
    );
  }

  if (!payload.category) {
    throw httpError(
      400,
      "Choose a product category.",
    );
  }

  if (!Number.isFinite(payload.price)) {
    throw httpError(
      400,
      "Enter a valid product price.",
    );
  }

  if (!payload.sku) {
    throw httpError(
      400,
      "Enter a product SKU.",
    );
  }
}

// ======================================================
// FIND PRODUCT
// Supports MongoDB ID, legacy numeric ID, and slug.
// ======================================================

async function findProductByIdentifier(
  identifier,
  { activeOnly = false } = {},
) {
  const text = cleanString(identifier, 200);

  if (!text) {
    return null;
  }

  const conditions = [];

  if (mongoose.Types.ObjectId.isValid(text)) {
    conditions.push({ _id: text });
  }

  const legacyId = Number(text);

  if (
    Number.isSafeInteger(legacyId) &&
    legacyId >= 1
  ) {
    conditions.push({ legacyId });
  }

  conditions.push({
    slug: text.toLowerCase(),
  });

  const filter = {
    $or: conditions,
  };

  if (activeOnly) {
    filter.isActive = true;
  }

  return Product.findOne(filter);
}

// ======================================================
// ADMIN GUARD
// ======================================================

function ensureAdmin(req, res) {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Admin login is required.",
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

// ======================================================
// ERROR RESPONSES
// ======================================================

function sendError(res, error, fallbackMessage) {
  if (error?.code === 11000) {
    const field = Object.keys(
      error.keyPattern ||
        error.keyValue ||
        {},
    )[0];

    const label =
      field === "sku"
        ? "SKU"
        : field === "slug"
          ? "slug"
          : field || "value";

    return res.status(409).json({
      success: false,
      message:
        `A product with this ${label} already exists.`,
    });
  }

  if (error?.name === "ValidationError") {
    const firstMessage = Object.values(
      error.errors || {},
    )[0]?.message;

    return res.status(400).json({
      success: false,
      message:
        firstMessage ||
        error.message ||
        "Product validation failed.",
    });
  }

  if (error?.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: "Invalid product value.",
    });
  }

  const status =
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : 500;

  return res.status(status).json({
    success: false,
    message:
      error?.message || fallbackMessage,
  });
}

// ======================================================
// APPLY PRODUCT CHANGES
// ======================================================

function currentDelivery(product) {
  if (!product?.delivery) {
    return {};
  }

  if (
    typeof product.delivery.toObject === "function"
  ) {
    return product.delivery.toObject();
  }

  return { ...product.delivery };
}

function applyProductPatch(product, payload) {
  const patch = { ...payload };

  if (hasOwn(patch, "delivery")) {
    product.delivery = {
      ...currentDelivery(product),
      ...patch.delivery,
    };

    delete patch.delivery;
  }

  product.set(patch);

  if (hasOwn(payload, "variants")) {
    product.markModified("variants");
  }

  if (hasOwn(payload, "specifications")) {
    product.markModified("specifications");
  }
}

// ======================================================
// PUBLIC — GET PRODUCTS
// ======================================================

async function getProducts(req, res) {
  try {
    const products = await Product.find({
      isActive: true,
    });

    const productsWithReviews =
      await attachReviews(products);

    return res.status(200).json({
      success: true,
      count: productsWithReviews.length,
      products: productsWithReviews,
    });
  } catch (error) {
    console.error(
      "Get products error:",
      error,
    );

    return sendError(
      res,
      error,
      "Unable to load products.",
    );
  }
}

// ======================================================
// PUBLIC — GET ONE PRODUCT
// ======================================================

async function getProductById(req, res) {
  try {
    const product = await findProductByIdentifier(
      req.params.id,
      { activeOnly: true },
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    const [productWithReviews] =
      await attachReviews([product]);

    return res.status(200).json({
      success: true,
      product: productWithReviews,
    });
  } catch (error) {
    console.error(
      "Get product error:",
      error,
    );

    return sendError(
      res,
      error,
      "Unable to load product.",
    );
  }
}

// ======================================================
// ADMIN — GET ALL PRODUCTS
// ======================================================

async function getAdminProducts(req, res) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const search = cleanString(
      req.query.search,
      150,
    );

    const category = cleanString(
      req.query.category,
      100,
    );

    const stockStatus = cleanString(
      req.query.stockStatus,
      50,
    );

    const active = cleanString(
      req.query.active,
      20,
    ).toLowerCase();

    const page = Math.max(
      1,
      Number.parseInt(req.query.page, 10) || 1,
    );

    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.parseInt(req.query.limit, 10) || 25,
      ),
    );

    const filter = {};

    if (search) {
      const regex = new RegExp(
        escapeRegex(search),
        "i",
      );

      filter.$or = [
        { name: regex },
        { slug: regex },
        { sku: regex },
        { brand: regex },
        { category: regex },
        { subcategory: regex },
      ];
    }

    if (category) {
      filter.category = new RegExp(
        `^${escapeRegex(category)}$`,
        "i",
      );
    }

    if (
      [
        "in-stock",
        "low-stock",
        "out-of-stock",
      ].includes(stockStatus)
    ) {
      filter.stockStatus = stockStatus;
    }

    if (
      active === "true" ||
      active === "false"
    ) {
      filter.isActive = active === "true";
    }

    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort({
          updatedAt: -1,
          _id: -1,
        })
        .skip((page - 1) * limit)
        .limit(limit),

      Product.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: products.length,
      total,
      page,
      pages: Math.max(
        1,
        Math.ceil(total / limit),
      ),
      limit,
      products,
    });
  } catch (error) {
    console.error(
      "Get admin products error:",
      error,
    );

    return sendError(
      res,
      error,
      "Unable to load admin products.",
    );
  }
}

// ======================================================
// ADMIN — GET ONE PRODUCT
// ======================================================

async function getAdminProductById(req, res) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const product = await findProductByIdentifier(
      req.params.id,
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    return res.status(200).json({
      success: true,
      product,
    });
  } catch (error) {
    console.error(
      "Get admin product error:",
      error,
    );

    return sendError(
      res,
      error,
      "Unable to load product.",
    );
  }
}

// ======================================================
// ADMIN — CREATE PRODUCT
// ======================================================

async function createProduct(req, res) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const payload = normalizeProductPayload(
      req.body,
      { creating: true },
    );

    validateCreatePayload(payload);

    const product = new Product(payload);

    // save() runs the Product model's calculations.
    await product.save();

    return res.status(201).json({
      success: true,
      message: "Product created successfully.",
      product,
    });
  } catch (error) {
    console.error(
      "Create product error:",
      error,
    );

    return sendError(
      res,
      error,
      "Unable to create product.",
    );
  }
}

// ======================================================
// ADMIN — UPDATE PRODUCT
// ======================================================

async function updateProduct(req, res) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const product = await findProductByIdentifier(
      req.params.id,
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    const payload = normalizeProductPayload(
      req.body,
    );

    if (Object.keys(payload).length === 0) {
      throw httpError(
        400,
        "No product changes were provided.",
      );
    }

    if (
      hasOwn(payload, "stock") &&
      !hasOwn(payload, "variants") &&
      hasVariantMatrix(product.variants)
    ) {
      throw httpError(
        400,
        "This product uses variant stock. Update the variant quantities instead of the total stock value.",
      );
    }

    applyProductPatch(product, payload);

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Product updated successfully.",
      product,
    });
  } catch (error) {
    console.error(
      "Update product error:",
      error,
    );

    return sendError(
      res,
      error,
      "Unable to update product.",
    );
  }
}

// ======================================================
// ADMIN — UPDATE INVENTORY
// ======================================================

async function updateProductInventory(req, res) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const product = await findProductByIdentifier(
      req.params.id,
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    const hasVariantsInput = hasOwn(
      req.body,
      "variants",
    );

    const hasStockInput = hasOwn(
      req.body,
      "stock",
    );

    if (
      !hasVariantsInput &&
      !hasStockInput
    ) {
      throw httpError(
        400,
        "Provide variant stock or a total stock quantity.",
      );
    }

    if (hasVariantsInput) {
      product.variants = normalizeVariants(
        req.body.variants,
      );

      product.markModified("variants");
    }

    if (hasStockInput) {
      const stock = Number(req.body.stock);

      if (
        !Number.isFinite(stock) ||
        stock < 0 ||
        stock > 1000000
      ) {
        throw httpError(
          400,
          "Stock must be a valid quantity of zero or more.",
        );
      }

      if (
        !hasVariantsInput &&
        hasVariantMatrix(product.variants)
      ) {
        throw httpError(
          400,
          "This product uses variant stock. Update the variant quantities instead.",
        );
      }

      product.stock = Math.floor(stock);
    }

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Inventory updated successfully.",
      product,
    });
  } catch (error) {
    console.error(
      "Update inventory error:",
      error,
    );

    return sendError(
      res,
      error,
      "Unable to update inventory.",
    );
  }
}

// ======================================================
// ADMIN — ARCHIVE PRODUCT
// Existing order references are preserved.
// ======================================================

async function deleteProduct(req, res) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const product = await findProductByIdentifier(
      req.params.id,
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    if (product.isActive === false) {
      return res.status(200).json({
        success: true,
        message: "Product is already archived.",
        product,
      });
    }

    product.isActive = false;

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Product archived successfully.",
      product,
    });
  } catch (error) {
    console.error(
      "Archive product error:",
      error,
    );

    return sendError(
      res,
      error,
      "Unable to archive product.",
    );
  }
}

// ======================================================
// ADMIN — RESTORE PRODUCT
// ======================================================

async function restoreProduct(req, res) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const product = await findProductByIdentifier(
      req.params.id,
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    if (product.isActive === true) {
      return res.status(200).json({
        success: true,
        message: "Product is already active.",
        product,
      });
    }

    product.isActive = true;

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Product restored successfully.",
      product,
    });
  } catch (error) {
    console.error(
      "Restore product error:",
      error,
    );

    return sendError(
      res,
      error,
      "Unable to restore product.",
    );
  }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  getProducts,
  getProductById,
  getAdminProducts,
  getAdminProductById,
  createProduct,
  updateProduct,
  updateProductInventory,
  deleteProduct,
  restoreProduct,
};