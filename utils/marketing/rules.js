"use strict";

const crypto = require("node:crypto");

const {
  getDiscountedPrice,
} = require("../orderPricing");

const {
  getTotalStock,
  getVariantStock,
} = require("../orderInventory");

const {
  productImageSources,
} = require("../productImages");

const FAMILIES = Object.freeze([
  "apparel",
  "accessories",
  "equipment",
]);

const CONDITIONS = Object.freeze([
  "new",
  "refurbished",
  "used",
]);

const MAX_VARIANTS = 250;

// Conservative exclusions for this integration.
// This is not a complete Meta policy checker.
// Every advertised product still requires an admin review.
const RESTRICTED =
  /\b(?:supplements?|nutrition|whey|creatine|ingestible|medicines?|medical|steroids?|testosterone|diabetes|pregnancy|fertility)\b|\b(?:mass[\s-]*gainer|protein[\s-]*(?:powder|bars?|shakes?)|pre[\s-]*workout|fat[\s-]*(?:burner|loss)|weight[\s-]*loss|pain[\s-]*relief)\b/i;

function text(value, maximum = 5000) {
  return typeof value === "string"
    ? value
        .replace(/<[^>]*>/g, " ")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maximum)
    : "";
}

function objectId(value) {
  const raw =
    value && typeof value === "object"
      ? value._id ?? value.id ?? value
      : value;

  const id =
    typeof raw === "string"
      ? raw
      : typeof raw?.toHexString === "function"
        ? raw.toHexString()
        : "";

  return /^[a-f0-9]{24}$/i.test(id)
    ? id.toLowerCase()
    : "";
}

function toPaise(value) {
  if (
    !["number", "string"].includes(typeof value) ||
    !String(value).trim()
  ) {
    return null;
  }

  const amount = Number(value);
  const paise = Math.round(amount * 100);

  return Number.isFinite(amount) &&
    amount >= 0 &&
    Number.isSafeInteger(paise) &&
    Math.abs(amount * 100 - paise) < 0.00001
    ? paise
    : null;
}

function fromPaise(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(
      "Expected a non-negative integer amount in paise.",
    );
  }

  return value / 100;
}

function sellingPricePaise(product) {
  const price = toPaise(product?.price);
  const discount = product?.discount ?? 0;

  if (
    price == null ||
    !["number", "string"].includes(typeof discount) ||
    !String(discount).trim() ||
    !Number.isFinite(Number(discount)) ||
    Number(discount) < 0 ||
    Number(discount) > 100
  ) {
    return null;
  }

  const result = toPaise(
    getDiscountedPrice(product),
  );

  return result != null && result > 0
    ? result
    : null;
}

function groupId(product) {
  const id = objectId(product);

  if (!id) {
    throw new Error(
      "A database product ID is required.",
    );
  }

  return `gd_${id}`;
}

function option(value, maximum) {
  if (value == null || value === "") {
    return null;
  }

  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      "Invalid catalogue option.",
    );
  }

  return value.normalize("NFC");
}

function variantId(
  product,
  size = null,
  color = null,
) {
  const base = groupId(product);

  const selection = [
    option(size, 50),
    option(color, 80),
  ];

  if (
    selection.every(
      (value) => value === null,
    )
  ) {
    return base;
  }

  const suffix = crypto
    .createHash("sha256")
    .update(JSON.stringify(selection))
    .digest("hex")
    .slice(0, 16);

  return `${base}_${suffix}`;
}

function publicHttpsUrl(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2000 ||
    /[\u0000-\u0020\u007f<>\\]/.test(value)
  ) {
    return "";
  }

  try {
    const url = new URL(value);

    const publicHost =
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

    const reservedHost =
      /\.(?:localhost|local|internal|lan|test|invalid|example|onion)$/i;

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !publicHost.test(url.hostname) ||
      reservedHost.test(url.hostname)
    ) {
      return "";
    }

    url.hash = "";

    return url.href;
  } catch {
    return "";
  }
}

function siteOrigin() {
  const input = String(
    process.env.SITE_URL ||
      "https://www.gymdrobe.com",
  ).trim();

  const safe = publicHttpsUrl(input);

  if (!safe) {
    throw new Error(
      "Set SITE_URL to your public HTTPS storefront origin.",
    );
  }

  const url = new URL(safe);

  if (
    url.pathname !== "/" ||
    url.search
  ) {
    throw new Error(
      "SITE_URL must contain an origin without a path or query.",
    );
  }

  return url.origin;
}

function productLink(
  product,
  size = null,
  color = null,
) {
  const id = objectId(product);

  if (!id) {
    throw new Error(
      "A database product ID is required.",
    );
  }

  const url = new URL(
    `/product/${id}`,
    siteOrigin(),
  );

  if (size != null) {
    url.searchParams.set(
      "size",
      option(size, 50) || "",
    );
  }

  if (color != null) {
    url.searchParams.set(
      "color",
      option(color, 80) || "",
    );
  }

  return url.href;
}

function imageUrl(
  product,
  color = null,
) {
  const sources = productImageSources(
    product,
    color,
  );

  for (const source of sources) {
    try {
      const safe = publicHttpsUrl(
        new URL(
          source,
          siteOrigin(),
        ).href,
      );

      if (safe) {
        return safe;
      }
    } catch {
      // Try another product photo.
      // Never use a sourcing link as an image.
    }
  }

  return "";
}

function options(value, maximum) {
  if (value == null) {
    return [];
  }

  if (
    !Array.isArray(value) ||
    value.length > 50
  ) {
    throw new Error(
      "Correct the product's available options.",
    );
  }

  const seen = new Set();

  return value.map((raw) => {
    const normalized = option(
      raw,
      maximum,
    );

    const key =
      normalized?.toLowerCase();

    if (
      !normalized ||
      seen.has(key) ||
      [
        "default",
        "__proto__",
        "prototype",
        "constructor",
      ].includes(raw) ||
      raw.startsWith("$") ||
      raw.includes(".")
    ) {
      throw new Error(
        "Correct duplicate or invalid product options.",
      );
    }

    seen.add(key);

    return raw;
  });
}

function catalogVariants(product) {
  const base = groupId(product);

  const sizes = options(
    product.sizes,
    50,
  );

  const colors = options(
    product.colors,
    80,
  );

  const sizeChoices = sizes.length
    ? sizes
    : [null];

  const colorChoices = colors.length
    ? colors
    : [null];

  if (
    sizeChoices.length *
      colorChoices.length >
    MAX_VARIANTS
  ) {
    throw new Error(
      `Use at most ${MAX_VARIANTS} advertising variants per product.`,
    );
  }

  const pricePaise =
    sellingPricePaise(product);

  return colorChoices.flatMap(
    (color) =>
      sizeChoices.map((size) => {
        const quantity =
          getVariantStock(
            product,
            size,
            color,
          );

        return {
          id: variantId(
            product,
            size,
            color,
          ),

          item_group_id: base,
          size,
          color,
          quantity,

          availability:
            quantity > 0
              ? "in stock"
              : "out of stock",

          pricePaise,

          image_link: imageUrl(
            product,
            color,
          ),

          link: productLink(
            product,
            size,
            color,
          ),
        };
      }),
  );
}

function productAdvertisingIssues(
  product,
  { requireStock = false } = {},
) {
  if (
    !product ||
    !objectId(product)
  ) {
    return [
      "Product record is unavailable.",
    ];
  }

  const issues = [];
  const policy =
    product.metaMarketing || {};

  if (product.isActive !== true) {
    issues.push(
      "Product is not published.",
    );
  }

  if (policy.status !== "approved") {
    issues.push(
      "Admin advertising review is required.",
    );
  }

  if (
    !FAMILIES.includes(policy.family)
  ) {
    issues.push(
      "Product is outside the enabled advertising families.",
    );
  }

  if (
    !CONDITIONS.includes(
      policy.condition,
    )
  ) {
    issues.push(
      "Confirm the product's actual condition.",
    );
  }

  if (
    !objectId(policy.reviewedBy) ||
    !policy.reviewedAt ||
    !Number.isFinite(
      new Date(
        policy.reviewedAt,
      ).getTime(),
    )
  ) {
    issues.push(
      "Record the admin and time of the advertising review.",
    );
  }

  if (!text(product.name)) {
    issues.push(
      "Add a product name.",
    );
  }

  if (!text(product.brand)) {
    issues.push(
      "Add the actual product brand.",
    );
  }

  if (!text(product.description)) {
    issues.push(
      "Add an accurate product description.",
    );
  }

  if (
    sellingPricePaise(product) == null
  ) {
    issues.push(
      "Correct the current selling price.",
    );
  }

  const copy = [
    product.name,
    product.category,
    product.subcategory,
    product.description,
    product.whatsIncluded,

    ...(Array.isArray(product.tags)
      ? product.tags
      : []),

    ...(Array.isArray(
      product.highlights,
    )
      ? product.highlights
      : []),
  ]
    .map((value) => text(value))
    .join(" ");

  if (RESTRICTED.test(copy)) {
    issues.push(
      "Excluded from this integration's advertising scope.",
    );
  }

  if (
    requireStock &&
    getTotalStock(product) < 1
  ) {
    issues.push(
      "No purchasable stock is available.",
    );
  }

  try {
    if (
      catalogVariants(product).some(
        (row) => !row.image_link,
      )
    ) {
      issues.push(
        "Add a public HTTPS product photo for every colour.",
      );
    }
  } catch {
    issues.push(
      "Correct product options, variant count or storefront URL configuration.",
    );
  }

  return issues;
}

function productEligible(
  product,
  settings,
) {
  return (
    productAdvertisingIssues(
      product,
      settings,
    ).length === 0
  );
}

function publicAdvertising(product) {
  if (!productEligible(product)) {
    return {
      eligible: false,
    };
  }

  return {
    eligible: true,

    groupId: groupId(product),

    variants: catalogVariants(
      product,
    ).map((row) => ({
      id: row.id,
      size: row.size,
      color: row.color,
      inStock: row.quantity > 0,
    })),
  };
}

module.exports = {
  FAMILIES,
  CONDITIONS,
  MAX_VARIANTS,
  text,
  objectId,
  toPaise,
  fromPaise,
  sellingPricePaise,
  groupId,
  variantId,
  publicHttpsUrl,
  siteOrigin,
  productLink,
  imageUrl,
  catalogVariants,
  productAdvertisingIssues,
  productEligible,
  publicAdvertising,
};