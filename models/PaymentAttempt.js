const mongoose = require("mongoose");

// One provider-order creation attempt per GymDrobe order.
// Keep uncertain attempts so retries can recover the existing provider order.
const paymentAttemptSchema = new mongoose.Schema(
  {
    _id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    receipt: {
      type: String,
      required: true,
      maxlength: 40,
    },

    keyId: {
      type: String,
      required: true,
      maxlength: 100,
    },

    amount: {
      type: Number,
      required: true,
      min: 100,
      validate: {
        validator: Number.isSafeInteger,
        message: "Invalid payment amount.",
      },
    },

    currency: {
      type: String,
      enum: ["INR"],
      default: "INR",
    },

    state: {
      type: String,
      enum: ["creating", "ready", "uncertain"],
      default: "creating",
    },

    razorpayOrderId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  },
);

module.exports =
  mongoose.models.PaymentAttempt ||
  mongoose.model("PaymentAttempt", paymentAttemptSchema);