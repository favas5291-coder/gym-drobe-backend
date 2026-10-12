const mongoose = require("mongoose");

const noId = { _id: false };

const money = (required = false, fallback = 0) => ({
  type: Number,
  min: 0,
  required,
  default: required ? undefined : fallback,
  validate: {
    validator: value =>
      value == null ||
      (
        Number.isFinite(value) &&
        Number.isSafeInteger(Math.round(value * 100))
      ),
    message: "Use a finite monetary amount within the supported range.",
  },
});

const date = () => ({
  type: Date,
  default: null,
});

const integer = (minimum, required = false, fallback) => ({
  type: Number,
  min: minimum,
  required,
  default: fallback,
  validate: {
    validator: Number.isSafeInteger,
    message: "Use a valid whole number.",
  },
});

const orderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: true,
  },
  legacyId: { type: Number, default: null },
  slug: { type: String, default: "" },
  sku: { type: String, default: "" },
  name: { type: String, required: true },
  brand: { type: String, default: "" },
  image: { type: String, default: "" },
  originalPrice: money(true),
  price: money(true),
  discount: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  quantity: integer(1, true),
  selectedSize: { type: String, default: null },
  selectedColor: { type: String, default: null },

  // Preserve the conditions applicable when this item was purchased.
  returnPolicy: { type: String, default: "" },
  returnsEligible: {
    type: String,
    enum: ["yes", "no", "unconfirmed"],
    default: "unconfirmed",
  },
  returnConditions: { type: String, default: "" },
  returnWindowDays: {
    ...integer(1, false, 7),
    max: 7,
  },
}, noId);

const shippingAddressSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  addressLine: { type: String, required: true },
  landmark: { type: String, default: "" },
  city: { type: String, required: true },
  state: { type: String, required: true },
  pincode: { type: String, required: true },
  label: { type: String, default: "Home" },
}, noId);

const pricingSchema = new mongoose.Schema({
  subtotal: money(true),
  couponDiscount: money(),
  totalAfterCoupon: money(true),
  shipping: money(true),
  finalTotal: money(true),
  currency: { type: String, default: "INR" },
}, noId);

const trackingEventSchema = new mongoose.Schema({
  status: { type: String, required: true },
  description: { type: String, default: "" },
  timestamp: { type: Date, default: Date.now },
}, noId);

const returnItemSchema = new mongoose.Schema({
  index: integer(0, true),
  quantity: integer(1, true),
  size: { type: String, default: null },
  color: { type: String, default: null },
}, noId);

const returnInspectionItemSchema = new mongoose.Schema({
  index: integer(0, true),
  returnedQuantity: integer(1, true),
  restockQuantity: integer(0, true),
  note: {
    type: String,
    default: "",
    maxlength: 500,
  },
}, noId);

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

const returnRequestSchema = new mongoose.Schema({
  id: { type: String, default: null },
  type: {
    type: String,
    default: null,
    validate: {
      validator: value =>
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
}, noId);

const refundSchema = new mongoose.Schema({
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

  // An uncertain submission must be reconciled before another refund.
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
}, noId);

const paymentSchema = new mongoose.Schema({
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
}, noId);

const orderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    required: true,
    unique: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
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
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
  },
  shippingAddress: {
    type: shippingAddressSchema,
    required: true,
  },
  items: {
    type: [orderItemSchema],
    required: true,
    validate: {
      validator: value =>
        Array.isArray(value) && value.length > 0,
      message: "Order must contain at least one item.",
    },
  },
  pricing: {
    type: pricingSchema,
    required: true,
  },
  coupon: {
    code: { type: String, default: null },
    type: { type: String, default: null },
    value: { type: Number, default: null },
    minimum: { type: Number, default: null },
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
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

orderSchema.index(
  { user: 1, checkoutToken: 1 },
  { unique: true },
);

orderSchema.index({ user: 1, createdAt: -1 });

orderSchema.index({
  "returnRequest.status": 1,
  "returnRequest.requestedAt": -1,
});

orderSchema.index(
  { "payment.razorpayOrderId": 1 },
  { sparse: true },
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