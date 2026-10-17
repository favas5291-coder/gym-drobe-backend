const {
  normalizeColorImages,
} = require("../../utils/productImages");

const {
  normalizeMeeshoLink,
  safeMeeshoLink,
} = require("../../utils/meeshoUrl");

const mongoose = require("mongoose");

const {
  normalizeProductVideo,
  productVideo,
} = require("../../utils/productVideo");

const Product = require("../../models/Product");
const Supplier = require("../../models/Supplier");

const {
  attachReviews,
} = require("../../utils/productReviews");

const own = (object, key) =>
  Object.prototype.hasOwnProperty.call(
    object || {},
    key
  );

const forbiddenKeys = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const ADMIN_FIELDS =
  "+supplier +purchaseCost +fulfillment +meeshoProductLink";

const SUPPLIER_FIELDS =
  "+contact +verification +fulfillment";

const KIT_ROLES = [
  "clothing",
  "footwear",
  "supplements",
  "training-accessories",
  "gym-bag",
  "bottle-or-shaker",
  "workout-essentials",
];

const SIZE_LABELS = [
  "Size",
  "Pack size",
  "Capacity",
  "Weight",
  "Length",
  "Option",
];

const COLOR_LABELS = [
  "Colour",
  "Flavour",
  "Style",
  "Material",
  "Option",
];

const STOCK_SOURCES = [
  "unconfirmed",
  "gymdrobe",
  "supplier",
];

const DISPATCH_METHODS = [
  "unconfirmed",
  "gymdrobe",
  "supplier",
  "fulfillment-partner",
];

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;

  if (code) {
    error.code = code;
  }

  return error;
}

function text(value, maximum = 500) {
  if (
    value != null &&
    typeof value !== "string"
  ) {
    throw httpError(
      400,
      "Text fields must contain text."
    );
  }

  const result = String(value ?? "").trim();

  if (result.length > maximum) {
    throw httpError(
      400,
      `Text cannot exceed ${maximum} characters.`
    );
  }

  return result;
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
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function boolean(value) {
  if (
    [true, "true", 1, "1"].includes(value)
  ) {
    return true;
  }

  if (
    [false, "false", 0, "0"].includes(value)
  ) {
    return false;
  }

  throw httpError(
    400,
    "Invalid checkbox value."
  );
}

function number(
  value,
  label,
  maximum,
  integer = false
) {
  if (
    value == null ||
    (
      typeof value === "string" &&
      !value.trim()
    ) ||
    !["number", "string"].includes(
      typeof value
    )
  ) {
    throw httpError(
      400,
      `Enter a valid ${label}.`
    );
  }

  const result = Number(value);

  if (
    !Number.isFinite(result) ||
    result < 0 ||
    result > maximum ||
    (
      integer &&
      !Number.isSafeInteger(result)
    )
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

function array(
  value,
  maximum = 100,
  length = 300,
  caseSensitive = false
) {
  if (
    !Array.isArray(value) ||
    value.length > maximum
  ) {
    throw httpError(
      400,
      `Provide a list containing no more than ${maximum} entries.`
    );
  }

  const seen = new Set();

  return value
    .map((item) => text(item, length))
    .filter((item) => {
      const key = caseSensitive
        ? item
        : item.toLowerCase();

      if (!item || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

function object(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.prototype.toString.call(value) !==
      "[object Object]"
  ) {
    throw httpError(
      400,
      `${label} must be an object.`
    );
  }
}

function safeKey(value, maximum = 100) {
  const key = text(value, maximum);

  if (
    !key ||
    forbiddenKeys.has(key) ||
    key.startsWith("$") ||
    key.includes(".") ||
    /[\u0000-\u001f\u007f]/.test(key)
  ) {
    throw httpError(
      400,
      "Option and specification names cannot contain dots, " +
        "control characters, start with $, or use reserved names."
    );
  }

  return key;
}

function choice(value, choices, label) {
  const result = text(value, 80);

  if (!choices.includes(result)) {
    throw httpError(
      400,
      `Choose a valid ${label}.`
    );
  }

  return result;
}

function reference(value, label) {
  if (value == null || value === "") {
    return null;
  }

  const result = text(value, 24);

  if (!/^[a-f0-9]{24}$/i.test(result)) {
    throw httpError(
      400,
      `Choose a valid ${label}.`
    );
  }

  return result;
}

function days(value, label) {
  return value == null || value === ""
    ? null
    : number(value, label, 365, true);
}

function knownKeys(
  value,
  allowed,
  label
) {
  object(value, label);

  if (
    Object.keys(value).some(
      (key) => !allowed.includes(key)
    )
  ) {
    throw httpError(
      400,
      `${label} contains an unsupported setting.`
    );
  }
}

function normalizeVariants(value) {
  if (value == null) {
    return {};
  }

  object(value, "Variant stock");

  const entries = Object.entries(value);

  if (entries.length > 50) {
    throw httpError(
      400,
      "Use no more than 50 size or colour groups."
    );
  }

  const result = {};

  for (const [first, group] of entries) {
    const key = safeKey(first, 80);

    if (own(result, key)) {
      throw httpError(
        400,
        "Variant group names must be unique."
      );
    }

    if (
      group &&
      typeof group === "object"
    ) {
      object(group, "Variant options");

      const options = Object.entries(group);

      if (options.length > 50) {
        throw httpError(
          400,
          "Use no more than 50 options per group."
        );
      }

      result[key] = {};

      for (const [
        second,
        quantity,
      ] of options) {
        const option = safeKey(second, 80);

        if (own(result[key], option)) {
          throw httpError(
            400,
            "Variant option names must be unique."
          );
        }

        result[key][option] = number(
          quantity,
          `${key} / ${option} stock`,
          1000000,
          true
        );
      }
    } else {
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
    throw httpError(
      400,
      "Use no more than 100 specifications."
    );
  }

  const result = {};

  for (const [rawKey, value] of entries) {
    const key = safeKey(rawKey);

    if (
      Object.keys(result).some(
        (existing) =>
          existing.toLowerCase() ===
          key.toLowerCase()
      )
    ) {
      throw httpError(
        400,
        `The specification "${key}" is repeated.`
      );
    }

    if (Array.isArray(value)) {
      result[key] = array(
        value,
        50,
        300
      );
    } else if (
      typeof value === "boolean" ||
      (
        typeof value === "number" &&
        Number.isFinite(value)
      )
    ) {
      result[key] = value;
    } else {
      result[key] = text(value, 1000);
    }
  }

  return result;
}

function normalizeDelivery(value) {
  knownKeys(
    value,
    [
      "available",
      "estimatedDays",
      "freeDeliveryAbove",
      "transitDaysMin",
      "transitDaysMax",
    ],
    "Delivery settings"
  );

  const result = {};

  if (own(value, "available")) {
    result.available = boolean(
      value.available
    );
  }

  if (own(value, "estimatedDays")) {
    result.estimatedDays =
      text(value.estimatedDays, 100) ||
      null;
  }

  if (own(value, "freeDeliveryAbove")) {
    result.freeDeliveryAbove = number(
      value.freeDeliveryAbove,
      "free delivery threshold",
      100000000
    );
  }

  for (const key of [
    "transitDaysMin",
    "transitDaysMax",
  ]) {
    if (own(value, key)) {
      result[key] = days(
        value[key],
        "transit days"
      );
    }
  }

  return result;
}

function normalizeFulfillment(value) {
  knownKeys(
    value,
    [
      "stockSource",
      "dispatchBy",
      "preparationDaysMin",
      "preparationDaysMax",
      "canSendToPackingLocation",
      "supplierStockConfirmedAt",
    ],
    "Fulfillment settings"
  );

  const result = {};

  if (own(value, "stockSource")) {
    result.stockSource = choice(
      value.stockSource,
      STOCK_SOURCES,
      "stock source"
    );
  }

  if (own(value, "dispatchBy")) {
    result.dispatchBy = choice(
      value.dispatchBy,
      DISPATCH_METHODS,
      "dispatch responsibility"
    );
  }

  for (const key of [
    "preparationDaysMin",
    "preparationDaysMax",
  ]) {
    if (own(value, key)) {
      result[key] = days(
        value[key],
        "preparation days"
      );
    }
  }

  if (
    own(
      value,
      "canSendToPackingLocation"
    )
  ) {
    result.canSendToPackingLocation =
      boolean(
        value.canSendToPackingLocation
      );
  }

  // A form can clear this timestamp.
  // Only confirmSupplierStock records a new confirmation.
  if (
    own(
      value,
      "supplierStockConfirmedAt"
    ) &&
    value.supplierStockConfirmedAt == null
  ) {
    result.supplierStockConfirmedAt = null;
  }

  return result;
}

function normalizeKitSettings(value) {
  knownKeys(
    value,
    ["eligible", "roles"],
    "Kit settings"
  );

  const result = {};

  if (own(value, "eligible")) {
    result.eligible = boolean(
      value.eligible
    );
  }

  if (own(value, "roles")) {
    result.roles = array(
      value.roles,
      7,
      40
    ).map((role) =>
      choice(
        role,
        KIT_ROLES,
        "kit category"
      )
    );
  }

  return result;
}

function normalizeOptionLabels(value) {
  knownKeys(
    value,
    ["size", "color"],
    "Option labels"
  );

  const result = {};

  if (own(value, "size")) {
    result.size = choice(
      value.size,
      SIZE_LABELS,
      "size option label"
    );
  }

  if (own(value, "color")) {
    result.color = choice(
      value.color,
      COLOR_LABELS,
      "colour option label"
    );
  }

  return result;
}

function normalizePayload(body) {
  object(body, "Product data");

  const result = {};

  if (own(body, "meeshoProductLink")) {
    try {
      result.meeshoProductLink =
        normalizeMeeshoLink(
          body.meeshoProductLink
        );
    } catch (error) {
      throw httpError(
        400,
        error.message
      );
    }
  }

  if (own(body, "videoUrl")) {
    try {
      result.videoUrl =
        normalizeProductVideo(
          body.videoUrl
        );
    } catch (error) {
      throw httpError(
        400,
        error.message
      );
    }
  }

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
    returnConditions: 2000,
  };

  for (const [
    key,
    maximum,
  ] of Object.entries(strings)) {
    if (own(body, key)) {
      result[key] = text(
        body[key],
        maximum
      );
    }
  }

  if (
    own(result, "name") &&
    result.name.length < 2
  ) {
    throw httpError(
      400,
      "Product name must contain at least 2 characters."
    );
  }

  for (const key of [
    "category",
    "brand",
  ]) {
    if (
      own(result, key) &&
      !result[key]
    ) {
      throw httpError(
        400,
        `Choose a product ${key}.`
      );
    }
  }

  if (own(body, "slug")) {
    result.slug = slugify(body.slug);

    if (!result.slug) {
      throw httpError(
        400,
        "Enter a valid product URL name."
      );
    }
  }

  if (own(body, "price")) {
    result.price = number(
      body.price,
      "price",
      100000000
    );
  }

  if (own(body, "discount")) {
    result.discount = number(
      body.discount,
      "discount",
      100
    );
  }

  if (own(body, "stock")) {
    result.stock = number(
      body.stock,
      "stock",
      1000000,
      true
    );
  }

  if (own(body, "legacyId")) {
    result.legacyId =
      body.legacyId == null ||
      body.legacyId === ""
        ? null
        : number(
            body.legacyId,
            "legacy ID",
            Number.MAX_SAFE_INTEGER,
            true
          );

    if (result.legacyId === 0) {
      throw httpError(
        400,
        "Legacy ID must be a positive integer."
      );
    }
  }

  if (own(body, "supplier")) {
    result.supplier = reference(
      body.supplier,
      "supplier"
    );
  }

  if (own(body, "purchaseCost")) {
    result.purchaseCost =
      body.purchaseCost == null ||
      body.purchaseCost === ""
        ? null
        : number(
            body.purchaseCost,
            "purchase cost",
            100000000
          );

    if (
      result.purchaseCost != null &&
      Math.abs(
        result.purchaseCost * 100 -
          Math.round(
            result.purchaseCost * 100
          )
      ) >= 0.00001
    ) {
      throw httpError(
        400,
        "Purchase cost cannot contain more than two decimal places."
      );
    }
  }

  if (own(body, "returnsEligible")) {
    result.returnsEligible = choice(
      body.returnsEligible,
      [
        "yes",
        "no",
        "unconfirmed",
      ],
      "return eligibility"
    );
  }

  if (own(body, "returnWindowDays")) {
    result.returnWindowDays = number(
      body.returnWindowDays,
      "return window",
      7,
      true
    );

    if (result.returnWindowDays < 1) {
      throw httpError(
        400,
        "The current return window must be 1–7 days."
      );
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

  for (const [
    key,
    limits,
  ] of Object.entries(lists)) {
    if (own(body, key)) {
      result[key] = array(
        body[key],
        ...limits,
        key === "images"
      );
    }
  }

  if (own(body, "colorImages")) {
    try {
      result.colorImages =
        normalizeColorImages(
          body.colorImages,
          result.colors || null
        );
    } catch (error) {
      throw httpError(
        400,
        error.message
      );
    }
  }

  const normalizers = {
    variants: normalizeVariants,
    specifications:
      normalizeSpecifications,
    delivery: normalizeDelivery,
    fulfillment: normalizeFulfillment,
    kitSettings: normalizeKitSettings,
    optionLabels: normalizeOptionLabels,
  };

  for (const [
    key,
    normalize,
  ] of Object.entries(normalizers)) {
    if (own(body, key)) {
      result[key] = normalize(
        body[key]
      );
    }
  }

  for (const key of [
    "isFeatured",
    "isBestSeller",
    "isActive",
  ]) {
    if (own(body, key)) {
      result[key] = boolean(
        body[key]
      );
    }
  }

  if (own(body, "isNewArrival")) {
    result.isNewArrival = boolean(
      body.isNewArrival
    );
  } else if (own(body, "isNew")) {
    result.isNewArrival = boolean(
      body.isNew
    );
  }

  // Codes, SKUs and review ratings stay server-managed.
  return result;
}

function confirmation(body) {
  return own(
    body,
    "confirmSupplierStock"
  )
    ? boolean(
        body.confirmSupplierStock
      )
    : false;
}

function ensureAdmin(req, res) {
  res.set(
    "Cache-Control",
    "no-store"
  );

  if (!req.user) {
    res.status(401).json({
      success: false,
      message:
        "Please sign in with an admin account.",
    });

    return false;
  }

  if (
    req.user.role !== "admin" ||
    req.user.isActive === false
  ) {
    res.status(403).json({
      success: false,
      message:
        "Admin access is required.",
    });

    return false;
  }

  return true;
}

function sendError(
  res,
  error,
  fallback
) {
  if (
    [
      "VersionError",
      "DocumentNotFoundError",
    ].includes(error.name)
  ) {
    return res.status(409).json({
      success: false,
      code: "PRODUCT_CHANGED",

      message:
        "This product changed while saving. Refresh it and " +
        "check current stock before trying again.",
    });
  }

  if (error.code === 11000) {
    const field = Object.keys(
      error.keyPattern ||
      error.keyValue ||
      {}
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
        Object.values(
          error.errors || {}
        )[0]?.message ||
        "Please check the product details.",
    });
  }

  if (error.name === "CastError") {
    return res.status(400).json({
      success: false,
      message:
        "A product value is invalid.",
    });
  }

  const status =
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : 500;

  if (status >= 500) {
    console.error(
      "Product request failed:",
      error.name || "Error"
    );
  }

  return res.status(status).json({
    success: false,

    ...(
      typeof error.code === "string"
        ? { code: error.code }
        : {}
    ),

    message:
      status >= 500
        ? fallback
        : error.message,
  });
}

function serializeProduct(
  product,
  admin = false
) {
  const data =
    typeof product.toObject === "function"
      ? product.toObject({
          transform: false,
          depopulate: true,
        })
      : { ...product };

  if (data._id != null) {
    data.id = String(data._id);

    data.productCode =
      data.productCode ||
      `GD-${String(data._id).toUpperCase()}`;
  }

  data.videoUrl =
    productVideo(data.videoUrl)?.url ||
    "";

  data.isNew = Boolean(
    data.isNewArrival ??
    data.isNew
  );

  delete data.isNewArrival;
  delete data.__v;

  if (admin) {
    data.supplier =
      data.supplier == null
        ? null
        : String(data.supplier);

    data.purchaseCost =
      data.purchaseCost ?? null;

    data.meeshoProductLink =
      safeMeeshoLink(
        data.meeshoProductLink
      );
  } else {
    delete data.supplier;
    delete data.purchaseCost;
    delete data.fulfillment;
    delete data.meeshoProductLink;
  }

  return data;
}

async function findProduct(
  identifier,
  activeOnly = false,
  admin = false
) {
  const value = text(
    identifier,
    200
  );

  if (!value) {
    return null;
  }

  const alternatives = [
    {
      slug: value.toLowerCase(),
    },
  ];

  if (/^[a-f0-9]{24}$/i.test(value)) {
    alternatives.push({
      _id: value,
    });
  }

  if (/^\d+$/.test(value)) {
    const legacyId = Number(value);

    if (
      Number.isSafeInteger(legacyId) &&
      legacyId > 0
    ) {
      alternatives.push({
        legacyId,
      });
    }
  }

  const filter = {
    $or: alternatives,
  };

  if (activeOnly) {
    filter.isActive = true;
  }

  const query = Product.findOne(
    filter
  );

  return admin
    ? query.select(ADMIN_FIELDS)
    : query;
}

function hasVariants(value) {
  return Boolean(
    value &&
    Object.keys(value).length
  );
}

function normalizeInventory(
  product,
  payload
) {
  if (
    ![
      "stock",
      "variants",
      "sizes",
      "colors",
    ].some((key) =>
      own(payload, key)
    )
  ) {
    return;
  }

  const sizes = own(
    payload,
    "sizes"
  )
    ? payload.sizes
    : product.sizes || [];

  const colors = own(
    payload,
    "colors"
  )
    ? payload.colors
    : product.colors || [];

  for (const name of [
    ...sizes,
    ...colors,
  ]) {
    safeKey(name, 80);

    if (name === "default") {
      throw httpError(
        400,
        "The option name default is reserved."
      );
    }
  }

  if (
    !sizes.length &&
    !colors.length
  ) {
    if (
      own(payload, "variants") &&
      hasVariants(payload.variants)
    ) {
      throw httpError(
        400,
        "List sizes or colours before providing variant quantities."
      );
    }

    if (
      hasVariants(product.variants) &&
      !own(payload, "variants")
    ) {
      throw httpError(
        400,
        "Clear the old variants and provide the new total stock together."
      );
    }

    if (
      hasVariants(product.variants) &&
      !own(payload, "stock")
    ) {
      throw httpError(
        400,
        "Provide total stock when removing all product options."
      );
    }

    return;
  }

  if (own(payload, "stock")) {
    throw httpError(
      400,
      "Update individual variant quantities instead of total stock."
    );
  }

  if (!own(payload, "variants")) {
    throw httpError(
      400,
      "Provide a complete stock matrix for these sizes and colours."
    );
  }

  const source = payload.variants;
  const result = {};

  let total = 0;

  function add(quantity) {
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 0
    ) {
      throw httpError(
        400,
        "Enter whole variant stock quantities."
      );
    }

    total += quantity;

    if (total > 1000000) {
      throw httpError(
        400,
        "Combined product stock cannot exceed 1,000,000."
      );
    }

    return quantity;
  }

  function exactKeys(
    value,
    expected,
    label
  ) {
    object(value, label);

    const keys = Object.keys(value);

    if (
      keys.length !== expected.length ||
      keys.some(
        (key) => !expected.includes(key)
      )
    ) {
      throw httpError(
        400,
        `Provide stock for every listed ${label}, with no unlisted options.`
      );
    }
  }

  if (colors.length) {
    exactKeys(
      source,
      colors,
      "colour"
    );

    for (const color of colors) {
      const group = source[color];

      if (sizes.length) {
        exactKeys(
          group,
          sizes,
          `size in ${color}`
        );

        result[color] = {};

        for (const size of sizes) {
          result[color][size] = add(
            group[size]
          );
        }
      } else if (
        typeof group === "number"
      ) {
        result[color] = {
          default: add(group),
        };
      } else {
        exactKeys(
          group,
          ["default"],
          `stock entry in ${color}`
        );

        result[color] = {
          default: add(
            group.default
          ),
        };
      }
    }
  } else {
    exactKeys(
      source,
      sizes,
      "size"
    );

    for (const size of sizes) {
      if (
        typeof source[size] !== "number"
      ) {
        throw httpError(
          400,
          "Size-only products need a numeric quantity for each size."
        );
      }

      result[size] = add(
        source[size]
      );
    }
  }

  payload.variants = result;
  payload.stock = total;
}

function protectSave(product) {
  const snapshot = product.toObject({
    transform: false,
    depopulate: true,
  });

  const conditions = {
    ...(product.$where || {}),
  };

  for (const key of [
    "stock",
    "variants",
    "sizes",
    "colors",
    "isActive",
    "price",
    "discount",
    "updatedAt",
    "__v",
  ]) {
    conditions[key] =
      product.$isDefault?.(key) ||
      snapshot[key] === undefined
        ? { $exists: false }
        : snapshot[key];
  }

  product.$where = conditions;
}

function applyPatch(
  product,
  payload
) {
  const patch = {
    ...payload,
  };

  const oldSupplier = String(
    product.supplier || ""
  );

  const oldSource =
    product.fulfillment?.stockSource;

  for (const key of [
    "delivery",
    "fulfillment",
    "kitSettings",
    "optionLabels",
  ]) {
    if (!own(patch, key)) {
      continue;
    }

    const current =
      product[key]?.toObject?.({
        transform: false,
      }) ||
      product[key] ||
      {};

    product.set(key, {
      ...current,
      ...patch[key],
    });

    delete patch[key];
  }

  product.set(patch);

  if (
    product.fulfillment &&
    (
      oldSupplier !==
        String(
          product.supplier || ""
        ) ||
      oldSource !==
        product.fulfillment.stockSource
    )
  ) {
    product.fulfillment
      .supplierStockConfirmedAt = null;
  }

  for (const key of [
    "variants",
    "specifications",
  ]) {
    if (own(payload, key)) {
      product.markModified(key);
    }
  }
}

function supplierProblem(supplier) {
  if (!supplier) {
    return (
      "The selected supplier no longer exists."
    );
  }

  if (supplier.status !== "active") {
    return (
      "The selected supplier is not active."
    );
  }

  const verified =
    supplier.verification;

  if (
    verified?.status !== "verified" ||
    !verified.verifiedBy ||
    !verified.verifiedAt
  ) {
    return (
      "The selected supplier needs recorded verification before publishing."
    );
  }

  const contact = supplier.contact;

  if (
    !contact ||
    !(
      contact.phone ||
      contact.whatsapp ||
      contact.email
    )
  ) {
    return (
      "The selected supplier needs a contact method."
    );
  }

  const setup =
    supplier.fulfillment;

  if (
    !setup ||
    !(
      setup.dispatchToCustomer ||
      setup.sendToPackingLocation
    )
  ) {
    return (
      "The selected supplier needs a real fulfillment arrangement."
    );
  }

  if (
    !Number.isSafeInteger(
      setup.preparationDaysMin
    ) ||
    !Number.isSafeInteger(
      setup.preparationDaysMax
    ) ||
    setup.preparationDaysMin < 0 ||
    setup.preparationDaysMax <
      setup.preparationDaysMin ||
    setup.preparationDaysMax > 365
  ) {
    return (
      "The selected supplier needs valid preparation times."
    );
  }

  return "";
}

async function validateSupply(
  product,
  confirmStock = false
) {
  const setup =
    product.fulfillment || {};

  const needsSupplier =
    setup.stockSource === "supplier" ||
    setup.dispatchBy === "supplier" ||
    setup.canSendToPackingLocation;

  if (!product.supplier) {
    if (
      confirmStock ||
      (
        product.isActive &&
        needsSupplier
      )
    ) {
      throw httpError(
        400,
        "Choose a supplier for these fulfillment settings, or save " +
          "the product as archived while setting it up.",
        "SUPPLIER_REQUIRED"
      );
    }

    return;
  }

  const supplier =
    await Supplier.findById(
      product.supplier
    ).select(SUPPLIER_FIELDS);

  if (!supplier) {
    throw httpError(
      400,
      "The selected supplier no longer exists.",
      "SUPPLIER_NOT_FOUND"
    );
  }

  if (
    product.isActive ||
    confirmStock
  ) {
    const problem =
      supplierProblem(supplier);

    if (problem) {
      throw httpError(
        400,
        `${problem} Save the product as archived while completing setup.`,
        "SUPPLIER_UNAVAILABLE"
      );
    }

    if (
      setup.dispatchBy === "supplier" &&
      !supplier.fulfillment
        .dispatchToCustomer
    ) {
      throw httpError(
        400,
        "This supplier is not configured to dispatch directly to customers.",
        "FULFILLMENT_NOT_CONFIGURED"
      );
    }

    if (
      setup.canSendToPackingLocation &&
      !supplier.fulfillment
        .sendToPackingLocation
    ) {
      throw httpError(
        400,
        "This supplier is not configured to send products to a packing location.",
        "FULFILLMENT_NOT_CONFIGURED"
      );
    }
  }

  if (product.isActive) {
    if (
      setup.stockSource ===
        "unconfirmed" ||
      !setup.stockSource ||
      setup.dispatchBy ===
        "unconfirmed" ||
      !setup.dispatchBy
    ) {
      throw httpError(
        400,
        "Record where this product's stock is held and who " +
          "dispatches it before publishing.",
        "FULFILLMENT_NOT_CONFIGURED"
      );
    }

    if (
      !Number.isSafeInteger(
        setup.preparationDaysMin
      ) ||
      !Number.isSafeInteger(
        setup.preparationDaysMax
      ) ||
      setup.preparationDaysMin < 0 ||
      setup.preparationDaysMax <
        setup.preparationDaysMin ||
      setup.preparationDaysMax > 365
    ) {
      throw httpError(
        400,
        "Record valid product preparation times before publishing.",
        "FULFILLMENT_NOT_CONFIGURED"
      );
    }

    if (
      setup.stockSource === "supplier" &&
      setup.dispatchBy !== "supplier" &&
      !setup.canSendToPackingLocation
    ) {
      throw httpError(
        400,
        "Confirm the supplier-to-packing arrangement for this dispatch method.",
        "FULFILLMENT_NOT_CONFIGURED"
      );
    }
  }

  if (confirmStock) {
    if (
      setup.stockSource !== "supplier"
    ) {
      throw httpError(
        400,
        "Supplier stock confirmation applies only to stock held by a supplier."
      );
    }

    product.fulfillment
      .supplierStockConfirmedAt =
        new Date();
  }

  if (
    product.isActive &&
    setup.stockSource === "supplier" &&
    !product.fulfillment
      .supplierStockConfirmedAt
  ) {
    throw httpError(
      400,
      "Check the supplier's actual variant quantities, then " +
        "confirm supplier stock before publishing.",
      "SUPPLIER_STOCK_UNCONFIRMED"
    );
  }
}

async function getProducts(req, res) {
  res.set(
    "Cache-Control",
    "no-store"
  );

  try {
    const products =
      await Product.find({
        isActive: true,
      });

    const reviewed =
      await attachReviews(products);

    return res.json({
      success: true,
      count: reviewed.length,

      products: reviewed.map(
        (product) =>
          serializeProduct(product)
      ),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load products."
    );
  }
}

async function getProductById(
  req,
  res
) {
  res.set(
    "Cache-Control",
    "no-store"
  );

  try {
    const product =
      await findProduct(
        req.params.id,
        true
      );

    if (!product) {
      throw httpError(
        404,
        "Product not found."
      );
    }

    const [reviewed] =
      await attachReviews([
        product,
      ]);

    return res.json({
      success: true,

      product:
        serializeProduct(reviewed),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load this product."
    );
  }
}

async function getAdminProductOptions(
  req,
  res
) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const [
      categories,
      brands,
      pairs,
      suppliers,
    ] = await Promise.all([
      Product.distinct("category"),
      Product.distinct("brand"),

      Product.aggregate([
        {
          $match: {
            category: {
              $type: "string",
            },

            subcategory: {
              $type: "string",
              $ne: "",
            },
          },
        },

        {
          $group: {
            _id: {
              category: "$category",
              subcategory:
                "$subcategory",
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

      Supplier.find({
        status: {
          $ne: "archived",
        },
      })
        .select(SUPPLIER_FIELDS)
        .sort({
          name: 1,
          _id: 1,
        }),
    ]);

    const subcategories =
      Object.create(null);

    for (const { _id } of pairs) {
      if (
        !own(
          subcategories,
          _id.category
        )
      ) {
        subcategories[
          _id.category
        ] = [];
      }

      subcategories[
        _id.category
      ].push(
        _id.subcategory
      );
    }

    return res.json({
      success: true,

      categories: categories
        .filter(
          (value) =>
            typeof value === "string" &&
            value.trim()
        )
        .sort(),

      brands: brands
        .filter(
          (value) =>
            typeof value === "string" &&
            value.trim()
        )
        .sort(),

      subcategories,

      suppliers: suppliers.map(
        (supplier) => ({
          id: String(
            supplier._id
          ),

          name: supplier.name,

          supplierCode:
            supplier.supplierCode,

          status: supplier.status,

          available:
            !supplierProblem(supplier),

          unavailableReason:
            supplierProblem(supplier),

          dispatchToCustomer:
            supplier.fulfillment
              ?.dispatchToCustomer ===
            true,

          sendToPackingLocation:
            supplier.fulfillment
              ?.sendToPackingLocation ===
            true,
        })
      ),

      kitRoles: KIT_ROLES,

      sizeOptionLabels:
        SIZE_LABELS,

      colorOptionLabels:
        COLOR_LABELS,

      stockSources:
        STOCK_SOURCES,

      dispatchMethods:
        DISPATCH_METHODS,

      returnEligibility: [
        "unconfirmed",
        "yes",
        "no",
      ],

      returnWindow: {
        minimumDays: 1,
        maximumDays: 7,
      },
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load product options."
    );
  }
}

async function getAdminProducts(
  req,
  res
) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const search = text(
      req.query.search,
      150
    );

    const category = text(
      req.query.category,
      100
    );

    const active = text(
      req.query.active,
      20
    );

    const page = Math.min(
      1000000,
      Math.max(
        1,
        parseInt(
          req.query.page,
          10
        ) || 1
      )
    );

    const limit = Math.min(
      100,
      Math.max(
        1,
        parseInt(
          req.query.limit,
          10
        ) || 25
      )
    );

    const filter = {};

    if (search) {
      const regex = new RegExp(
        escapeRegex(search),
        "i"
      );

      filter.$or = [
        "name",
        "slug",
        "sku",
        "productCode",
        "variantSkus.sku",
        "brand",
        "category",
        "subcategory",
      ].map((field) => ({
        [field]: regex,
      }));
    }

    if (category) {
      filter.category =
        new RegExp(
          `^${escapeRegex(category)}$`,
          "i"
        );
    }

    if (
      [
        "in-stock",
        "low-stock",
        "out-of-stock",
      ].includes(
        req.query.stockStatus
      )
    ) {
      filter.stockStatus =
        req.query.stockStatus;
    }

    if (
      ["true", "false"].includes(
        active
      )
    ) {
      filter.isActive =
        active === "true";
    }

    if (req.query.supplier) {
      filter.supplier = reference(
        req.query.supplier,
        "supplier"
      );
    }

    if (req.query.kitRole) {
      filter[
        "kitSettings.roles"
      ] = choice(
        req.query.kitRole,
        KIT_ROLES,
        "kit category"
      );
    }

    if (
      req.query.kitEligible != null &&
      req.query.kitEligible !== ""
    ) {
      filter[
        "kitSettings.eligible"
      ] = boolean(
        req.query.kitEligible
      );
    }

    const [products, total] =
      await Promise.all([
        Product.find(filter)
          .select(ADMIN_FIELDS)
          .sort({
            updatedAt: -1,
            _id: -1,
          })
          .skip(
            (page - 1) * limit
          )
          .limit(limit),

        Product.countDocuments(
          filter
        ),
      ]);

    return res.json({
      success: true,

      count: products.length,

      total,

      page,

      pages: Math.max(
        1,
        Math.ceil(
          total / limit
        )
      ),

      limit,

      products: products.map(
        (product) =>
          serializeProduct(
            product,
            true
          )
      ),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load admin products."
    );
  }
}

async function getAdminProductById(
  req,
  res
) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const product =
      await findProduct(
        req.params.id,
        false,
        true
      );

    if (!product) {
      throw httpError(
        404,
        "Product not found."
      );
    }

    return res.json({
      success: true,

      product:
        serializeProduct(
          product,
          true
        ),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load this product."
    );
  }
}

async function createProduct(
  req,
  res
) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const payload =
      normalizePayload(req.body);

    const confirmStock =
      confirmation(req.body);

    if (
      !payload.name ||
      payload.name.length < 2
    ) {
      throw httpError(
        400,
        "Enter a product name."
      );
    }

    if (!payload.category) {
      throw httpError(
        400,
        "Choose a product category."
      );
    }

    if (!payload.brand) {
      throw httpError(
        400,
        "Choose the actual product brand."
      );
    }

    if (
      !Number.isFinite(
        payload.price
      )
    ) {
      throw httpError(
        400,
        "Enter a valid product price."
      );
    }

    normalizeInventory(
      {
        sizes: [],
        colors: [],
        variants: {},
      },
      payload
    );

    const id =
      new mongoose.Types.ObjectId();

    if (!payload.slug) {
      payload.slug =
        `${(
          slugify(payload.name) ||
          "product"
        ).slice(0, 150)}-${String(id)}`;
    }

    const product =
      new Product({
        ...payload,

        _id: id,

        isActive:
          payload.isActive ?? true,
      });

    await validateSupply(
      product,
      confirmStock
    );

    await product.save();

    return res.status(201).json({
      success: true,

      message:
        "Product and stock saved successfully.",

      product:
        serializeProduct(
          product,
          true
        ),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to create this product."
    );
  }
}

async function updateProduct(
  req,
  res
) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const product =
      await findProduct(
        req.params.id,
        false,
        true
      );

    if (!product) {
      throw httpError(
        404,
        "Product not found."
      );
    }

    const payload =
      normalizePayload(req.body);

    const confirmStock =
      confirmation(req.body);

    if (
      !Object.keys(payload).length &&
      !confirmStock
    ) {
      throw httpError(
        400,
        "No product changes were provided."
      );
    }

    normalizeInventory(
      product,
      payload
    );

    protectSave(product);

    applyPatch(
      product,
      payload
    );

    // Video and private bookmark changes do not republish
    // the product or change inventory.
    // Other edits retain supplier and fulfillment checks.
    const linksOnly =
      !confirmStock &&
      Object.keys(payload).every(
        (key) =>
          [
            "meeshoProductLink",
            "videoUrl",
          ].includes(key)
      );

    if (!linksOnly) {
      await validateSupply(
        product,
        confirmStock
      );
    }

    await product.save();

    return res.json({
      success: true,

      message: linksOnly
        ? "Product links saved."
        : "Product and stock updated successfully.",

      product:
        serializeProduct(
          product,
          true
        ),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to update this product."
    );
  }
}

async function updateProductInventory(
  req,
  res
) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const product =
      await findProduct(
        req.params.id,
        false,
        true
      );

    if (!product) {
      throw httpError(
        404,
        "Product not found."
      );
    }

    object(
      req.body,
      "Inventory"
    );

    const payload = {};

    const confirmStock =
      confirmation(req.body);

    if (
      own(
        req.body,
        "variants"
      )
    ) {
      payload.variants =
        normalizeVariants(
          req.body.variants
        );
    }

    if (
      own(
        req.body,
        "stock"
      )
    ) {
      payload.stock = number(
        req.body.stock,
        "stock",
        1000000,
        true
      );
    }

    if (
      !Object.keys(payload).length &&
      !confirmStock
    ) {
      throw httpError(
        400,
        "Provide stock quantities."
      );
    }

    normalizeInventory(
      product,
      payload
    );

    protectSave(product);

    applyPatch(
      product,
      payload
    );

    if (confirmStock) {
      await validateSupply(
        product,
        true
      );
    }

    await product.save();

    return res.json({
      success: true,

      message:
        "Inventory updated successfully.",

      product:
        serializeProduct(
          product,
          true
        ),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to update inventory."
    );
  }
}

async function setVisibility(
  req,
  res,
  isActive
) {
  if (!ensureAdmin(req, res)) {
    return;
  }

  try {
    const product =
      await findProduct(
        req.params.id,
        false,
        true
      );

    if (!product) {
      throw httpError(
        404,
        "Product not found."
      );
    }

    protectSave(product);

    product.isActive = isActive;

    if (isActive) {
      await validateSupply(product);
    }

    await product.save();

    return res.json({
      success: true,

      message: isActive
        ? "Product restored."
        : "Product archived.",

      product:
        serializeProduct(
          product,
          true
        ),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to change product visibility."
    );
  }
}

const deleteProduct = (req, res) =>
  setVisibility(
    req,
    res,
    false
  );

const restoreProduct = (req, res) =>
  setVisibility(
    req,
    res,
    true
  );

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