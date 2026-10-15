const {
  normalizeColorImages,
} = require("../utils/productImages");

const {
  normalizeMeeshoLink,
} = require("../utils/meeshoUrl");

const mongoose = require("mongoose");
const crypto = require("node:crypto");

const forbiddenKeys = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function cleanArray(
  value,
  maximum = 100,
  length = 200,
  caseSensitive = false
) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();

  return value
    .map((item) => clean(item))
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

function validKey(value) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !forbiddenKeys.has(value) &&
    !value.startsWith("$") &&
    !value.includes(".")
  );
}

function record(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) ===
      "[object Object]"
  );
}

function optionalDays() {
  return {
    type: Number,
    default: null,
    min: 0,
    max: 365,
    validate: {
      validator: (value) =>
        value == null ||
        Number.isSafeInteger(value),
      message:
        "Days must be a whole number from 0 to 365.",
    },
  };
}

function validateRange(document, minimum, maximum) {
  const low = document[minimum];
  const high = document[maximum];

  if (
    (low == null) !== (high == null) ||
    (low != null && high < low)
  ) {
    document.invalidate(
      maximum,
      "Enter both day limits, with the maximum at least the minimum."
    );
  }
}

function stockRows(product) {
  const variants = product.variants ?? {};

  if (!record(variants)) {
    throw new Error(
      "Variant stock must be an object."
    );
  }

  const sizes = product.sizes || [];
  const colors = product.colors || [];

  for (const option of [...sizes, ...colors]) {
    if (
      !validKey(option) ||
      option === "default"
    ) {
      throw new Error(
        "Choose valid size and colour names. The name default is reserved."
      );
    }
  }

  if (!sizes.length && !colors.length) {
    if (Object.keys(variants).length) {
      throw new Error(
        "List sizes or colours before providing variant quantities."
      );
    }

    return {
      rows: [],
      variants: {},
    };
  }

  if (!Object.keys(variants).length) {
    throw new Error(
      "Enter stock for each listed size and colour, using 0 when unavailable."
    );
  }

  const own = (value, key) =>
    Object.prototype.hasOwnProperty.call(
      value || {},
      key
    );

  const rows = [];
  const normalized = {};

  function quantity(value, color, size) {
    if (
      !["number", "string"].includes(
        typeof value
      ) ||
      (
        typeof value === "string" &&
        !value.trim()
      ) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 0 ||
      Number(value) > 1000000
    ) {
      throw new Error(
        `Enter a whole stock quantity for ${
          [color, size]
            .filter(Boolean)
            .join(" / ")
        }.`
      );
    }

    return Number(value);
  }

  function keys(value, allowed) {
    if (!record(value)) {
      throw new Error(
        "Provide stock quantities as an object."
      );
    }

    if (
      Object.keys(value).some(
        (key) =>
          !validKey(key) ||
          !allowed.includes(key)
      )
    ) {
      throw new Error(
        "Variant stock contains an unlisted size or colour."
      );
    }
  }

  keys(
    variants,
    colors.length ? colors : sizes
  );

  if (colors.length) {
    for (const color of colors) {
      const group = own(variants, color)
        ? variants[color]
        : {};

      normalized[color] = {};

      if (sizes.length) {
        keys(group, sizes);

        for (const size of sizes) {
          const count = quantity(
            own(group, size)
              ? group[size]
              : 0,
            color,
            size
          );

          normalized[color][size] = count;

          rows.push({
            color,
            size,
            quantity: count,
          });
        }
      } else {
        let value;

        // Compatibility with older colour-only stock:
        // { Black: 5 }
        if (
          ["number", "string"].includes(
            typeof group
          )
        ) {
          value = group;
        } else {
          keys(group, ["default"]);

          value = own(group, "default")
            ? group.default
            : 0;
        }

        const count = quantity(
          value,
          color,
          ""
        );

        normalized[color].default = count;

        rows.push({
          color,
          size: "",
          quantity: count,
        });
      }
    }
  } else {
    for (const size of sizes) {
      const count = quantity(
        own(variants, size)
          ? variants[size]
          : 0,
        "",
        size
      );

      normalized[size] = count;

      rows.push({
        color: "",
        size,
        quantity: count,
      });
    }
  }

  if (rows.length > 2500) {
    throw new Error(
      "A product cannot exceed 2,500 variants."
    );
  }

  return {
    rows,
    variants: normalized,
  };
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
    .update(
      JSON.stringify([color, size])
    )
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
  {
    timestamps: true,
  }
);

const deliverySchema = new mongoose.Schema(
  {
    available: {
      type: Boolean,
      default: true,
    },
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
      max: 100000000,
    },

    // Courier transit time after dispatch.
    // Unknown values remain null.
    transitDaysMin: optionalDays(),
    transitDaysMax: optionalDays(),
  },
  {
    _id: false,
  }
);

deliverySchema.pre(
  "validate",
  function () {
    validateRange(
      this,
      "transitDaysMin",
      "transitDaysMax"
    );
  }
);

const fulfillmentSchema =
  new mongoose.Schema(
    {
      stockSource: {
        type: String,
        enum: [
          "unconfirmed",
          "gymdrobe",
          "supplier",
        ],
        default: "unconfirmed",
      },
      dispatchBy: {
        type: String,
        enum: [
          "unconfirmed",
          "gymdrobe",
          "supplier",
          "fulfillment-partner",
        ],
        default: "unconfirmed",
      },
      preparationDaysMin: optionalDays(),
      preparationDaysMax: optionalDays(),
      canSendToPackingLocation: {
        type: Boolean,
        default: false,
      },
      supplierStockConfirmedAt: {
        type: Date,
        default: null,
      },
    },
    {
      _id: false,
    }
  );

fulfillmentSchema.pre(
  "validate",
  function () {
    validateRange(
      this,
      "preparationDaysMin",
      "preparationDaysMax"
    );
  }
);

const kitSettingsSchema =
  new mongoose.Schema(
    {
      eligible: {
        type: Boolean,
        default: false,
      },
      roles: {
        type: [
          {
            type: String,
            enum: [
              "clothing",
              "footwear",
              "supplements",
              "training-accessories",
              "gym-bag",
              "bottle-or-shaker",
              "workout-essentials",
            ],
          },
        ],
        default: [],
      },
    },
    {
      _id: false,
    }
  );

kitSettingsSchema.pre(
  "validate",
  function () {
    if (this.roles) {
      this.roles = [
        ...new Set(this.roles),
      ];
    }

    if (
      this.eligible &&
      !this.roles?.length
    ) {
      this.invalidate(
        "roles",
        "Choose at least one kit category before enabling kit eligibility."
      );
    }
  }
);

const optionLabelsSchema =
  new mongoose.Schema(
    {
      // Reuse existing size/colour inventory axes and SKUs.
      size: {
        type: String,
        enum: [
          "Size",
          "Pack size",
          "Capacity",
          "Weight",
          "Length",
          "Option",
        ],
        default: "Size",
      },
      color: {
        type: String,
        enum: [
          "Colour",
          "Flavour",
          "Style",
          "Material",
          "Option",
        ],
        default: "Colour",
      },
    },
    {
      _id: false,
    }
  );

const variantSkuSchema =
  new mongoose.Schema(
    {
      color: {
        type: String,
        default: "",
      },
      size: {
        type: String,
        default: "",
      },
      sku: {
        type: String,
        required: true,
        maxlength: 100,
      },
    },
    {
      _id: false,
    }
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
      default: "",
      trim: true,
      maxlength: 100,
    },

    // Private fields require explicit admin selection.
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
      select: false,
      index: true,
    },
    meeshoProductLink: {
      type: String,
      default: "",
      select: false,
      maxlength: 2000,
      set: normalizeMeeshoLink,
      validate: {
        validator: (value) => {
          try {
            normalizeMeeshoLink(value);
            return true;
          } catch {
            return false;
          }
        },
        message:
          "Enter a safe HTTPS Meesho product link.",
      },
    },
    purchaseCost: {
      type: Number,
      default: null,
      min: 0,
      max: 100000000,
      select: false,
      validate: {
        validator: (value) =>
          value == null ||
          (
            Number.isFinite(value) &&
            Math.abs(
              value * 100 -
                Math.round(value * 100)
            ) < 0.00001
          ),
        message:
          "Purchase cost must be a valid INR amount with at most two decimal places.",
      },
    },
    fulfillment: {
      type: fulfillmentSchema,
      default: () => ({}),
      select: false,
    },

    // Eligibility alone does not publish a kit or
    // confirm a packing arrangement.
    kitSettings: {
      type: kitSettingsSchema,
      default: () => ({}),
    },

    gender: {
      type: String,
      default: "Unisex",
      trim: true,
      maxlength: 50,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
      max: 100000000,
    },
    discount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    reviewCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    reviews: {
      type: [reviewSchema],
      default: [],
    },
    badge: {
      type: String,
      default: "",
      trim: true,
      maxlength: 80,
    },
    tags: {
      type: [String],
      default: [],
    },
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

    // Mongoose uses isNew internally.
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
    highlights: {
      type: [String],
      default: [],
    },
    specifications: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    careInstructions: {
      type: [String],
      default: [],
    },
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

    optionLabels: {
      type: optionLabelsSchema,
      default: () => ({}),
    },
    sizes: {
      type: [String],
      default: [],
    },
    colors: {
      type: [String],
      default: [],
    },
    variants: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    variantSkus: {
      type: [variantSkuSchema],
      default: [],
    },
    stock: {
      type: Number,
      default: 0,
      min: 0,
      max: 1000000,
      validate: {
        validator: Number.isSafeInteger,
        message:
          "Stock must be a whole number from 0 to 1,000,000.",
      },
      index: true,
    },
    stockStatus: {
      type: String,
      enum: [
        "in-stock",
        "low-stock",
        "out-of-stock",
      ],
      default: "out-of-stock",
      index: true,
    },
    image: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    images: {
      type: [String],
      default: [],
    },

    // One gallery per colour, shared across all sizes.
    colorImages: {
      type: [
        new mongoose.Schema(
          {
            color: {
              type: String,
              required: true,
              trim: true,
              maxlength: 80,
            },
            images: {
              type: [String],
              default: [],
            },
          },
          {
            _id: false,
          }
        ),
      ],
      default: [],
    },

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
    returnsEligible: {
      type: String,
      enum: [
        "yes",
        "no",
        "unconfirmed",
      ],
      default: "unconfirmed",
    },
    returnConditions: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },

    // Matches the current order controller's supported window.
    returnWindowDays: {
      type: Number,
      default: 7,
      min: 1,
      max: 7,
      validate: {
        validator: Number.isSafeInteger,
        message:
          "The current return window must be a whole number from 1 to 7 days.",
      },
    },

    // Existing parent SKUs are retained.
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

productSchema.pre(
  "validate",
  function () {
    this.name = clean(this.name);
    this.slug = clean(this.slug).toLowerCase();
    this.category = clean(this.category);
    this.subcategory = clean(this.subcategory);
    this.brand = clean(this.brand);
    this.gender = clean(
      this.gender || "Unisex"
    );

    if (
      this.returnsEligible === "yes" &&
      (
        this.isNew ||
        this.isModified("returnsEligible") ||
        this.isModified("returnPolicy") ||
        this.isModified("returnConditions")
      ) &&
      !clean(this.returnPolicy) &&
      !clean(this.returnConditions)
    ) {
      this.invalidate(
        "returnConditions",
        "Record the actual return conditions before marking this product returnable."
      );
    }

    if (this.isNew && !this.brand) {
      this.invalidate(
        "brand",
        "Choose the actual product brand."
      );
    }

    if (!this.productCode) {
      this.set(
        "productCode",
        `GD-${String(this._id).toUpperCase()}`,
        {
          overwriteImmutable: true,
        }
      );
    }

    this.sku = clean(
      this.sku || this.productCode
    ).toUpperCase();

    for (
      const [field, maximum, length] of [
        ["tags", 50, 100],
        ["highlights", 30, 500],
        ["careInstructions", 30, 500],
        ["sizes", 50, 50],
        ["colors", 50, 80],
        ["images", 20, 2000],
      ]
    ) {
      const values = cleanArray(
        this[field],
        maximum,
        length,
        field === "images"
      );

      if (
        values.length > maximum ||
        values.some(
          (value) => value.length > length
        )
      ) {
        this.invalidate(
          field,
          `${field} allows up to ${maximum} entries, each up to ${length} characters.`
        );
      }

      this[field] = values;
    }

    try {
      this.colorImages =
        normalizeColorImages(
          this.colorImages,
          this.colors || []
        );
    } catch (error) {
      this.invalidate(
        "colorImages",
        error.message
      );
    }

    this.image = clean(this.image);

    if (
      !this.image &&
      this.images.length
    ) {
      this.image = this.images[0];
    }

    if (
      this.image &&
      !this.images.includes(this.image)
    ) {
      this.images = [
        this.image,
        ...this.images,
      ];

      if (this.images.length > 20) {
        this.invalidate(
          "images",
          "Use no more than 20 photos including the main photo."
        );
      }
    }

    try {
      const result = stockRows(this);
      const rows = result.rows;

      if (rows.length) {
        const total = rows.reduce(
          (sum, row) =>
            sum + row.quantity,
          0
        );

        if (total > 1000000) {
          throw new Error(
            "Combined product stock cannot exceed 1,000,000."
          );
        }

        this.stock = total;

        if (
          JSON.stringify(this.variants) !==
          JSON.stringify(result.variants)
        ) {
          this.variants = result.variants;
          this.markModified("variants");
        }
      } else if (
        !Number.isSafeInteger(this.stock) ||
        this.stock < 0 ||
        this.stock > 1000000
      ) {
        this.invalidate(
          "stock",
          "Stock must be a whole number from 0 to 1,000,000."
        );
      }

      const previous = new Map(
        (this.variantSkus || []).map(
          (row) => [
            JSON.stringify([
              row.color || "",
              row.size || "",
            ]),
            row.sku,
          ]
        )
      );

      const next = rows.map((row) => ({
        color: row.color,
        size: row.size,
        sku:
          previous.get(
            JSON.stringify([
              row.color,
              row.size,
            ])
          ) ||
          variantSku(
            this.productCode,
            row.color,
            row.size
          ),
      }));

      const skuValues = next.map(
        (row) => row.sku
      );

      if (
        new Set(skuValues).size !==
        skuValues.length
      ) {
        this.invalidate(
          "variantSkus",
          "Variant SKUs must be unique."
        );
      }

      const current = (
        this.variantSkus || []
      ).map((row) => ({
        color: row.color,
        size: row.size,
        sku: row.sku,
      }));

      if (
        JSON.stringify(current) !==
        JSON.stringify(next)
      ) {
        this.variantSkus = next;
      }
    } catch (error) {
      this.invalidate(
        "variants",
        error.message
      );
    }

    this.stockStatus =
      this.stock <= 0
        ? "out-of-stock"
        : this.stock <= 10
          ? "low-stock"
          : "in-stock";

    const validReviews = (
      this.reviews || []
    ).filter(
      (review) =>
        review.rating >= 1 &&
        review.rating <= 5
    );

    this.reviewCount =
      validReviews.length;

    this.rating = validReviews.length
      ? Math.round(
          (
            validReviews.reduce(
              (total, review) =>
                total + review.rating,
              0
            ) / validReviews.length
          ) * 10
        ) / 10
      : 0;

    if (!this.delivery) {
      this.delivery = {};
    }
  }
);

function transformProduct(document, result) {
  result.isNew = Boolean(
    result.isNewArrival
  );

  result.productCode =
    result.productCode ||
    `GD-${String(result._id).toUpperCase()}`;

  delete result.isNewArrival;
  delete result.__v;

  // Protect private fields in normal product output,
  // including newly created documents.
  delete result.supplier;
  delete result.purchaseCost;
  delete result.fulfillment;
  delete result.meeshoProductLink;

  return result;
}

productSchema.set("toJSON", {
  transform: transformProduct,
});

productSchema.set("toObject", {
  transform: transformProduct,
});

productSchema.index(
  {
    productCode: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      productCode: {
        $type: "string",
      },
    },
  }
);

productSchema.index(
  {
    "variantSkus.sku": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "variantSkus.sku": {
        $type: "string",
      },
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