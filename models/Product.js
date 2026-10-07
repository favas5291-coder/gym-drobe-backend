const mongoose = require("mongoose");
const crypto = require("node:crypto");

const forbiddenKeys = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function clean(value, maximum = 500) {
  return String(value ?? "").trim().slice(0, maximum);
}

function cleanArray(value, maximum = 100, length = 200) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();

  return value
    .map((item) => clean(item, length))
    .filter((item) => {
      const key = item.toLowerCase();

      if (!item || seen.has(key)) return false;

      seen.add(key);
      return true;
    })
    .slice(0, maximum);
}

function validKey(value) {
  return (
    value &&
    !forbiddenKeys.has(value) &&
    !value.startsWith("$") &&
    !value.includes(".")
  );
}

function stockRows(variants) {
  if (
    !variants ||
    typeof variants !== "object" ||
    Array.isArray(variants)
  ) {
    throw new Error("Variant stock must be an object.");
  }

  const rows = [];

  for (const [first, group] of Object.entries(variants)) {
    if (!validKey(first)) {
      throw new Error("Choose a valid size or colour name.");
    }

    // Size-only products: { M: 5, L: 10 }
    if (typeof group !== "object" || group === null) {
      rows.push({
        color: "",
        size: first,
        quantity: group,
      });

      continue;
    }

    if (Array.isArray(group)) {
      throw new Error("Variant stock cannot be an array.");
    }

    // Colour/size products: { Black: { M: 5 } }
    // Colour-only products: { Black: { default: 5 } }
    for (const [second, quantity] of Object.entries(group)) {
      if (!validKey(second)) {
        throw new Error("Choose a valid variant option name.");
      }

      rows.push({
        color: first,
        size: second === "default" ? "" : second,
        quantity,
      });
    }
  }

  if (rows.length > 2500) {
    throw new Error("A product cannot exceed 2,500 variants.");
  }

  for (const row of rows) {
    const quantity = Number(row.quantity);

    if (
      row.quantity === "" ||
      row.quantity == null ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0 ||
      quantity > 1000000
    ) {
      throw new Error(
        `Enter a whole stock quantity for ${
          [row.color, row.size].filter(Boolean).join(" / ") ||
          "the product"
        }.`
      );
    }

    row.quantity = quantity;
  }

  return rows;
}

function variantSku(productCode, color, size) {
  const label = [color, size]
    .filter(Boolean)
    .join("-")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

  const signature = crypto
    .createHash("sha256")
    .update(JSON.stringify([color, size]))
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();

  return `${productCode}-${label || "OPTION"}-${signature}`;
}

const reviewSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
  },
  { timestamps: true }
);

const deliverySchema = new mongoose.Schema(
  {
    available: { type: Boolean, default: true },
    estimatedDays: {
      type: String,
      default: null,
      trim: true,
      maxlength: 100,
    },
    freeDeliveryAbove: {
      type: Number,
      default: 500,
      min: 0,
    },
  },
  { _id: false }
);

const variantSkuSchema = new mongoose.Schema(
  {
    color: { type: String, default: "" },
    size: { type: String, default: "" },
    sku: { type: String, required: true, maxlength: 100 },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    legacyId: {
      type: Number,
      default: null,
      index: true,
    },

    productCode: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 100,
      immutable: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 180,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 200,
    },

    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true,
    },

    subcategory: {
      type: String,
      default: "",
      trim: true,
      maxlength: 100,
    },

    brand: {
      type: String,
      default: "GymDrobe",
      trim: true,
      maxlength: 100,
    },

    gender: {
      type: String,
      default: "Unisex",
      trim: true,
      maxlength: 50,
    },

    price: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0, max: 100 },

    rating: { type: Number, default: 0, min: 0, max: 5 },
    reviewCount: { type: Number, default: 0, min: 0 },
    reviews: { type: [reviewSchema], default: [] },

    badge: {
      type: String,
      default: "",
      trim: true,
      maxlength: 80,
    },

    tags: { type: [String], default: [] },

    isFeatured: {
      type: Boolean,
      default: false,
      index: true,
    },

    isBestSeller: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Do not use "isNew" as a schema field:
    // Mongoose uses it internally.
    isNewArrival: {
      type: Boolean,
      default: false,
      index: true,
    },

    material: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    highlights: { type: [String], default: [] },

    specifications: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    careInstructions: { type: [String], default: [] },

    whatsIncluded: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },

    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 5000,
    },

    sizes: { type: [String], default: [] },
    colors: { type: [String], default: [] },

    // Existing numeric stock structure remains unchanged.
    variants: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    // SKU information is separate from stock quantities.
    variantSkus: {
      type: [variantSkuSchema],
      default: [],
    },

    stock: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },

    stockStatus: {
      type: String,
      enum: ["in-stock", "low-stock", "out-of-stock"],
      default: "out-of-stock",
      index: true,
    },

    image: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },

    images: { type: [String], default: [] },

    delivery: {
      type: deliverySchema,
      default: () => ({}),
    },

    returnPolicy: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },

    // Preserve the existing parent SKU field.
    // New products automatically receive their product code here.
    sku: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 100,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

productSchema.pre("validate", function () {
  this.name = clean(this.name, 200);
  this.slug = clean(this.slug, 180).toLowerCase();
  this.category = clean(this.category, 100);
  this.subcategory = clean(this.subcategory, 100);
  this.brand = clean(this.brand || "GymDrobe", 100);
  this.gender = clean(this.gender || "Unisex", 50);

  if (!this.productCode) {
    this.productCode = `GD-${String(this._id).toUpperCase()}`;
  }

  this.sku = clean(this.sku || this.productCode, 100).toUpperCase();

  this.tags = cleanArray(this.tags, 50, 100);
  this.highlights = cleanArray(this.highlights, 30, 500);
  this.careInstructions = cleanArray(this.careInstructions, 30, 500);
  this.sizes = cleanArray(this.sizes, 50, 50);
  this.colors = cleanArray(this.colors, 50, 80);
  this.images = cleanArray(this.images, 20, 2000);
  this.image = clean(this.image, 2000);

  if (!this.image && this.images.length) {
    this.image = this.images[0];
  }

  if (this.image && !this.images.includes(this.image)) {
    this.images = [this.image, ...this.images].slice(0, 20);
  }

  try {
    const rows = stockRows(this.variants || {});

    if (Object.keys(this.variants || {}).length) {
      this.stock = rows.reduce(
        (total, row) => total + row.quantity,
        0
      );
    } else {
      const quantity = Number(this.stock);

      if (
        !Number.isSafeInteger(quantity) ||
        quantity < 0 ||
        quantity > 1000000
      ) {
        this.invalidate(
          "stock",
          "Stock must be a whole number from 0 to 1,000,000."
        );
      }
    }

    const previous = new Map(
      (this.variantSkus || []).map((row) => [
        JSON.stringify([row.color || "", row.size || ""]),
        row.sku,
      ])
    );

    this.variantSkus = rows.map((row) => {
      const key = JSON.stringify([row.color, row.size]);

      return {
        color: row.color,
        size: row.size,
        sku:
          previous.get(key) ||
          variantSku(this.productCode, row.color, row.size),
      };
    });

    const skuValues = this.variantSkus.map((row) => row.sku);

    if (new Set(skuValues).size !== skuValues.length) {
      this.invalidate("variantSkus", "Variant SKUs must be unique.");
    }
  } catch (error) {
    this.invalidate("variants", error.message);
  }

  this.stockStatus =
    this.stock <= 0
      ? "out-of-stock"
      : this.stock <= 10
        ? "low-stock"
        : "in-stock";

  // Keep existing embedded-review calculations.
  const validReviews = (this.reviews || []).filter(
    (review) => review.rating >= 1 && review.rating <= 5
  );

  this.reviewCount = validReviews.length;
  this.rating = validReviews.length
    ? Math.round(
        (validReviews.reduce(
          (total, review) => total + review.rating,
          0
        ) /
          validReviews.length) *
          10
      ) / 10
    : 0;

  if (!this.delivery) this.delivery = {};
});

function transformProduct(doc, result) {
  result.isNew = Boolean(result.isNewArrival);

  // Old products can display their deterministic code
  // before their next save persists it.
  result.productCode =
    result.productCode ||
    `GD-${String(result._id).toUpperCase()}`;

  delete result.isNewArrival;
  delete result.__v;

  return result;
}

productSchema.set("toJSON", { transform: transformProduct });
productSchema.set("toObject", { transform: transformProduct });

productSchema.index(
  { productCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      productCode: { $type: "string" },
    },
  }
);

productSchema.index(
  { "variantSkus.sku": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "variantSkus.sku": { $type: "string" },
    },
  }
);

productSchema.index({
  isActive: 1,
  category: 1,
  createdAt: -1,
});

productSchema.index({
  isActive: 1,
  stockStatus: 1,
});

productSchema.index({
  name: "text",
  category: "text",
  subcategory: "text",
  brand: "text",
  tags: "text",
});

module.exports =
  mongoose.models.Product ||
  mongoose.model("Product", productSchema);