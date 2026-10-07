const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Order = require("../models/Order");

const {
  getRazorpayClient,
} = require("../config/razorpay");

const {
  roundMoney,
} = require("../utils/orderPricing");

const {
  finalizeCapturedPayment,
} = require("./paymentController");

async function reconcileRefund(refund) {
  if (!refund?.id || !refund.payment_id) {
    return;
  }

  const payment = await getRazorpayClient()
    .payments.fetch(refund.payment_id);

  if (
    payment.id !== refund.payment_id ||
    payment.currency !== "INR"
  ) {
    throw new Error("Unexpected refund payment");
  }

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({
        $or: [
          {
            "payment.razorpayPaymentId": refund.payment_id,
          },
          {
            "payment.transactionId": refund.payment_id,
          },
        ],
      }).session(session);

      if (!order) return;

      if (
        payment.order_id !== order.payment.razorpayOrderId
      ) {
        throw new Error("Refund order mismatch");
      }

      const amount = Number(payment.amount) / 100;

      const refunded =
        Number(payment.amount_refunded || 0) / 100;

      if (
        !Number.isFinite(amount) ||
        !Number.isFinite(refunded) ||
        amount <= 0 ||
        refunded < 0 ||
        refunded > amount
      ) {
        throw new Error("Invalid refund amounts");
      }

      const reference = order.refund.reference || "";
      const requested = Number(order.refund.amount || 0);

      const matching =
        reference === refund.id ||
        !reference ||
        reference.startsWith("gd-auto-");

      if (
        ["pending", "manual-required"].includes(
          order.refund.status
        ) &&
        matching &&
        requested > 0 &&
        Number(refund.amount) / 100 + 0.01 >= requested
      ) {
        order.refund.status = "refunded";
        order.refund.reference = refund.id;

        order.refund.refundedAt =
          order.refund.refundedAt || new Date();
      }

      const cashCollected =
        order.payment.method === "cod-partial" &&
        order.payment.balanceStatus === "collected";

      const remainingPaid = roundMoney(
        Math.max(
          0,
          (
            cashCollected
              ? order.pricing.finalTotal
              : amount
          ) - refunded
        )
      );

      // An older event must not increase an already-reduced balance.
      order.payment.amountPaid = Math.min(
        Number(order.payment.amountPaid || 0),
        remainingPaid
      );

      if (refunded >= amount) {
        order.payment.status =
          order.payment.amountPaid > 0
            ? "partially-paid"
            : "refunded";
      }

      if (order.status === "cancelled") {
        order.payment.amountDue = 0;

        if (!cashCollected) {
          order.payment.balanceStatus = "not-applicable";
        }
      }

      await order.save({ session });
    });
  } finally {
    await session.endSession();
  }
}

async function handleCaptured(entity) {
  if (!entity?.id || !entity.order_id) {
    return;
  }

  const order = await Order.findOne({
    "payment.razorpayOrderId": entity.order_id,
  });

  if (!order) return;

  const payment = await getRazorpayClient()
    .payments.fetch(entity.id);

  if (
    payment.status === "refunded" ||
    Number(payment.amount_refunded || 0) > 0
  ) {
    return;
  }

  if (payment.status !== "captured") {
    throw new Error("Payment capture is not confirmed");
  }

  await finalizeCapturedPayment(order._id, payment);
}

async function handleFailed(payment) {
  if (!payment?.order_id) {
    return;
  }

  // Update only an unpaid order.
  // A delayed failure event cannot overwrite a successful payment.
  await Order.updateOne(
    {
      "payment.razorpayOrderId": payment.order_id,
      status: "payment-pending",

      "payment.status": {
        $in: ["pending", "failed"],
      },

      "payment.verifiedAt": null,
      "metadata.inventoryReserved": false,
    },
    {
      $set: {
        "payment.status": "failed",
        "payment.failedAt": new Date(),
      },
    }
  );
}

async function razorpayWebhook(req, res) {
  const secret = String(
    process.env.RAZORPAY_WEBHOOK_SECRET || ""
  ).trim();

  if (!secret) {
    return res.status(503).json({
      success: false,
      message: "Webhook is unavailable.",
    });
  }

  if (!Buffer.isBuffer(req.body)) {
    return res.status(500).json({
      success: false,
      message: "Webhook requires the raw request body.",
    });
  }

  const signature = String(
    req.headers["x-razorpay-signature"] || ""
  );

  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(400).json({
      success: false,
      message: "Invalid webhook signature.",
    });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.body)
    .digest();

  if (
    !crypto.timingSafeEqual(
      expected,
      Buffer.from(signature, "hex")
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid webhook signature.",
    });
  }

  let body;

  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({
      success: false,
      message: "Invalid webhook payload.",
    });
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid webhook payload.",
    });
  }

  const event = String(body.event || "");

  try {
    if (
      event === "order.paid" ||
      event === "payment.captured"
    ) {
      await handleCaptured(body.payload?.payment?.entity);
    } else if (event === "payment.failed") {
      await handleFailed(body.payload?.payment?.entity);
    } else if (event === "refund.processed") {
      await reconcileRefund(body.payload?.refund?.entity);
    }

    return res.json({
      success: true,
      event,
    });
  } catch (error) {
    console.error(
      "Razorpay webhook processing failed:",
      error.code || error.name || "Error"
    );

    return res.status(503).json({
      success: false,
      message: "Webhook processing interrupted. Please retry.",
    });
  }
}

module.exports = {
  razorpayWebhook,
};