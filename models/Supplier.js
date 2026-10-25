const mongoose = require("mongoose");

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

function phone(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\s()+-]/g, "");
}

function optionalPhone() {
  return {
    type: String,
    default: "",
    set: phone,

    validate: {
      validator: (value) =>
        !value || /^\d{7,15}$/.test(value),

      message:
        "Enter a phone number with 7–15 digits, including its country code when needed.",
    },
  };
}

const contactSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: "",
      trim: true,
      maxlength: 100,
    },

    phone: optionalPhone(),
    whatsapp: optionalPhone(),

    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      maxlength: 150,

      validate: {
        validator: (value) =>
          !value ||
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            value
          ),

        message:
          "Enter a valid supplier contact email address.",
      },
    },
  },
  { _id: false }
);

const verificationSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: [
        "pending",
        "verified",
        "rejected",
      ],
      default: "pending",
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
  },
  { _id: false }
);

const fulfillmentSchema = new mongoose.Schema(
  {
    dispatchToCustomer: {
      type: Boolean,
      default: false,
    },

    sendToPackingLocation: {
      type: Boolean,
      default: false,
    },

    preparationDaysMin: optionalDays(),
    preparationDaysMax: optionalDays(),
  },
  { _id: false }
);

fulfillmentSchema.pre("validate", function () {
  const low = this.preparationDaysMin;
  const high = this.preparationDaysMax;

  if (
    (low == null) !== (high == null) ||
    (low != null && high < low)
  ) {
    this.invalidate(
      "preparationDaysMax",
      "Enter both preparation limits, with the maximum at least the minimum."
    );
  }
});

const supplierSchema = new mongoose.Schema(
  {
    supplierCode: {
      type: String,
      trim: true,
      uppercase: true,
      immutable: true,
      maxlength: 100,
    },

    // The supplier business name is separate
    // from the brand displayed on a product.
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
        "blocked",
        "archived",
      ],
      default: "draft",
    },

    // A staged portal enrollment must not
    // accidentally unlock legacy dispatch.
    // Phase 3/4 will replace this gate with
    // full marketplace order eligibility.
    portalWorkspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupplierWorkspace",
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

    fulfillment: {
      type: fulfillmentSchema,
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
  }
);

supplierSchema.pre("validate", function () {
  if (
    !this.supplierCode &&
    (
      this.isNew ||
      this.isSelected("supplierCode")
    )
  ) {
    this.set(
      "supplierCode",
      `SUP-${String(this._id).toUpperCase()}`,
      { overwriteImmutable: true }
    );
  }

  if (
    (
      this.isNew ||
      this.isModified("verification")
    ) &&
    this.verification?.status === "verified"
  ) {
    if (
      !this.verification.verifiedBy ||
      !this.verification.verifiedAt
    ) {
      this.invalidate(
        "verification",
        "Record who verified this supplier and when. Verification is never automatic."
      );
    }
  }

  const changed =
    this.isNew ||
    [
      "status",
      "contact",
      "verification",
      "fulfillment",
    ].some((field) => this.isModified(field));

  if (
    this.status !== "active" ||
    !changed
  ) {
    return;
  }

  if (
    !this.isSelected("portalWorkspace") ||
    this.portalWorkspace
  ) {
    this.invalidate(
      "status",
      "Marketplace suppliers remain drafts until supplier inventory and order routing are enabled. Load the full supplier record before activation."
    );
  }

  // Admin APIs must load private fields before
  // activating or changing an active supplier.
  if (
    [
      "contact",
      "verification",
      "fulfillment",
    ].some(
      (field) => !this.isSelected(field)
    )
  ) {
    this.invalidate(
      "status",
      "Load the complete supplier record before updating an active supplier."
    );

    return;
  }

  const contact = this.contact;
  const verification = this.verification;
  const fulfillment = this.fulfillment;

  if (
    verification?.status !== "verified" ||
    !verification.verifiedBy ||
    !verification.verifiedAt
  ) {
    this.invalidate(
      "status",
      "Verify this supplier before activating it."
    );
  }

  if (
    !contact ||
    !(
      contact.phone ||
      contact.whatsapp ||
      contact.email
    )
  ) {
    this.invalidate(
      "contact",
      "Add a supplier contact method before activating it."
    );
  }

  if (
    !fulfillment ||
    !(
      fulfillment.dispatchToCustomer ||
      fulfillment.sendToPackingLocation
    )
  ) {
    this.invalidate(
      "fulfillment",
      "Configure at least one real fulfillment arrangement before activating it."
    );
  }

  if (
    fulfillment?.preparationDaysMin == null ||
    fulfillment?.preparationDaysMax == null
  ) {
    this.invalidate(
      "fulfillment",
      "Record preparation times before activating this supplier."
    );
  }
});

function hidePrivateFields(document, result) {
  delete result.contact;
  delete result.verification;
  delete result.fulfillment;
  delete result.notes;
  delete result.portalWorkspace;
  delete result.__v;

  return result;
}

// Admin serializers must explicitly select
// private fields and use
// toObject({ transform: false }).
supplierSchema.set("toJSON", {
  transform: hidePrivateFields,
});

supplierSchema.set("toObject", {
  transform: hidePrivateFields,
});

supplierSchema.index(
  { supplierCode: 1 },
  {
    unique: true,

    partialFilterExpression: {
      supplierCode: {
        $type: "string",
      },
    },
  }
);

supplierSchema.index({
  status: 1,
  name: 1,
});

module.exports =
  mongoose.models.Supplier ||
  mongoose.model("Supplier", supplierSchema);