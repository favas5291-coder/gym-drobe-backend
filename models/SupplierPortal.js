"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

const reference = (ref, required = false) => ({
  type: Schema.Types.ObjectId,
  ref,
  required,
});

const shortText = (max, required = false) => ({
  type: String,
  trim: true,
  maxlength: max,
  required,
});

// Membership and commercial onboarding extend the existing Supplier record.
// Existing suppliers are never automatically enrolled, approved or assigned terms.
const workspaceSchema = new Schema(
  {
    supplier: {
      ...reference("Supplier", true),
      immutable: true,
    },

    ownerUser: reference("User"),

    status: {
      type: String,
      enum: [
        "pending-verification",
        "approved",
        "rejected",
        "suspended",
        "inactive",
      ],
      default: "pending-verification",
    },

    profile: {
      legalName: shortText(200),
      contactName: shortText(100),

      phone: {
        ...shortText(15),
        match: /^\d{7,15}$/,
      },

      gstin: {
        ...shortText(15),
        uppercase: true,
      },

      dispatchAddress: {
        addressLine: shortText(300),
        city: shortText(100),
        state: shortText(100),

        pincode: {
          ...shortText(6),
          match: /^[1-9]\d{5}$/,
        },

        country: {
          type: String,
          enum: ["IN"],
          default: "IN",
        },
      },
    },

    submittedAt: Date,
    approvedAt: Date,
    approvedBy: reference("User"),
    statusReason: shortText(1000),

    offeredAgreement: reference("SupplierAgreement"),
    acceptedAgreement: reference("SupplierAgreement"),

    agreementVersion: {
      type: Number,
      default: 0,
      min: 0,
    },

    trial: {
      startAt: Date,
      endAt: Date,
    },

    invitation: {
      type: new Schema(
        {
          tokenHash: {
            type: String,
            match: /^[a-f0-9]{64}$/,
          },

          email: {
            ...shortText(150),
            lowercase: true,
          },

          expiresAt: Date,
        },
        { _id: false }
      ),

      select: false,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    strict: "throw",
  }
);

workspaceSchema.index(
  { supplier: 1 },
  { unique: true }
);

workspaceSchema.index(
  { ownerUser: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerUser: { $type: "objectId" },
    },
  }
);

workspaceSchema.index({
  status: 1,
  updatedAt: -1,
  _id: -1,
});

workspaceSchema.index({
  "trial.endAt": 1,
  status: 1,
});

workspaceSchema.index(
  { "invitation.tokenHash": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "invitation.tokenHash": { $type: "string" },
    },
  }
);

const termsSchema = new Schema(
  {
    supplierLegalName: shortText(200, true),
    title: shortText(150, true),
    text: shortText(20000, true),

    commissionBps: {
      type: Number,
      required: true,
      min: 0,
      max: 10000,
      validate: Number.isSafeInteger,
    },

    commissionBase: {
      type: String,
      required: true,
      enum: [
        "net-product-sales-excluding-tax-shipping",
      ],
    },

    trialDays: {
      type: Number,
      enum: [90],
      required: true,
    },

    joiningFeePaise: {
      type: Number,
      enum: [0],
      required: true,
    },

    monthlyFeePaise: {
      type: Number,
      enum: [0],
      required: true,
    },

    shippingResponsibility: {
      type: String,
      enum: ["supplier", "gymdrobe"],
      required: true,
    },

    gatewayFeeResponsibility: {
      type: String,
      enum: ["supplier", "gymdrobe"],
      required: true,
    },

    returnResponsibility: shortText(2000, true),

    effectiveFrom: {
      type: Date,
      required: true,
    },

    offerExpiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    _id: false,
    strict: "throw",
  }
);

const agreementSchema = new Schema(
  {
    workspace: {
      ...reference("SupplierWorkspace", true),
      immutable: true,
    },

    version: {
      type: Number,
      required: true,
      immutable: true,
      min: 1,
    },

    terms: {
      type: termsSchema,
      required: true,
      immutable: true,
    },

    digest: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },

    offeredBy: {
      ...reference("User", true),
      immutable: true,
    },

    status: {
      type: String,
      enum: ["offered", "withdrawn", "accepted"],
      default: "offered",
    },

    acceptance: {
      user: reference("User"),
      signerName: shortText(100),
      acceptedAt: Date,

      digest: {
        type: String,
        match: /^[a-f0-9]{64}$/,
      },

      authorityConfirmed: Boolean,

      method: {
        type: String,
        enum: [
          "authenticated-explicit-acceptance-v1",
        ],
      },
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    strict: "throw",
  }
);

agreementSchema.index(
  {
    workspace: 1,
    version: 1,
  },
  { unique: true }
);

const eventSchema = new Schema(
  {
    workspace: {
      ...reference("SupplierWorkspace", true),
      immutable: true,
    },

    actor: {
      ...reference("User", true),
      immutable: true,
    },

    action: {
      ...shortText(60, true),
      immutable: true,
    },

    revision: {
      type: Number,
      required: true,
      immutable: true,
    },

    detail: {
      ...shortText(1000),
      immutable: true,
    },
  },
  {
    timestamps: {
      createdAt: true,
      updatedAt: false,
    },
    strict: "throw",
  }
);

eventSchema.index(
  {
    workspace: 1,
    revision: 1,
  },
  { unique: true }
);

const quotaSchema = new Schema(
  {
    _id: String,

    count: {
      type: Number,
      default: 0,
    },

    expiresAt: Date,
  },
  { versionKey: false }
);

quotaSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

function privateWorkspace(doc, value) {
  delete value.invitation;
  return value;
}

workspaceSchema.set("toJSON", {
  transform: privateWorkspace,
});

workspaceSchema.set("toObject", {
  transform: privateWorkspace,
});

const model = (name, schema) =>
  mongoose.models[name] ||
  mongoose.model(name, schema);

module.exports = {
  Workspace: model(
    "SupplierWorkspace",
    workspaceSchema
  ),

  Agreement: model(
    "SupplierAgreement",
    agreementSchema
  ),

  Event: model(
    "SupplierPortalEvent",
    eventSchema
  ),

  Quota: model(
    "SupplierPortalQuota",
    quotaSchema
  ),
};