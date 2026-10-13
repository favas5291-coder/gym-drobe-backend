const mongoose = require("mongoose");

const {
  reference,
  confirmedDate,
} = require("../utils/kitDefinitions");

const noId = { _id: false };

const PRIVATE_FIELDS = [
  "origin",
  "components",
  "parcels",
  "verification",
  "notes",
];

const OPERATIONAL_FIELDS = [
  "name",
  "origin",
  "components",
  "parcels",
  "verification.measurementReference",
  "verification.validUntil",
];

function wholeNumber(
  maximum,
  minimum = 1,
  fallback = null
) {
  return {
    type: Number,
    default: fallback,
    min: minimum,
    max: maximum,

    validate: {
      validator: (value) =>
        value == null ||
        Number.isSafeInteger(value),

      message:
        `Use a whole number from ${minimum} to ${maximum}.`,
    },
  };
}

function shortText(
  maximum,
  fallback = ""
) {
  return {
    type: String,
    default: fallback,
    trim: true,
    maxlength: maximum,
  };
}

const originSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: [
        "unconfigured",
        "packing-location",
        "supplier",
        "gymdrobe",
      ],
      default: "unconfigured",
    },

    name: shortText(200),

    pickupPincode: {
      ...shortText(6),

      validate: {
        validator: (value) =>
          !value ||
          /^[1-9]\d{5}$/.test(value),

        message:
          "Enter a valid six-digit pickup pincode.",
      },
    },

    packingLocation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PackingLocation",
      default: null,
    },

    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
  },
  noId
);

originSchema.pre("validate", function () {
  if (
    this.kind === "packing-location" &&
    this.supplier
  ) {
    this.invalidate(
      "supplier",
      "A packing-location origin cannot also be a supplier origin."
    );
  }

  if (
    this.kind === "supplier" &&
    this.packingLocation
  ) {
    this.invalidate(
      "packingLocation",
      "A supplier origin cannot also be a packing-location origin."
    );
  }

  if (
    ["gymdrobe", "unconfigured"].includes(
      this.kind
    ) &&
    (this.supplier || this.packingLocation)
  ) {
    this.invalidate(
      "kind",
      "Remove references that do not belong to this origin type."
    );
  }
});

const componentSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      match: /^[a-z][a-z0-9-]{0,59}$/,
    },

    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    selectedSize: shortText(200, null),

    selectedColor: shortText(200, null),

    quantity: {
      ...wholeNumber(999),
      required: true,
    },
  },
  noId
);

const allocationSchema = new mongoose.Schema(
  {
    componentKey: {
      type: String,
      required: true,
      trim: true,
      match: /^[a-z][a-z0-9-]{0,59}$/,
    },

    quantity: {
      ...wholeNumber(999),
      required: true,
    },
  },
  noId
);

const parcelSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      match: /^[a-z][a-z0-9-]{0,59}$/,
    },

    label: shortText(150),

    // Actual sealed parcel measurements,
    // including the packaging.
    // Product dimensions are not added together
    // to invent a parcel size.
    weightGrams: wholeNumber(500000),

    lengthMm: wholeNumber(10000),

    widthMm: wholeNumber(10000),

    heightMm: wholeNumber(10000),

    contents: {
      type: [allocationSchema],
      default: [],

      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length <= 50,

        message:
          "Use at most 50 component allocations in one parcel.",
      },
    },
  },
  noId
);

const verificationSchema = new mongoose.Schema(
  {
    confirmedAt: {
      type: Date,
      default: null,
    },

    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    measurementReference: shortText(200),

    validUntil: {
      type: Date,
      default: null,
    },
  },
  noId
);

const schema = new mongoose.Schema(
  {
    planCode: {
      type: String,
      trim: true,
      uppercase: true,
      immutable: true,
      maxlength: 100,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 200,
    },

    status: {
      type: String,
      enum: [
        "draft",
        "active",
        "paused",
        "archived",
      ],
      default: "draft",
    },

    origin: {
      type: originSchema,
      default: () => ({}),
      select: false,
    },

    components: {
      type: [componentSchema],
      default: [],
      select: false,

      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length <= 50,

        message:
          "Use at most 50 distinct product and variant selections.",
      },
    },

    parcels: {
      type: [parcelSchema],
      default: [],
      select: false,

      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length <= 50,

        message:
          "Use at most 50 parcels in one dispatch plan.",
      },
    },

    verification: {
      type: verificationSchema,
      default: () => ({}),
      select: false,
    },

    notes: {
      ...shortText(2000),
      select: false,
    },
  },
  {
    timestamps: true,
    minimize: false,
    optimisticConcurrency: true,
  }
);

schema.pre("validate", function () {
  if (
    !this.planCode &&
    (
      this.isNew ||
      this.isSelected("planCode")
    )
  ) {
    this.set(
      "planCode",
      `PACKPLAN-${String(this._id).toUpperCase()}`,
      {
        overwriteImmutable: true,
      }
    );
  }

  const allLoaded = PRIVATE_FIELDS.every(
    (field) => this.isSelected(field)
  );

  if (!allLoaded) {
    if (this.status === "active") {
      this.invalidate(
        "status",
        "Load the complete package plan before saving an active record."
      );
    }

    return;
  }

  const components = this.components || [];
  const parcels = this.parcels || [];

  const byKey = new Map();
  const variantKeys = new Set();
  const allocated = new Map();
  const parcelKeys = new Set();

  for (const row of components) {
    const productId = reference(row.product);

    const variantKey = JSON.stringify([
      productId,
      row.selectedSize || null,
      row.selectedColor || null,
    ]);

    if (
      byKey.has(row.key) ||
      variantKeys.has(variantKey)
    ) {
      this.invalidate(
        "components",
        "Use distinct component keys and combine quantities for matching product variants."
      );
    }

    if (!productId) {
      this.invalidate(
        "components",
        "Select an existing product ID for each component."
      );
    }

    byKey.set(row.key, row);
    variantKeys.add(variantKey);
  }

  for (const parcel of parcels) {
    if (parcelKeys.has(parcel.key)) {
      this.invalidate(
        "parcels",
        "Use a distinct key for each parcel."
      );
    }

    parcelKeys.add(parcel.key);

    const keys = new Set();

    for (const row of parcel.contents || []) {
      if (
        !byKey.has(row.componentKey) ||
        keys.has(row.componentKey)
      ) {
        this.invalidate(
          "parcels",
          "Each parcel must reference known components once; combine repeated quantities."
        );
      }

      keys.add(row.componentKey);

      allocated.set(
        row.componentKey,
        (
          allocated.get(row.componentKey) || 0
        ) + row.quantity
      );
    }

    if (this.status === "active") {
      if (!parcel.contents?.length) {
        this.invalidate(
          "parcels",
          "An active plan cannot contain an empty parcel."
        );
      }

      for (const field of [
        "weightGrams",
        "lengthMm",
        "widthMm",
        "heightMm",
      ]) {
        if (
          !Number.isSafeInteger(parcel[field]) ||
          parcel[field] < 1
        ) {
          this.invalidate(
            "parcels",
            "Record the measured packed weight and all three dimensions for every parcel."
          );
        }
      }
    }
  }

  for (const row of components) {
    const total =
      allocated.get(row.key) || 0;

    if (total > row.quantity) {
      this.invalidate(
        "parcels",
        "Parcel contents exceed a selected component quantity."
      );
    }

    if (
      this.status === "active" &&
      total !== row.quantity
    ) {
      this.invalidate(
        "parcels",
        "Account for every selected unit exactly once across the parcels."
      );
    }
  }

  if (this.status !== "active") {
    return;
  }

  if (
    !components.length ||
    !parcels.length
  ) {
    this.invalidate(
      "status",
      "Record actual components and at least one measured parcel before activation."
    );
  }

  const origin = this.origin;

  if (
    !origin ||
    origin.kind === "unconfigured" ||
    !origin.name?.trim() ||
    !/^[1-9]\d{5}$/.test(
      origin.pickupPincode || ""
    ) ||
    (
      origin.kind === "packing-location" &&
      !reference(origin.packingLocation)
    ) ||
    (
      origin.kind === "supplier" &&
      !reference(origin.supplier)
    )
  ) {
    this.invalidate(
      "origin",
      "Record the actual dispatch origin, pickup pincode and applicable location or supplier reference."
    );
  }

  const audit = this.verification;

  if (
    !confirmedDate(audit?.confirmedAt) ||
    !reference(audit?.confirmedBy) ||
    !audit?.measurementReference?.trim() ||
    !(audit.validUntil instanceof Date) ||
    !Number.isFinite(
      audit.validUntil.getTime()
    ) ||
    audit.validUntil.getTime() <= Date.now() ||
    audit.validUntil.getTime() <=
      new Date(audit.confirmedAt).getTime()
  ) {
    this.invalidate(
      "verification",
      "Record who confirmed the measured packing plan, its reference and a future review expiry."
    );
  }

  if (
    !this.isNew &&
    OPERATIONAL_FIELDS.some(
      (field) => this.isModified(field)
    ) &&
    !this.isModified(
      "verification.confirmedAt"
    )
  ) {
    this.invalidate(
      "status",
      "Pause the plan and confirm new measurements after changing contents, origin or parcel measurements."
    );
  }
});

function hidePrivate(document, result) {
  for (const field of [
    ...PRIVATE_FIELDS,
    "__v",
  ]) {
    delete result[field];
  }

  return result;
}

schema.set("toJSON", {
  transform: hidePrivate,
});

schema.set("toObject", {
  transform: hidePrivate,
});

schema.statics.adminFields =
  PRIVATE_FIELDS.map(
    (field) => `+${field}`
  ).join(" ");

for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
]) {
  schema.pre(operation, function () {
    throw new Error(
      "Load the complete package plan and use save() so validation and version checks run."
    );
  });
}

schema.index(
  {
    planCode: 1,
  },
  {
    unique: true,

    partialFilterExpression: {
      planCode: {
        $type: "string",
      },
    },
  }
);

schema.index({
  status: 1,
  "origin.kind": 1,
  updatedAt: -1,
});

module.exports =
  mongoose.models.PackagePlan ||
  mongoose.model(
    "PackagePlan",
    schema
  );