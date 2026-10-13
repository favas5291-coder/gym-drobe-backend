const mongoose = require("mongoose");

const {
  reference,
  dayRange,
  confirmedDate,
} = require("../utils/kitDefinitions");

const PRIVATE_FIELDS = [
  "origin",
  "productIds",
  "destinationPincodes",
  "service",
  "parcelLimits",
  "charges",
  "verification",
  "notes",
];

const noId = { _id: false };

function integer(maximum, fallback = null, minimum = 0) {
  return {
    type: Number,
    default: fallback,
    min: minimum,
    max: maximum,

    validate: {
      validator: (value) =>
        value == null || Number.isSafeInteger(value),

      message:
        `Use a whole number from ${minimum} to ${maximum}.`,
    },
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

    name: {
      type: String,
      default: "",
      trim: true,
      maxlength: 200,
    },

    pickupPincode: {
      type: String,
      default: "",
      trim: true,

      validate: {
        validator: (value) =>
          !value || /^[1-9]\d{5}$/.test(value),

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
  noId,
);

originSchema.pre("validate", function () {
  if (
    this.kind === "packing-location" &&
    this.supplier
  ) {
    this.invalidate(
      "packingLocation",
      "Select one packing location without a supplier origin reference.",
    );
  }

  if (
    this.kind === "supplier" &&
    this.packingLocation
  ) {
    this.invalidate(
      "supplier",
      "Select one supplier without a packing-location origin reference.",
    );
  }

  if (
    ["gymdrobe", "unconfigured"].includes(this.kind) &&
    (this.packingLocation || this.supplier)
  ) {
    this.invalidate(
      "kind",
      "Remove unrelated origin references before choosing this origin type.",
    );
  }
});

const serviceSchema = new mongoose.Schema(
  {
    carrier: {
      type: String,
      default: "",
      trim: true,
      maxlength: 100,
    },

    name: {
      type: String,
      default: "",
      trim: true,
      maxlength: 150,
    },

    deliveryMethod: {
      type: String,
      enum: ["standard", "express"],
      default: "standard",
    },

    supportsOnline: {
      type: Boolean,
      default: true,
    },

    supportsCodAdvance: {
      type: Boolean,
      default: false,
    },

    maximumCodBalancePaise: integer(100000000),

    transitDaysMin: integer(365),
    transitDaysMax: integer(365),
  },
  noId,
);

serviceSchema.pre("validate", function () {
  if (
    (
      this.transitDaysMin != null ||
      this.transitDaysMax != null
    ) &&
    !dayRange(this.transitDaysMin, this.transitDaysMax)
  ) {
    this.invalidate(
      "transitDaysMax",
      "Record both valid courier transit limits, with maximum at least minimum.",
    );
  }
});

const parcelSchema = new mongoose.Schema(
  {
    maximumWeightGrams: integer(500000, null, 1),
    maximumLengthMm: integer(10000, null, 1),
    maximumWidthMm: integer(10000, null, 1),
    maximumHeightMm: integer(10000, null, 1),
    maximumUnits: integer(999, null, 1),
  },
  noId,
);

const chargesSchema = new mongoose.Schema(
  {
    // Customer charges include applicable fees and taxes.
    // Amounts are stored in paise: 9900 means INR 99.
    shippingPaise: integer(100000000),

    codFeePaise: integer(100000000, 0),

    // An unknown courier cost stays null.
    // It must not be treated as zero when calculating profit.
    courierCostPaise: integer(100000000),
  },
  noId,
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

    arrangementReference: {
      type: String,
      default: "",
      trim: true,
      maxlength: 200,
    },

    validUntil: {
      type: Date,
      default: null,
    },
  },
  noId,
);

const schema = new mongoose.Schema(
  {
    profileCode: {
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

    productIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
        },
      ],
      default: [],
      select: false,

      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length <= 500 &&
          values.every((value) => Boolean(reference(value))) &&
          new Set(values.map(reference)).size === values.length,

        message:
          "Choose at most 500 distinct products covered by this shipping profile.",
      },
    },

    destinationPincodes: {
      type: [
        {
          type: String,
          trim: true,
        },
      ],
      default: [],
      select: false,

      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length <= 10000 &&
          values.every((value) => /^[1-9]\d{5}$/.test(value)) &&
          new Set(values).size === values.length,

        message:
          "Use at most 10,000 distinct, valid destination pincodes. Wildcards are not supported.",
      },
    },

    service: {
      type: serviceSchema,
      default: () => ({}),
      select: false,
    },

    parcelLimits: {
      type: parcelSchema,
      default: () => ({}),
      select: false,
    },

    charges: {
      type: chargesSchema,
      default: () => ({}),
      select: false,
    },

    verification: {
      type: verificationSchema,
      default: () => ({}),
      select: false,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
      select: false,
    },
  },
  {
    timestamps: true,
    minimize: false,
    optimisticConcurrency: true,
  },
);

schema.pre("validate", function () {
  if (
    !this.profileCode &&
    (this.isNew || this.isSelected("profileCode"))
  ) {
    this.set(
      "profileCode",
      `SHIP-${String(this._id).toUpperCase()}`,
      { overwriteImmutable: true },
    );
  }

  // Drafts may contain incomplete setup.
  if (this.status !== "active") {
    return;
  }

  if (
    PRIVATE_FIELDS.some(
      (field) => !this.isSelected(field),
    )
  ) {
    this.invalidate(
      "status",
      "Load the complete shipping profile before saving an active record.",
    );

    return;
  }

  if (
    !this.origin ||
    this.origin.kind === "unconfigured" ||
    !this.origin.name?.trim() ||
    !/^[1-9]\d{5}$/.test(this.origin.pickupPincode || "")
  ) {
    this.invalidate(
      "origin",
      "Record the actual dispatch origin and pickup pincode before activation.",
    );
  }

  if (
    this.origin?.kind === "packing-location" &&
    !reference(this.origin.packingLocation)
  ) {
    this.invalidate(
      "origin.packingLocation",
      "Select the actual packing location before activation.",
    );
  }

  if (
    this.origin?.kind === "supplier" &&
    !reference(this.origin.supplier)
  ) {
    this.invalidate(
      "origin.supplier",
      "Select the actual supplier before activation.",
    );
  }

  if (!this.productIds?.length) {
    this.invalidate(
      "productIds",
      "Select the actual products covered by this profile.",
    );
  }

  if (!this.destinationPincodes?.length) {
    this.invalidate(
      "destinationPincodes",
      "Record the exact destination pincodes confirmed by this courier arrangement.",
    );
  }

  if (
    !this.service?.carrier ||
    !this.service.name ||
    !dayRange(
      this.service.transitDaysMin,
      this.service.transitDaysMax,
    ) ||
    !(
      this.service.supportsOnline ||
      this.service.supportsCodAdvance
    )
  ) {
    this.invalidate(
      "service",
      "Record the courier, service, transit estimates and supported payment methods.",
    );
  }

  if (
    this.service?.supportsCodAdvance &&
    (
      !Number.isSafeInteger(
        this.service.maximumCodBalancePaise,
      ) ||
      this.service.maximumCodBalancePaise < 1
    )
  ) {
    this.invalidate(
      "service.maximumCodBalancePaise",
      "Record the confirmed maximum COD balance in paise.",
    );
  }

  for (const field of [
    "maximumWeightGrams",
    "maximumLengthMm",
    "maximumWidthMm",
    "maximumHeightMm",
    "maximumUnits",
  ]) {
    if (
      !Number.isSafeInteger(this.parcelLimits?.[field]) ||
      this.parcelLimits[field] < 1
    ) {
      this.invalidate(
        `parcelLimits.${field}`,
        "Record the actual parcel limits covered by the agreed rate.",
      );
    }
  }

  if (
    !Number.isSafeInteger(this.charges?.shippingPaise) ||
    this.charges.shippingPaise < 0 ||
    !Number.isSafeInteger(this.charges?.codFeePaise) ||
    this.charges.codFeePaise < 0
  ) {
    this.invalidate(
      "charges",
      "Record the complete customer shipping charge and COD fee in paise.",
    );
  }

  if (
    !this.service?.supportsCodAdvance &&
    this.charges?.codFeePaise !== 0
  ) {
    this.invalidate(
      "charges.codFeePaise",
      "Use zero COD fee when this service does not support COD advance.",
    );
  }

  const confirmedAt = this.verification?.confirmedAt;
  const validUntil = this.verification?.validUntil;

  if (
    !confirmedDate(confirmedAt) ||
    !reference(this.verification?.confirmedBy) ||
    !this.verification?.arrangementReference?.trim() ||
    !(validUntil instanceof Date) ||
    !Number.isFinite(validUntil.getTime()) ||
    validUntil.getTime() <= Date.now() ||
    validUntil.getTime() <= new Date(confirmedAt).getTime()
  ) {
    this.invalidate(
      "verification",
      "Record who verified the actual coverage and rate, its reference, confirmation date and future expiry.",
    );
  }

  const operationalFields = [
    "name",
    "origin",
    "productIds",
    "destinationPincodes",
    "service",
    "parcelLimits",
    "charges",
    "verification.validUntil",
    "verification.arrangementReference",
  ];

  if (
    !this.isNew &&
    operationalFields.some(
      (field) => this.isModified(field),
    ) &&
    !this.isModified("verification.confirmedAt")
  ) {
    this.invalidate(
      "status",
      "Save changed shipping terms as paused or draft, then verify the updated arrangement again.",
    );
  }
});

function hidePrivate(document, result) {
  for (const field of [...PRIVATE_FIELDS, "__v"]) {
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

// Use document save() so validation and version checks run.
for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
]) {
  schema.pre(operation, function () {
    throw new Error(
      "Load the complete shipping profile and use save() so validation and version checks run.",
    );
  });
}

schema.statics.adminFields = PRIVATE_FIELDS
  .map((field) => `+${field}`)
  .join(" ");

schema.index(
  { profileCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      profileCode: { $type: "string" },
    },
  },
);

schema.index({
  status: 1,
  "origin.kind": 1,
  "service.deliveryMethod": 1,
});

module.exports =
  mongoose.models.ShippingProfile ||
  mongoose.model("ShippingProfile", schema);