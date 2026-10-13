const mongoose = require("mongoose");

const {
  dayRange,
  confirmedDate,
  reference,
} = require("../utils/kitDefinitions");

function days() {
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
        "Days must be whole numbers from 0 to 365.",
    },
  };
}

const noId = { _id: false };

const addressSchema = new mongoose.Schema({
  addressLine: {
    type: String,
    default: "",
    trim: true,
    maxlength: 500,
  },

  city: {
    type: String,
    default: "",
    trim: true,
    maxlength: 100,
  },

  state: {
    type: String,
    default: "",
    trim: true,
    maxlength: 100,
  },

  pincode: {
    type: String,
    default: "",
    trim: true,
    validate: {
      validator: (value) =>
        !value ||
        /^[1-9]\d{5}$/.test(value),

      message:
        "Enter a valid six-digit packing-location pincode.",
    },
  },
}, noId);

const contactSchema = new mongoose.Schema({
  name: {
    type: String,
    default: "",
    trim: true,
    maxlength: 100,
  },

  phone: {
    type: String,
    default: "",
    trim: true,
    validate: {
      validator: (value) =>
        !value ||
        /^\d{7,15}$/.test(value),

      message:
        "Use 7–15 digits for the contact phone.",
    },
  },

  email: {
    type: String,
    default: "",
    trim: true,
    lowercase: true,
    maxlength: 150,
    validate: {
      validator: (value) =>
        !value ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),

      message:
        "Enter a valid contact email.",
    },
  },
}, noId);

const verificationSchema = new mongoose.Schema({
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
}, noId);

const supplierArrangementSchema = new mongoose.Schema({
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Supplier",
    required: true,
  },

  status: {
    type: String,
    enum: ["pending", "confirmed", "paused"],
    default: "pending",
  },

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

  transferDaysMin: days(),
  transferDaysMax: days(),
}, noId);

supplierArrangementSchema.pre("validate", function () {
  const either =
    this.transferDaysMin != null ||
    this.transferDaysMax != null;

  if (
    either &&
    !dayRange(
      this.transferDaysMin,
      this.transferDaysMax,
    )
  ) {
    this.invalidate(
      "transferDaysMax",
      "Record both valid supplier-to-packing transfer limits.",
    );
  }

  if (
    this.status === "confirmed" &&
    (
      !confirmedDate(this.confirmedAt) ||
      !this.confirmedBy ||
      !this.arrangementReference ||
      !dayRange(
        this.transferDaysMin,
        this.transferDaysMax,
      )
    )
  ) {
    this.invalidate(
      "status",
      "Confirm the real supplier-to-location arrangement, its verifier, reference and transfer times.",
    );
  }
});

// This route covers only explicitly selected GymDrobe-held products.
// It is not automatically applied to every product or stock location.
const gymdrobeStockTransferSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ["pending", "confirmed", "paused"],
    default: "pending",
  },

  originName: {
    type: String,
    default: "",
    trim: true,
    maxlength: 200,
  },

  originAddress: {
    type: addressSchema,
    default: () => ({}),
  },

  originContact: {
    type: contactSchema,
    default: () => ({}),
  },

  productIds: {
    type: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    }],

    default: [],

    validate: {
      validator: (values) =>
        Array.isArray(values) &&
        values.length <= 500 &&
        values.every(
          (value) => Boolean(reference(value)),
        ) &&
        new Set(values.map(reference)).size ===
          values.length,

      message:
        "Choose at most 500 distinct product IDs for this transfer route.",
    },
  },

  transferDaysMin: days(),
  transferDaysMax: days(),

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
}, noId);

gymdrobeStockTransferSchema.pre("validate", function () {
  const either =
    this.transferDaysMin != null ||
    this.transferDaysMax != null;

  if (
    either &&
    !dayRange(
      this.transferDaysMin,
      this.transferDaysMax,
    )
  ) {
    this.invalidate(
      "transferDaysMax",
      "Record both valid GymDrobe-to-packing transfer limits.",
    );
  }

  if (this.status !== "confirmed") {
    return;
  }

  if (
    !this.originName ||
    this.originName.trim().length < 2 ||
    !this.originAddress?.addressLine ||
    !this.originAddress.city ||
    !this.originAddress.state ||
    !/^[1-9]\d{5}$/.test(
      this.originAddress.pincode || "",
    )
  ) {
    this.invalidate(
      "originAddress",
      "Record the real GymDrobe stock origin and complete pickup address before confirming this route.",
    );
  }

  if (
    !this.originContact?.name ||
    !(
      this.originContact.phone ||
      this.originContact.email
    )
  ) {
    this.invalidate(
      "originContact",
      "Record a pickup contact and contact method before confirming this route.",
    );
  }

  if (!this.productIds?.length) {
    this.invalidate(
      "productIds",
      "Select the GymDrobe-held products covered by this transfer arrangement.",
    );
  }

  if (
    !dayRange(
      this.transferDaysMin,
      this.transferDaysMax,
    ) ||
    !confirmedDate(this.confirmedAt) ||
    !reference(this.confirmedBy) ||
    !this.arrangementReference?.trim()
  ) {
    this.invalidate(
      "status",
      "Record real transfer times, who confirmed the route, when and its arrangement reference.",
    );
  }

  const changed = [
    "originName",
    "originAddress",
    "originContact",
    "productIds",
    "transferDaysMin",
    "transferDaysMax",
    "arrangementReference",
  ].some((field) => this.isModified(field));

  if (
    !this.isNew &&
    changed &&
    !this.isModified("confirmedAt")
  ) {
    this.invalidate(
      "status",
      "Save transfer-route changes as pending and confirm the updated arrangement again.",
    );
  }
});

const packingSchema = new mongoose.Schema({
  packingDaysMin: days(),
  packingDaysMax: days(),
}, noId);

const deliverySchema = new mongoose.Schema({
  transitDaysMin: days(),
  transitDaysMax: days(),
}, noId);

for (const [childSchema, low, high] of [
  [
    packingSchema,
    "packingDaysMin",
    "packingDaysMax",
  ],
  [
    deliverySchema,
    "transitDaysMin",
    "transitDaysMax",
  ],
]) {
  childSchema.pre("validate", function () {
    if (
      (
        this[low] != null ||
        this[high] != null
      ) &&
      !dayRange(this[low], this[high])
    ) {
      this.invalidate(
        high,
        "Record both valid day limits.",
      );
    }
  });
}

const schema = new mongoose.Schema({
  locationCode: {
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

  operator: {
    type: String,
    enum: ["gymdrobe", "fulfillment-partner"],
    default: "gymdrobe",
  },

  status: {
    type: String,
    enum: ["draft", "active", "paused", "archived"],
    default: "draft",
  },

  address: {
    type: addressSchema,
    default: () => ({}),
    select: false,
  },

  contact: {
    type: contactSchema,
    default: () => ({}),
    select: false,
  },

  verification: {
    type: verificationSchema,
    default: () => ({}),
    select: false,
  },

  packing: {
    type: packingSchema,
    default: () => ({}),
    select: false,
  },

  delivery: {
    type: deliverySchema,
    default: () => ({}),
    select: false,
  },

  acceptsGymDrobeStock: {
    type: Boolean,
    default: false,
    select: false,
  },

  gymdrobeStockTransfer: {
    type: gymdrobeStockTransferSchema,
    default: null,
    select: false,
  },

  supplierArrangements: {
    type: [supplierArrangementSchema],
    default: [],
    select: false,
  },

  notes: {
    type: String,
    default: "",
    trim: true,
    maxlength: 2000,
    select: false,
  },
}, {
  timestamps: true,
  minimize: false,
  optimisticConcurrency: true,
});

schema.pre("validate", function () {
  if (
    !this.locationCode &&
    (
      this.isNew ||
      this.isSelected("locationCode")
    )
  ) {
    this.set(
      "locationCode",
      `PACK-${String(this._id).toUpperCase()}`,
      { overwriteImmutable: true },
    );
  }

  if (this.isSelected("supplierArrangements")) {
    const ids = (
      this.supplierArrangements || []
    ).map((row) => reference(row.supplier));

    if (
      ids.length > 500 ||
      new Set(ids).size !== ids.length
    ) {
      this.invalidate(
        "supplierArrangements",
        "Use at most 500 distinct supplier arrangements.",
      );
    }
  }

  if (
    this.isSelected("gymdrobeStockTransfer") &&
    this.gymdrobeStockTransfer?.status === "confirmed" &&
    (
      !this.isSelected("acceptsGymDrobeStock") ||
      this.acceptsGymDrobeStock !== true
    )
  ) {
    this.invalidate(
      "gymdrobeStockTransfer",
      "Confirm that this packing location accepts GymDrobe-held stock before confirming its transfer route.",
    );
  }

  if (this.status !== "active") {
    return;
  }

  const required = [
    "address",
    "contact",
    "verification",
    "packing",
    "delivery",
    "acceptsGymDrobeStock",
    "supplierArrangements",
  ];

  if (
    required.some(
      (field) => !this.isSelected(field),
    )
  ) {
    this.invalidate(
      "status",
      "Load the complete packing-location record before saving an active location.",
    );
    return;
  }

  if (
    !this.address?.addressLine ||
    !this.address.city ||
    !this.address.state ||
    !/^[1-9]\d{5}$/.test(
      this.address.pincode || "",
    )
  ) {
    this.invalidate(
      "address",
      "Record the real packing-location address before activation.",
    );
  }

  if (
    !this.contact?.name ||
    !(
      this.contact.phone ||
      this.contact.email
    )
  ) {
    this.invalidate(
      "contact",
      "Record a packing contact and contact method.",
    );
  }

  if (
    !confirmedDate(
      this.verification?.confirmedAt,
    ) ||
    !this.verification.confirmedBy ||
    !this.verification.arrangementReference
  ) {
    this.invalidate(
      "verification",
      "Record who confirmed the real packing arrangement, when and its reference.",
    );
  }

  if (
    !dayRange(
      this.packing?.packingDaysMin,
      this.packing?.packingDaysMax,
    )
  ) {
    this.invalidate(
      "packing",
      "Record real packing times.",
    );
  }

  if (
    !dayRange(
      this.delivery?.transitDaysMin,
      this.delivery?.transitDaysMax,
    )
  ) {
    this.invalidate(
      "delivery",
      "Record courier transit estimates; these do not confirm pincode coverage.",
    );
  }
});

function hidePrivate(document, result) {
  for (const field of [
    "address",
    "contact",
    "verification",
    "packing",
    "delivery",
    "acceptsGymDrobeStock",
    "gymdrobeStockTransfer",
    "supplierArrangements",
    "notes",
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

schema.index(
  { locationCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      locationCode: { $type: "string" },
    },
  },
);

schema.index({
  status: 1,
  name: 1,
});

module.exports =
  mongoose.models.PackingLocation ||
  mongoose.model("PackingLocation", schema);