const {
  normalizeMeeshoLink,
} = require("../utils/meeshoUrl");

const mongoose = require("mongoose");

const {
  normalizeCourierUrl,
} = require("../utils/trackingUpdates");

const PurchasedShippingSchema = require("./PurchasedShippingSchema");

const {
  validatePurchasedShipping,
} = require("../utils/purchasedShipping");

const KitFulfillmentProgressSchema =
  require("./KitFulfillmentProgressSchema");

const {
  validateKitProgress,
} = require("../utils/kitFulfillmentProgress");

const {
  publicKitFulfillmentFields,
} = require("../utils/publicKitOrder");

const noId = { _id: false };

const money = (required = false, fallback = 0) => ({
  type: Number,
  min: 0,
  required,
  default: required ? undefined : fallback,

  validate: {
    validator: (value) =>
      value == null ||
      (
        Number.isFinite(value) &&
        Number.isSafeInteger(Math.round(value * 100))
      ),

    message:
      "Use a finite monetary amount within the supported range.",
  },
});

const date = () => ({
  type: Date,
  default: null,
});

const integer = (
  minimum,
  required = false,
  fallback,
) => ({
  type: Number,
  min: minimum,
  required,
  default: fallback,

  validate: {
    validator: Number.isSafeInteger,
    message: "Use a valid whole number.",
  },
});

const KIT_LEVELS = [
  "beginner",
  "intermediate",
  "advanced",
];

const KIT_ROLES = [
  "clothing",
  "footwear",
  "supplements",
  "training-accessories",
  "gym-bag",
  "bottle-or-shaker",
  "workout-essentials",
];

const groupId = () => ({
  type: String,
  required: true,
  match: /^[a-zA-Z0-9_-]{8,80}$/,
});

// Identifies the kit section belonging to an order item.
const itemKitSchema = new mongoose.Schema(
  {
    groupId: groupId(),

    slotKey: {
      type: String,
      required: true,
      match: /^[a-z][a-z0-9-]{0,59}$/,
    },

    role: {
      type: String,
      required: true,
      enum: KIT_ROLES,
    },
  },
  noId,
);

// Purchase amounts are recorded in integer paise.
// Any remainder is distributed deterministically across units.
const priceAllocationSchema = new mongoose.Schema(
  {
    quantity: integer(1, true),
    lineSubtotalPaise: integer(0, true),
    kitDiscountPaise: integer(0, true),
    couponDiscountPaise: integer(0, true),
    linePaidPaise: integer(0, true),
    unitBasePaise: integer(0, true),
    extraPaiseUnits: integer(0, true),
  },
  noId,
);

priceAllocationSchema.pre("validate", function () {
  const values = [
    this.quantity,
    this.lineSubtotalPaise,
    this.kitDiscountPaise,
    this.couponDiscountPaise,
    this.linePaidPaise,
    this.unitBasePaise,
    this.extraPaiseUnits,
  ];

  if (
    !values.every(Number.isSafeInteger) ||
    this.quantity < 1 ||
    values.slice(1).some((value) => value < 0)
  ) {
    return;
  }

  const distributed =
    this.unitBasePaise * this.quantity +
    this.extraPaiseUnits;

  if (
    this.kitDiscountPaise + this.couponDiscountPaise >
      this.lineSubtotalPaise ||
    this.lineSubtotalPaise -
      this.kitDiscountPaise -
      this.couponDiscountPaise !==
      this.linePaidPaise ||
    this.extraPaiseUnits >= this.quantity ||
    !Number.isSafeInteger(distributed) ||
    distributed !== this.linePaidPaise
  ) {
    this.invalidate(
      "linePaidPaise",
      "Component discounts and refundable amounts must reconcile exactly.",
    );
  }
});

// Purchased kit information is independent of future template edits.
const kitSnapshotSchema = new mongoose.Schema(
  {
    groupId: groupId(),

    template: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KitTemplate",
      required: true,
    },

    templateVersion: integer(0, true),

    kitCode: {
      type: String,
      default: "",
      maxlength: 100,
    },

    name: {
      type: String,
      required: true,
      minlength: 2,
      maxlength: 200,
    },

    level: {
      type: String,
      required: true,
      enum: KIT_LEVELS,
    },

    audience: {
      type: String,
      default: "",
      maxlength: 2000,
    },

    explanation: {
      type: String,
      default: "",
      maxlength: 4000,
    },

    supplementNote: {
      type: String,
      default: "",
      maxlength: 2000,
    },

    fulfillmentMode: {
      type: String,
      required: true,
      enum: [
        "packed-together",
        "separate-shipments",
      ],
    },

    customerNote: {
      type: String,
      default: "",
      maxlength: 2000,
    },

    subtotalPaise: integer(0, true),
    kitDiscountPaise: integer(0, true),
    couponDiscountPaise: integer(0, true),
    linePaidPaise: integer(0, true),
  },
  noId,
);

const sourcingSchema = new mongoose.Schema(
  {
    meeshoProductLink: {
      type: String,
      default: "",
      maxlength: 2000,
      set: normalizeMeeshoLink,
    },

    sizeLabel: {
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

    colorLabel: {
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
  noId,
);

const orderItemSchema = new mongoose.Schema(
  {
    sourcing: {
      type: sourcingSchema,
      default: null,
      select: false,
      immutable: true,
    },

    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    legacyId: {
      type: Number,
      default: null,
    },

    slug: {
      type: String,
      default: "",
    },

    sku: {
      type: String,
      default: "",
    },

    name: {
      type: String,
      required: true,
    },

    brand: {
      type: String,
      default: "",
    },

    image: {
      type: String,
      default: "",
    },

    originalPrice: money(true),
    price: money(true),

    discount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    quantity: integer(1, true),

    kit: {
      type: itemKitSchema,
      default: null,
      immutable: true,
    },

    priceAllocation: {
      type: priceAllocationSchema,
      default: null,
      immutable: true,
    },

    selectedSize: {
      type: String,
      default: null,
    },

    selectedColor: {
      type: String,
      default: null,
    },

    // Preserve the conditions applicable when this item was purchased.
    returnPolicy: {
      type: String,
      default: "",
    },

    returnsEligible: {
      type: String,
      enum: ["yes", "no", "unconfirmed"],
      default: "unconfirmed",
    },

    returnConditions: {
      type: String,
      default: "",
    },

    returnWindowDays: {
      ...integer(1, false, 7),
      max: 7,
    },
  },
  noId,
);

const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
    },

    name: {
      type: String,
      required: true,
    },

    email: {
      type: String,
      required: true,
    },

    phone: {
      type: String,
      required: true,
    },

    addressLine: {
      type: String,
      required: true,
    },

    landmark: {
      type: String,
      default: "",
    },

    city: {
      type: String,
      required: true,
    },

    state: {
      type: String,
      required: true,
    },

    pincode: {
      type: String,
      required: true,
    },

    label: {
      type: String,
      default: "Home",
    },
  },
  noId,
);

const pricingSchema = new mongoose.Schema(
  {
    subtotal: money(true),
    kitDiscount: money(),
    couponDiscount: money(),
    totalAfterCoupon: money(true),
    shipping: money(true),
    finalTotal: money(true),

    currency: {
      type: String,
      default: "INR",
    },
  },
  noId,
);

const trackingEventSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      required: true,
    },

    description: {
      type: String,
      default: "",
    },

    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  noId,
);

const returnItemSchema = new mongoose.Schema(
  {
    index: integer(0, true),
    quantity: integer(1, true),

    size: {
      type: String,
      default: null,
    },

    color: {
      type: String,
      default: null,
    },
  },
  noId,
);

const returnInspectionItemSchema = new mongoose.Schema(
  {
    index: integer(0, true),
    returnedQuantity: integer(1, true),
    restockQuantity: integer(0, true),

    note: {
      type: String,
      default: "",
      maxlength: 500,
    },
  },
  noId,
);

returnInspectionItemSchema.pre("validate", function () {
  if (this.restockQuantity > this.returnedQuantity) {
    this.invalidate(
      "restockQuantity",
      "Restock quantity cannot exceed received quantity.",
    );
  }

  const noteLength =
    typeof this.note === "string"
      ? this.note.trim().length
      : 0;

  if (
    this.restockQuantity < this.returnedQuantity &&
    noteLength < 3
  ) {
    this.invalidate(
      "note",
      "Explain why some received items are not being restocked.",
    );
  }
});

const returnRequestSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      default: null,
    },

    type: {
      type: String,
      default: null,

      validate: {
        validator: (value) =>
          value == null ||
          ["return", "exchange"].includes(value),

        message: "Invalid return request type.",
      },
    },

    status: {
      type: String,
      default: "not-requested",

      enum: [
        "not-requested",
        "requested",
        "approved",
        "rejected",
        "completed",
      ],
    },

    items: {
      type: [returnItemSchema],
      default: [],
    },

    reason: {
      type: String,
      default: "",
      maxlength: 1000,
    },

    response: {
      type: String,
      default: "",
      maxlength: 1000,
    },

    requestedAt: date(),
    respondedAt: date(),
    approvedAt: date(),
    rejectedAt: date(),
    completedAt: date(),

    originalInventoryRestoredAt: date(),
    exchangeInventoryReservedAt: date(),

    inspectionCompletedAt: date(),

    inspectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    inspectionItems: {
      type: [returnInspectionItemSchema],
      default: [],
    },
  },
  noId,
);

const refundSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      default: "not-requested",

      enum: [
        "not-requested",
        "pending",
        "manual-required",
        "refunded",
        "not-applicable",
      ],
    },

    amount: money(),

    reference: {
      type: String,
      default: "",
      maxlength: 200,
    },

    requestedAt: date(),
    refundedAt: date(),

    // Reconcile an uncertain submission before another refund.
    submissionState: {
      type: String,
      default: "not-started",

      enum: [
        "not-started",
        "submitting",
        "submitted",
        "uncertain",
        "manual",
      ],
    },

    submissionKey: {
      type: String,
      default: "",
      maxlength: 100,
    },

    submissionStartedAt: date(),
  },
  noId,
);

const paymentSchema = new mongoose.Schema(
  {
    method: {
      type: String,
      enum: ["cod", "razorpay", "cod-partial"],
      default: "cod",
    },

    gateway: {
      type: String,
      enum: ["cod", "razorpay"],
      default: "cod",
    },

    status: {
      type: String,
      default: "pending",

      enum: [
        "pending",
        "partially-paid",
        "paid",
        "failed",
        "refunded",
        "partially-refunded",
      ],
    },

    totalAmount: money(),

    // Money retained after completed refunds.
    amountPaid: money(),
    amountDue: money(),

    advancePercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    advanceAmount: money(),
    advancePaidAt: date(),

    balanceStatus: {
      type: String,
      default: "not-applicable",

      enum: [
        "not-applicable",
        "pending",
        "collected",
        "waived",
      ],
    },

    balanceCollectedAt: date(),

    grossCollected: money(false, null),
    refundedAmount: money(),

    amountsReconciled: {
      type: Boolean,
      default: false,
    },

    transactionId: {
      type: String,
      default: null,
      trim: true,
    },

    razorpayOrderId: {
      type: String,
      default: null,
      trim: true,
    },

    razorpayPaymentId: {
      type: String,
      default: null,
      trim: true,
    },

    verifiedAt: date(),
    paidAt: date(),
    failedAt: date(),
  },
  noId,
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",

      required: function () {
        return !this.guestSession;
      },

      default: null,
      index: true,
    },

    guestSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GuestCheckoutSession",
      default: null,
      immutable: true,
      index: true,
    },

    checkoutToken: {
      type: String,
      required: true,
      trim: true,
    },

    source: {
      type: String,
      enum: ["cart", "selection", "buy-now"],
      default: "cart",
    },

    status: {
      type: String,
      default: "confirmed",
      index: true,

      enum: [
        "payment-pending",
        "confirmed",
        "processing",
        "shipped",
        "out-for-delivery",
        "delivered",
        "cancelled",
      ],
    },

    giftMessage: {
      type: String,
      default: "",
      maxlength: 250,
    },

    orderNote: {
      type: String,
      default: "",
      maxlength: 300,
    },

    customer: {
      name: {
        type: String,
        required: true,
      },

      email: {
        type: String,
        required: true,
      },

      phone: {
        type: String,
        required: true,
      },
    },

    shippingAddress: {
      type: shippingAddressSchema,
      required: true,
    },

    items: {
      type: [orderItemSchema],
      required: true,

      validate: {
        validator: (value) =>
          Array.isArray(value) && value.length > 0,

        message: "Order must contain at least one item.",
      },
    },

    kitSnapshots: {
      type: [kitSnapshotSchema],
      default: [],
      immutable: true,

      validate: {
        validator: (value) =>
          Array.isArray(value) && value.length <= 20,

        message: "Use at most 20 kit groups per order.",
      },
    },

    shippingSnapshot: {
      type: PurchasedShippingSchema,
      default: null,
      immutable: true,
    },

    fulfillmentProgress: {
      type: KitFulfillmentProgressSchema,
      default: null,
    },

    pricing: {
      type: pricingSchema,
      required: true,
    },

    coupon: {
      code: {
        type: String,
        default: null,
      },

      type: {
        type: String,
        default: null,
      },

      value: {
        type: Number,
        default: null,
      },

      minimum: {
        type: Number,
        default: null,
      },
    },

    payment: {
      type: paymentSchema,
      default: () => ({}),
    },

    paymentMethod: {
      type: String,
      enum: ["cod", "razorpay", "cod-partial"],
      default: "cod",
    },

    delivery: {
      method: {
        type: String,
        enum: ["standard", "express"],
        default: "standard",
      },

      status: {
        type: String,
        default: "pending",
      },

      label: {
        type: String,
        default: "Standard delivery",
      },

      estimatedTime: {
        type: String,
        default: null,
      },

      deliveredAt: date(),
    },

    deliveryMethod: {
      type: String,
      enum: ["standard", "express"],
      default: "standard",
    },

    tracking: {
      packedAt: date(),

      courierUrl: {
        type: String,
        default: "",
        maxlength: 2000,

        validate: {
          validator(value) {
            try {
              return normalizeCourierUrl(value) === value;
            } catch {
              return false;
            }
          },

          message: "Use a valid HTTPS courier tracking link.",
        },
      },

      exception: {
        type: {
          type: String,

          enum: [
            "none",
            "delayed",
            "delivery-attempt-failed",
          ],

          default: "none",
        },

        message: {
          type: String,
          default: "",
          maxlength: 500,
        },

        updatedAt: date(),
      },

      carrier: {
        type: String,
        default: null,
        maxlength: 100,
      },

      trackingNumber: {
        type: String,
        default: null,
        maxlength: 150,
      },

      estimatedDelivery: date(),

      events: {
        type: [trackingEventSchema],
        default: [],
      },
    },

    cancellation: {
      status: {
        type: String,
        enum: ["not-cancelled", "cancelled"],
        default: "not-cancelled",
      },

      reason: {
        type: String,
        default: "",
        maxlength: 500,
      },

      cancelledAt: date(),
      inventoryRestoredAt: date(),
    },

    returnRequest: {
      type: returnRequestSchema,
      default: () => ({}),
    },

    refund: {
      type: refundSchema,
      default: () => ({}),
    },

    metadata: {
      version: {
        type: String,
        default: "7.0",
      },

      demo: {
        type: Boolean,
        default: true,
      },

      inventoryReserved: {
        type: Boolean,
        default: false,
      },
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  },
);

// Even explicitly selected sourcing data stays out of
// ordinary serialization, customer emails and receipts.
function hideSourcing(document, result) {
  delete result.guestSession;

  for (const item of result.items || []) {
    delete item.sourcing;
  }

  if (result.fulfillmentProgress) {
    result.fulfillmentProgress =
      publicKitFulfillmentFields(result);
  }

  return result;
}

orderSchema.set("toJSON", {
  transform: hideSourcing,
});

orderSchema.set("toObject", {
  transform: hideSourcing,
});

orderSchema.pre("validate", function () {
  if (this.user && this.guestSession) {
    this.invalidate(
      "user",
      "An order must have one owner.",
    );
  }

  if (!this.user && !this.guestSession) {
    this.invalidate(
      "user",
      "Order ownership is required.",
    );
  }
});

orderSchema.pre("validate", function () {
  if (!this.isNew && this.isModified("items")) {
    this.invalidate(
      "items",
      "Purchased items and internal sourcing snapshots cannot be replaced after order creation.",
    );
  }
});

for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
]) {
  orderSchema.pre(operation, function () {
    const update = this.getUpdate();

    if (
      ["replaceOne", "findOneAndReplace"].includes(this.op) ||
      Array.isArray(update)
    ) {
      throw new Error(
        "Order replacements cannot overwrite purchased sourcing snapshots.",
      );
    }

    for (const [operator, values] of Object.entries(update || {})) {
      const paths = operator.startsWith("$")
        ? Object.keys(values || {})
        : [operator];

      const purchasePath = (path) =>
        [
          "items",
          "kitSnapshots",
          "shippingSnapshot",
        ].some(
          (root) =>
            path === root ||
            String(path).startsWith(`${root}.`),
        );

      if (
        paths.some(purchasePath) ||
        (
          operator === "$rename" &&
          Object.values(values || {}).some(purchasePath)
        )
      ) {
        throw new Error(
          "Purchased items, kit details and shipping snapshots cannot be changed.",
        );
      }
    }
  });
}

orderSchema.pre("validate", function () {
  if (!this.isNew && this.isModified("shippingSnapshot")) {
    this.invalidate(
      "shippingSnapshot",
      "Purchased shipping terms cannot be changed.",
    );

    return;
  }

  try {
    validatePurchasedShipping(this);
  } catch (error) {
    this.invalidate(
      "shippingSnapshot",
      error.message,
    );
  }
});

orderSchema.pre("validate", function () {
  try {
    validateKitProgress(this);
  } catch (error) {
    this.invalidate(
      "fulfillmentProgress",
      error.message,
    );
  }
});

// Kit snapshots describe the purchase.
// Procurement and shipment progress are stored separately.
orderSchema.pre("validate", function () {
  const snapshotChanged =
    this.isModified("kitSnapshots") ||
    (this.items || []).some(
      (item, index) =>
        this.isModified(`items.${index}.kit`) ||
        this.isModified(`items.${index}.priceAllocation`),
    );

  if (!this.isNew && snapshotChanged) {
    this.invalidate(
      "kitSnapshots",
      "Purchased kit snapshots and discount allocations cannot be edited.",
    );

    return;
  }

  const kits = this.kitSnapshots || [];

  const hasKitItems = (this.items || []).some(
    (item) => item.kit,
  );

  const hasAllocations = (this.items || []).some(
    (item) => item.priceAllocation,
  );

  // Preserve compatibility with ordinary and older orders.
  if (
    !kits.length &&
    !hasKitItems &&
    !hasAllocations &&
    !this.pricing?.kitDiscount
  ) {
    return;
  }

  if (
    !Array.isArray(this.items) ||
    !this.items.length ||
    !this.pricing
  ) {
    this.invalidate(
      "items",
      "Load the complete order to validate kit purchase amounts.",
    );

    return;
  }

  const groups = new Map();

  for (const kit of kits) {
    if (groups.has(kit.groupId)) {
      this.invalidate(
        "kitSnapshots",
        "Each purchased kit must have a distinct group ID.",
      );

      return;
    }

    groups.set(kit.groupId, {
      kit,
      slots: new Set(),
      sums: [0, 0, 0, 0],
      count: 0,
    });
  }

  const totals = [0, 0, 0, 0];

  for (
    let index = 0;
    index < this.items.length;
    index += 1
  ) {
    const item = this.items[index];
    const allocation = item.priceAllocation;

    if (!allocation) {
      this.invalidate(
        `items.${index}.priceAllocation`,
        "Every item in a kit order needs its server-calculated discount allocation.",
      );

      continue;
    }

    const sums = [
      allocation.lineSubtotalPaise,
      allocation.kitDiscountPaise,
      allocation.couponDiscountPaise,
      allocation.linePaidPaise,
    ];

    if (
      !sums.every(
        (value) =>
          Number.isSafeInteger(value) &&
          value >= 0,
      )
    ) {
      continue;
    }

    if (
      allocation.quantity !== item.quantity ||
      allocation.lineSubtotalPaise !==
        Math.round(item.price * 100) * item.quantity
    ) {
      this.invalidate(
        `items.${index}.priceAllocation`,
        "The component allocation must match its purchased quantity and unit price.",
      );
    }

    sums.forEach((value, column) => {
      totals[column] += value;
    });

    if (item.kit) {
      const group = groups.get(item.kit.groupId);

      if (
        !group ||
        group.slots.has(item.kit.slotKey)
      ) {
        this.invalidate(
          `items.${index}.kit`,
          "Kit components need a matching snapshot and distinct section keys.",
        );

        continue;
      }

      group.slots.add(item.kit.slotKey);
      group.count += 1;

      sums.forEach((value, column) => {
        group.sums[column] += value;
      });
    } else if (allocation.kitDiscountPaise !== 0) {
      this.invalidate(
        `items.${index}.priceAllocation`,
        "An individual product cannot receive a kit discount.",
      );
    }
  }

  for (const { kit, sums, count } of groups.values()) {
    const recorded = [
      kit.subtotalPaise,
      kit.kitDiscountPaise,
      kit.couponDiscountPaise,
      kit.linePaidPaise,
    ];

    if (
      !count ||
      !sums.every(
        (value, index) =>
          Number.isSafeInteger(value) &&
          value === recorded[index],
      )
    ) {
      this.invalidate(
        "kitSnapshots",
        "Each kit snapshot must reconcile with its purchased components.",
      );
    }
  }

  const recorded = [
    this.pricing.subtotal,
    this.pricing.kitDiscount || 0,
    this.pricing.couponDiscount,
    this.pricing.totalAfterCoupon,
  ].map((value) => Math.round(value * 100));

  if (
    !totals.every(
      (value, index) =>
        Number.isSafeInteger(value) &&
        value === recorded[index],
    ) ||
    totals[0] - totals[1] - totals[2] !== totals[3] ||
    totals[3] +
      Math.round(this.pricing.shipping * 100) !==
      Math.round(this.pricing.finalTotal * 100)
  ) {
    this.invalidate(
      "pricing",
      "Kit discounts, coupons, shipping and order totals must reconcile exactly.",
    );
  }
});

orderSchema.index(
  {
    user: 1,
    checkoutToken: 1,
  },
  {
    unique: true,
  },
);

orderSchema.index({
  user: 1,
  createdAt: -1,
});

orderSchema.index({
  "returnRequest.status": 1,
  "returnRequest.requestedAt": -1,
});

orderSchema.index(
  {
    "payment.razorpayOrderId": 1,
  },
  {
    sparse: true,
  },
);

orderSchema.index({
  "payment.status": 1,
  createdAt: -1,
});

orderSchema.index({
  "payment.method": 1,
  "payment.balanceStatus": 1,
  createdAt: -1,
});

module.exports =
  mongoose.models.Order ||
  mongoose.model("Order", orderSchema);