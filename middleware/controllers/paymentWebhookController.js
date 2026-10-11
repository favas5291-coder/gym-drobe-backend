const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Order = require("../../models/Order");

const {
  getRazorpayClient,
} = require("../../config/razorpay");

const {
  finalizeCapturedPayment,
} = require("./paymentController");

function problem(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function providerId(value, prefix) {
  return (
    typeof value === "string" &&
    value.length <= 100 &&
    new RegExp(
      `^${prefix}_[A-Za-z0-9]+$`,
    ).test(value)
  );
}

function paise(value, allowZero = true) {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw problem(
      "INVALID_GATEWAY_AMOUNT",
    );
  }

  return value;
}

function cents(value) {
  if (
    !["number", "string"].includes(
      typeof value,
    ) ||
    !String(value).trim()
  ) {
    throw problem(
      "INVALID_ORDER_AMOUNT",
    );
  }

  const number = Number(value);
  const result = Math.round(number * 100);

  if (
    !Number.isFinite(number) ||
    number < 0 ||
    !Number.isSafeInteger(result) ||
    Math.abs(number * 100 - result) > 0.000001
  ) {
    throw problem(
      "INVALID_ORDER_AMOUNT",
    );
  }

  return result;
}

async function gatewayRead(read) {
  let timer;

  try {
    return await Promise.race([
      Promise.resolve().then(read),

      new Promise((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              problem(
                "GATEWAY_READ_TIMEOUT",
              ),
            ),
          4000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function transaction(work) {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(
      () => work(session),
    );
  } finally {
    await session.endSession();
  }
}

function checkPayment(order, payment) {
  const saved = order.payment;

  const method =
    saved?.method || order.paymentMethod;

  if (
    !saved ||
    !["razorpay", "cod-partial"].includes(method) ||
    (
      order.paymentMethod &&
      order.paymentMethod !== method
    ) ||
    !providerId(payment?.id, "pay") ||
    !providerId(payment?.order_id, "order") ||
    payment.order_id !== saved.razorpayOrderId ||
    payment.currency !== "INR" ||
    (order.pricing?.currency || "INR") !== "INR" ||
    (
      saved.razorpayPaymentId &&
      saved.razorpayPaymentId !== payment.id
    ) ||
    (
      saved.transactionId &&
      saved.transactionId !== payment.id
    )
  ) {
    throw problem(
      "PAYMENT_ORDER_MISMATCH",
    );
  }

  const total = cents(
    order.pricing?.finalTotal,
  );

  const expected =
    method === "cod-partial"
      ? cents(saved.advanceAmount)
      : total;

  const captured = paise(
    payment.amount,
    false,
  );

  const refunded = paise(
    payment.amount_refunded ?? 0,
  );

  if (
    total <= 0 ||
    cents(saved.totalAmount) !== total ||
    expected <= 0 ||
    expected > total ||
    captured !== expected ||
    refunded > captured
  ) {
    throw problem(
      "PAYMENT_AMOUNT_MISMATCH",
    );
  }

  return {
    method,
    total,
    captured,
    refunded,
  };
}

function audit(order, status, description) {
  order.tracking = order.tracking || {};
  order.tracking.events =
    order.tracking.events || [];

  const exists = order.tracking.events.some(
    (event) =>
      event.status === status &&
      event.description === description,
  );

  if (!exists) {
    order.tracking.events.push({
      status,
      description,
      timestamp: new Date(),
    });
  }
}

function refundLedger(order, facts) {
  const payment = order.payment;

  const cashCollected =
    facts.method === "cod-partial" &&
    (
      payment.balanceStatus === "collected" ||
      Boolean(payment.balanceCollectedAt)
    );

  const gross = cashCollected
    ? facts.total
    : facts.captured;

  const paid = cents(payment.amountPaid);

  const completed =
    order.refund.status === "refunded"
      ? cents(order.refund.amount)
      : 0;

  if (
    !payment.verifiedAt ||
    (
      payment.razorpayPaymentId ||
      payment.transactionId
    ) == null
  ) {
    throw problem(
      "REFUND_BEFORE_PAYMENT_VERIFICATION",
    );
  }

  if (payment.amountsReconciled === true) {
    const refunded = cents(
      payment.refundedAmount,
    );

    if (
      cents(payment.grossCollected) !== gross ||
      paid + refunded !== gross ||
      completed > refunded
    ) {
      throw problem(
        "PAYMENT_LEDGER_MISMATCH",
      );
    }

    return {
      gross,
      refunded,
      cashCollected,
    };
  }

  // Older orders may have stored gross or net amountPaid after a refund.
  if (
    completed > gross ||
    (
      completed > 0 &&
      paid !== gross &&
      paid !== gross - completed
    ) ||
    (
      completed === 0 &&
      paid !== gross
    )
  ) {
    throw problem(
      "LEGACY_PAYMENT_REQUIRES_REVIEW",
    );
  }

  return {
    gross,
    refunded: completed,
    cashCollected,
  };
}

async function reconcileRefund(
  entity,
  event,
) {
  if (
    !providerId(entity?.id, "rfnd") ||
    !providerId(entity?.payment_id, "pay")
  ) {
    throw problem(
      "INVALID_REFUND_ENTITY",
    );
  }

  const client = getRazorpayClient();

  const [refund, payment] =
    await gatewayRead(
      () =>
        Promise.all([
          client.refunds.fetch(entity.id),
          client.payments.fetch(
            entity.payment_id,
          ),
        ]),
    );

  if (
    refund?.id !== entity.id ||
    refund.payment_id !== entity.payment_id ||
    payment?.id !== entity.payment_id ||
    refund.currency !== "INR" ||
    ![
      "pending",
      "processed",
      "failed",
    ].includes(refund.status) ||
    !["captured", "refunded"].includes(
      payment.status,
    )
  ) {
    throw problem(
      "REFUND_PROVIDER_MISMATCH",
    );
  }

  const amount = paise(
    refund.amount,
    false,
  );

  if (
    (
      event === "refund.processed" &&
      refund.status !== "processed"
    ) ||
    (
      event === "refund.failed" &&
      refund.status === "pending"
    )
  ) {
    throw problem(
      "REFUND_STATUS_NOT_CONFIRMED",
    );
  }

  await transaction(async (session) => {
    const order = await Order.findOne({
      $or: [
        {
          "payment.razorpayPaymentId":
            refund.payment_id,
        },
        {
          "payment.transactionId":
            refund.payment_id,
        },
        {
          "payment.razorpayOrderId":
            payment.order_id,
        },
      ],
    }).session(session);

    if (!order) {
      return;
    }

    const facts = checkPayment(
      order,
      payment,
    );

    const request = order.refund;

    if (
      !request ||
      ![
        "pending",
        "manual-required",
        "refunded",
      ].includes(request.status) ||
      cents(request.amount) !== amount ||
      amount > facts.captured
    ) {
      throw problem(
        "REFUND_REQUEST_REQUIRES_REVIEW",
      );
    }

    const reference =
      request.reference || "";

    const temporaryReference =
      reference.startsWith("gd-auto-");

    if (
      reference &&
      !temporaryReference &&
      reference !== refund.id
    ) {
      throw problem(
        "REFUND_REFERENCE_MISMATCH",
      );
    }

    const noteOrder =
      refund.notes?.gymdrobe_order;

    if (
      (
        noteOrder != null &&
        String(noteOrder) !==
          String(order.orderNumber)
      ) ||
      (
        !reference &&
        request.submissionKey &&
        String(noteOrder || "") !==
          String(order.orderNumber)
      )
    ) {
      throw problem(
        "REFUND_SUBMISSION_MISMATCH",
      );
    }

    const previous = refundLedger(
      order,
      facts,
    );

    // The current order model contains one refund request.
    // Additional provider refunds require explicit reconciliation.
    if (
      facts.refunded > amount ||
      (
        refund.status === "processed" &&
        facts.refunded !== amount
      ) ||
      previous.refunded > amount ||
      (
        previous.refunded > 0 &&
        request.status !== "refunded"
      )
    ) {
      throw problem(
        "MULTIPLE_REFUNDS_REQUIRE_REVIEW",
      );
    }

    if (
      request.status === "refunded" &&
      refund.status !== "processed"
    ) {
      return;
    }

    request.reference = refund.id;

    request.requestedAt =
      request.requestedAt || new Date();

    if (refund.status === "processed") {
      order.payment.grossCollected =
        previous.gross / 100;

      order.payment.refundedAmount =
        amount / 100;

      order.payment.amountPaid =
        (previous.gross - amount) / 100;

      order.payment.amountsReconciled =
        true;

      order.payment.status =
        amount === previous.gross
          ? "refunded"
          : "partially-refunded";

      request.status = "refunded";
      request.submissionState = "submitted";

      request.refundedAt =
        request.refundedAt || new Date();

      audit(
        order,
        "refund-completed",
        `Razorpay refund ${refund.id} is processed.`,
      );
    } else if (refund.status === "failed") {
      request.status = "manual-required";
      request.submissionState = "uncertain";

      audit(
        order,
        "refund-manual-required",
        `Razorpay refund ${refund.id} failed. Review it before sending another refund.`,
      );
    } else {
      if (
        request.status !== "manual-required"
      ) {
        request.status = "pending";
      }

      if (
        request.submissionState !== "uncertain"
      ) {
        request.submissionState = "submitted";
      }

      audit(
        order,
        "refund-requested",
        `Razorpay refund ${refund.id} is pending.`,
      );
    }

    if (order.status === "cancelled") {
      order.payment.amountDue = 0;

      if (!previous.cashCollected) {
        order.payment.balanceStatus =
          "not-applicable";
      }
    }

    await order.save({ session });
  });
}

async function handleCaptured(entity) {
  if (
    !providerId(entity?.id, "pay") ||
    !providerId(entity?.order_id, "order")
  ) {
    throw problem(
      "INVALID_PAYMENT_ENTITY",
    );
  }

  const order = await Order.findOne({
    "payment.razorpayOrderId":
      entity.order_id,
  });

  if (!order) {
    return;
  }

  const payment = await gatewayRead(
    () =>
      getRazorpayClient().payments.fetch(
        entity.id,
      ),
  );

  if (
    payment?.id !== entity.id ||
    payment.order_id !== entity.order_id
  ) {
    throw problem(
      "CAPTURE_PROVIDER_MISMATCH",
    );
  }

  const facts = checkPayment(
    order,
    payment,
  );

  if (
    payment.status === "refunded" ||
    facts.refunded > 0
  ) {
    const reference =
      order.refund?.reference;

    if (providerId(reference, "rfnd")) {
      await reconcileRefund(
        {
          id: reference,
          payment_id: payment.id,
        },
        "refund.created",
      );

      return;
    }

    throw problem(
      "REFUNDED_PAYMENT_REQUIRES_REVIEW",
    );
  }

  if (payment.status !== "captured") {
    throw problem(
      "CAPTURE_NOT_CONFIRMED",
    );
  }

  if (
    order.payment.verifiedAt &&
    (
      [
        "refunded",
        "partially-refunded",
      ].includes(order.payment.status) ||
      order.refund?.status === "refunded"
    )
  ) {
    return;
  }

  if (
    order.payment.verifiedAt &&
    order.status === "cancelled" &&
    (
      order.metadata?.inventoryReserved === true ||
      [
        "pending",
        "manual-required",
        "refunded",
      ].includes(order.refund?.status)
    )
  ) {
    return;
  }

  if (
    order.payment.verifiedAt &&
    order.metadata?.inventoryReserved === true &&
    [
      "confirmed",
      "processing",
      "shipped",
      "out-for-delivery",
      "delivered",
    ].includes(order.status) &&
    ["paid", "partially-paid"].includes(
      order.payment.status,
    )
  ) {
    return;
  }

  if (
    typeof finalizeCapturedPayment !== "function"
  ) {
    throw problem(
      "PAYMENT_FINALIZER_MISSING",
    );
  }

  await finalizeCapturedPayment(
    order._id,
    payment,
  );
}

async function handleFailed(entity) {
  if (
    !providerId(entity?.id, "pay") ||
    !providerId(entity?.order_id, "order")
  ) {
    throw problem(
      "INVALID_PAYMENT_ENTITY",
    );
  }

  const order = await Order.findOne({
    "payment.razorpayOrderId":
      entity.order_id,
  });

  if (!order) {
    return;
  }

  if (
    order.status !== "payment-pending" ||
    order.payment?.verifiedAt ||
    order.metadata?.inventoryReserved === true ||
    [
      "paid",
      "partially-paid",
      "refunded",
      "partially-refunded",
    ].includes(order.payment?.status)
  ) {
    return;
  }

  const payment = await gatewayRead(
    () =>
      getRazorpayClient().payments.fetch(
        entity.id,
      ),
  );

  if (
    payment?.id !== entity.id ||
    payment.order_id !== entity.order_id ||
    payment.currency !== "INR"
  ) {
    throw problem(
      "FAILED_PAYMENT_MISMATCH",
    );
  }

  if (
    ["captured", "refunded"].includes(
      payment.status,
    )
  ) {
    await handleCaptured(entity);
    return;
  }

  if (payment.status !== "failed") {
    throw problem(
      "PAYMENT_FAILURE_NOT_CONFIRMED",
    );
  }

  checkPayment(order, payment);

  await Order.updateOne(
    {
      _id: order._id,

      "payment.razorpayOrderId":
        entity.order_id,

      status: "payment-pending",
      "payment.status": "pending",
      "payment.verifiedAt": null,

      "payment.amountPaid": {
        $in: [0, null],
      },

      "payment.grossCollected": {
        $in: [0, null],
      },

      "payment.refundedAmount": {
        $in: [0, null],
      },

      "metadata.inventoryReserved": {
        $ne: true,
      },

      "refund.status": {
        $in: [
          "not-requested",
          "not-applicable",
          null,
        ],
      },
    },
    {
      $set: {
        "payment.status": "failed",
        "payment.failedAt": new Date(),
      },

      $inc: { __v: 1 },
    },
    {
      runValidators: true,
    },
  );
}

async function razorpayWebhook(req, res) {
  res.set("Cache-Control", "no-store");

  const secret = String(
    process.env.RAZORPAY_WEBHOOK_SECRET || "",
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
      message:
        "Webhook requires the raw request body.",
    });
  }

  const signature =
    req.headers["x-razorpay-signature"];

  if (
    typeof signature !== "string" ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) {
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
      Buffer.from(signature, "hex"),
    )
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid webhook signature.",
    });
  }

  let body;

  try {
    body = JSON.parse(
      req.body.toString("utf8"),
    );
  } catch {
    return res.status(400).json({
      success: false,
      message: "Invalid webhook payload.",
    });
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.event !== "string" ||
    !body.event ||
    body.event.length > 100
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid webhook payload.",
    });
  }

  const event = body.event;

  try {
    if (
      ["order.paid", "payment.captured"].includes(
        event,
      )
    ) {
      await handleCaptured(
        body.payload?.payment?.entity,
      );
    } else if (event === "payment.failed") {
      await handleFailed(
        body.payload?.payment?.entity,
      );
    } else if (
      [
        "refund.created",
        "refund.processed",
        "refund.failed",
      ].includes(event)
    ) {
      await reconcileRefund(
        body.payload?.refund?.entity,
        event,
      );
    }

    return res.json({
      success: true,
      event,
    });
  } catch (error) {
    console.error(
      "Razorpay webhook processing failed:",
      error.code || error.name || "Error",
    );

    return res.status(503).json({
      success: false,
      message:
        "Webhook processing interrupted. Please retry.",
    });
  }
}

module.exports = {
  razorpayWebhook,
};