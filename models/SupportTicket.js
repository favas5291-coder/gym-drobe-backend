const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  requestId: {
    type: String,
    required: true,
    maxlength: 80,
  },
  by: {
    type: String,
    enum: ["customer", "store"],
    required: true,
  },
  text: {
    type: String,
    required: true,
    minlength: 2,
    maxlength: 2000,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const schema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requestId: {
      type: String,
      required: true,
      maxlength: 80,
    },
    subject: {
      type: String,
      required: true,
      maxlength: 120,
    },
    category: {
      type: String,
      enum: [
        "General",
        "Product question",
        "Order issue",
        "Delivery",
        "Return or exchange",
        "Payment question",
      ],
      default: "General",
    },
    email: {
      type: String,
      required: true,
      maxlength: 254,
    },
    orderId: {
      type: String,
      default: "",
      maxlength: 120,
    },
    productId: {
      type: String,
      default: "",
      maxlength: 120,
    },
    status: {
      type: String,
      enum: ["open", "waiting", "resolved"],
      default: "open",
    },
    messages: {
      type: [messageSchema],
      default: [],
    },
  },
  { timestamps: true },
);

schema.index(
  { user: 1, requestId: 1 },
  { unique: true },
);

schema.index({
  status: 1,
  updatedAt: -1,
});

module.exports = mongoose.model(
  "SupportTicket",
  schema,
);