const mongoose = require("mongoose");

const {
  KIT_LEVELS,
  KIT_ROLES,
  LEVEL_DETAILS,
  SUPPLEMENT_NOTE,
  money,
  kitDraft,
  reference,
  kitStructureIssues,
} = require("../utils/kitDefinitions");

const {
  kitPublicationIssues,
} = require("../utils/kitPublication");

const noId = { _id: false };

function integer(
  minimum,
  maximum,
  fallback,
) {
  return {
    type: Number,
    min: minimum,
    max: maximum,
    default: fallback,

    validate: {
      validator: Number.isSafeInteger,
      message:
        "Enter a whole-number quantity within the permitted limits.",
    },
  };
}

function amount(fallback = 0) {
  return {
    type: Number,
    default: fallback,
    min: 0,
    max: 100000000,

    validate: {
      validator: money,
      message:
        "Use an INR amount with no more than two decimal places.",
    },
  };
}

const slotSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },

    role: {
      type: String,
      enum: KIT_ROLES,
      required: true,
    },

    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    whySelected: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },

    optional: {
      type: Boolean,
      default: false,
    },

    suggestedEssential: {
      type: Boolean,
      default: false,
    },

    defaultIncluded: {
      type: Boolean,
      default: true,
    },

    defaultProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },

    defaultSize: {
      type: String,
      default: null,
      maxlength: 50,
    },

    defaultColor: {
      type: String,
      default: null,
      maxlength: 80,
    },

    defaultQuantity: integer(1, 99, 1),
    maximumQuantity: integer(1, 99, 5),

    allowedProducts: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
        },
      ],
      default: [],
    },
  },
  noId,
);

const discountSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "none",
        "percentage",
        "fixed",
      ],
      default: "none",
    },

    value: amount(),
    minimumSubtotal: amount(),
    minimumCategories: integer(1, 7, 1),

    requiredRoles: {
      type: [
        {
          type: String,
          enum: KIT_ROLES,
        },
      ],
      default: [],
    },

    allowCouponStacking: {
      type: Boolean,
      default: false,
    },
  },
  noId,
);

discountSchema.pre(
  "validate",
  function () {
    if (
      new Set(this.requiredRoles).size !==
      this.requiredRoles.length
    ) {
      this.invalidate(
        "requiredRoles",
        "List each required discount category once.",
      );
    }

    if (
      (
        this.type === "none" &&
        this.value !== 0
      ) ||
      (
        this.type !== "none" &&
        this.value <= 0
      ) ||
      (
        this.type === "percentage" &&
        this.value > 100
      )
    ) {
      this.invalidate(
        "value",
        "Use zero for no discount, a positive fixed amount, or a percentage from above zero to 100.",
      );
    }
  },
);

const fulfillmentSchema =
  new mongoose.Schema(
    {
      mode: {
        type: String,
        enum: [
          "unconfigured",
          "packed-together",
          "separate-shipments",
        ],
        default: "unconfigured",
      },

      packingLocation: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "PackingLocation",
        default: null,
      },

      customerNote: {
        type: String,
        default: "",
        trim: true,
        maxlength: 2000,
      },
    },
    noId,
  );

const schema = new mongoose.Schema(
  {
    kitCode: {
      type: String,
      trim: true,
      uppercase: true,
      immutable: true,
      maxlength: 100,
    },

    level: {
      type: String,
      enum: KIT_LEVELS,
      required: true,
      unique: true,
      immutable: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 200,

      default: function () {
        return (
          LEVEL_DETAILS[this.level]?.name ||
          "Fitness Kit"
        );
      },
    },

    audience: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },

    explanation: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },

    status: {
      type: String,
      enum: [
        "draft",
        "published",
        "archived",
      ],
      default: "draft",
      index: true,
    },

    slots: {
      type: [slotSchema],
      default: [],
    },

    discount: {
      type: discountSchema,
      default: () => ({}),
    },

    fulfillment: {
      type: fulfillmentSchema,
      default: () => ({}),
      select: false,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      select: false,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
    minimize: false,
    optimisticConcurrency: true,
  },
);

schema.pre(
  "validate",
  async function () {
    if (
      !this.kitCode &&
      (
        this.isNew ||
        this.isSelected("kitCode")
      )
    ) {
      this.set(
        "kitCode",
        `KIT-${String(this._id).toUpperCase()}`,
        { overwriteImmutable: true },
      );
    }

    const structural =
      kitStructureIssues(this);

    if (structural.length) {
      this.invalidate(
        "slots",
        structural.join(" "),
      );
      return;
    }

    if (this.status !== "published") {
      return;
    }

    if (
      !this.isSelected("fulfillment")
    ) {
      this.invalidate(
        "status",
        "Load the complete kit record before saving a published template.",
      );
      return;
    }

    const Product = require("./Product");
    const Supplier = require("./Supplier");
    const PackingLocation =
      require("./PackingLocation");

    const session = this.$session();

    const ids = [
      ...new Set(
        this.slots
          .filter(
            (row) =>
              row.defaultIncluded &&
              row.defaultProduct,
          )
          .map((row) =>
            reference(row.defaultProduct),
          ),
      ),
    ];

    async function read(query) {
      if (session) {
        query.session(session);
      }

      return query.lean();
    }

    const products = await read(
      Product.find({
        _id: { $in: ids },
      }).select(
        "+supplier +fulfillment",
      ),
    );

    const supplierIds = [
      ...new Set(
        products
          .map((row) =>
            reference(row.supplier),
          )
          .filter(Boolean),
      ),
    ];

    const suppliers = supplierIds.length
      ? await read(
          Supplier.find({
            _id: { $in: supplierIds },
          }).select(
            "+contact +verification +fulfillment",
          ),
        )
      : [];

    const location =
      this.fulfillment.packingLocation
        ? await read(
            PackingLocation.findById(
              this.fulfillment.packingLocation,
            ).select(
              "+address +contact +verification +packing +delivery +acceptsGymDrobeStock +supplierArrangements",
            ),
          )
        : null;

    const issues = kitPublicationIssues(
      this,
      products,
      suppliers,
      location,
    );

    if (issues.length) {
      this.invalidate(
        "status",
        issues.join(" "),
      );
    }
  },
);

function publicTemplate(
  document,
  result,
) {
  result.version = result.__v ?? 0;
  result.supplementNote = SUPPLEMENT_NOTE;
  result.allowSkipCategories = true;

  if (result.fulfillment) {
    delete result.fulfillment.packingLocation;
  }

  delete result.createdBy;
  delete result.updatedBy;
  delete result.__v;

  return result;
}

for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
]) {
  schema.pre(operation, function () {
    throw new Error(
      "Load the complete kit document and use save() so publication and version checks run.",
    );
  });
}

schema.set("toJSON", {
  transform: publicTemplate,
});

schema.set("toObject", {
  transform: publicTemplate,
});

schema.statics.makeDraft = function (level) {
  return new this(kitDraft(level));
};

schema.index(
  { kitCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      kitCode: { $type: "string" },
    },
  },
);

module.exports =
  mongoose.models.KitTemplate ||
  mongoose.model("KitTemplate", schema);