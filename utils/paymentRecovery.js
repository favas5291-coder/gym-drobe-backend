"use strict";

// Recover a missed checkout callback using server-to-server provider reads.
// Never create another payment, trust a receipt image, or accept browser amounts.

const ACTIVE = [
  "confirmed",
  "processing",
  "packed",
  "shipped",
  "out-for-delivery",
  "delivered",
];

const REFUNDS = [
  "pending",
  "manual-required",
  "refunded",
  "processed",
  "completed",
];

function problem(code, message, status = 409) {
  return Object.assign(new Error(message), {
    code,
    status,
    gymdrobe: true,
  });
}

function cents(value) {
  const amount =
    typeof value === "number" ||
    (typeof value === "string" && value.trim())
      ? Number(value)
      : NaN;

  const result = Math.round(amount * 100);

  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(result) ||
    Math.abs(amount * 100 - result) > 0.000001
  ) {
    throw problem(
      "PAYMENT_REVIEW_REQUIRED",
      "The saved payment amounts need review. Do not pay again.",
    );
  }

  return result;
}

function expectedAmount(order) {
  const payment = order.payment || {};
  const total = cents(order.pricing?.finalTotal);
  const cod = payment.method === "cod-partial";

  const merchandise = cents(
    order.pricing?.totalAfterCoupon,
  );

  const expected = cod
    ? cents(payment.advanceAmount)
    : total;

  if (
    !["razorpay", "cod-partial"].includes(
      payment.method,
    ) ||
    order.paymentMethod !== payment.method ||
    (order.pricing?.currency || "INR") !== "INR" ||
    cents(payment.totalAmount) !== total ||
    merchandise > total ||
    expected < 100 ||
    expected > total ||
    (
      cod &&
      (
        payment.advancePercentage !== 10 ||
        expected !== Math.round(merchandise / 10)
      )
    )
  ) {
    throw problem(
      "PAYMENT_REVIEW_REQUIRED",
      "The saved payment terms need review. Do not pay again.",
    );
  }

  return expected;
}

function received(order) {
  return Boolean(
    ACTIVE.includes(order.status) &&
      order.payment?.verifiedAt &&
      order.metadata?.inventoryReserved === true &&
      ["paid", "partially-paid"].includes(
        order.payment.status,
      ),
  );
}

function closed(order) {
  return (
    order.status === "cancelled" ||
    order.cancellation?.status === "cancelled" ||
    REFUNDS.includes(order.refund?.status) ||
    Number(order.refund?.amount || 0) > 0 ||
    ["refunded", "partially-refunded"].includes(
      order.payment?.status,
    ) ||
    Number(order.payment?.refundedAmount || 0) > 0
  );
}

function summary(
  order,
  state,
  message,
  extra = {},
) {
  return {
    state,
    message,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    paymentStatus: order.payment?.status,
    paymentVerified: received(order),
    amountPaid: order.payment?.amountPaid,
    amountDue: order.payment?.amountDue,
    ...extra,
  };
}

async function timedRead(work) {
  let timer;

  try {
    return await Promise.race([
      Promise.resolve().then(work),

      new Promise((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              problem(
                "PAYMENT_CHECK_UNAVAILABLE",
                "Razorpay did not respond in time. Do not pay again; check later or contact support.",
                503,
              ),
            ),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createPaymentRecovery({
  Order,
  getRazorpayClient,
  getRazorpayKeyId,
  finalizeCapturedPayment,
}) {
  const inFlight = new Map();

  async function perform(order, apply) {
    const expected = expectedAmount(order);

    if (closed(order)) {
      return summary(
        order,
        "review",
        "This order is cancelled or has a refund under review. Do not pay again; contact support.",
      );
    }

    if (received(order)) {
      const paid = cents(order.payment.amountPaid);
      const due = cents(order.payment.amountDue);

      if (
        paid + due !== cents(order.pricing.finalTotal) ||
        paid < expected ||
        !/^pay_[A-Za-z0-9]+$/.test(
          order.payment.razorpayPaymentId ||
            order.payment.transactionId ||
            "",
        )
      ) {
        throw problem(
          "PAYMENT_REVIEW_REQUIRED",
          "The recorded payment balance needs review. Do not pay again.",
        );
      }

      return summary(
        order,
        "verified",
        "Payment is already verified. Your order is confirmed.",
      );
    }

    if (
      order.status !== "payment-pending" ||
      order.payment.verifiedAt ||
      order.metadata?.inventoryReserved === true ||
      !["pending", "failed"].includes(
        order.payment.status,
      ) ||
      cents(order.payment.amountPaid) !== 0 ||
      cents(order.payment.grossCollected ?? 0) !== 0 ||
      cents(order.payment.refundedAmount ?? 0) !== 0 ||
      cents(order.payment.amountDue) !==
        cents(order.pricing.finalTotal)
    ) {
      throw problem(
        "PAYMENT_REVIEW_REQUIRED",
        "This order needs payment review. Do not pay again.",
      );
    }

    const gatewayId =
      order.payment.razorpayOrderId;

    if (
      !/^order_[A-Za-z0-9]+$/.test(
        gatewayId || "",
      )
    ) {
      throw problem(
        "PAYMENT_ORDER_NOT_LINKED",
        "No Razorpay order is linked to this order. Contact support with your receipt; do not pay again.",
      );
    }

    const keyId = getRazorpayKeyId();

    if (
      !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(
        keyId || "",
      )
    ) {
      throw problem(
        "RAZORPAY_NOT_CONFIGURED",
        "Razorpay is not configured on this server. Contact support.",
        503,
      );
    }

    if (
      typeof order.metadata?.demo !== "boolean" ||
      order.metadata.demo !==
        keyId.startsWith("rzp_test_")
    ) {
      throw problem(
        "PAYMENT_MODE_CHANGED",
        "The server payment mode differs from this order. Support must check the original Razorpay account. Do not pay again.",
      );
    }

    const matchingOrders =
      await Order.countDocuments({
        "payment.razorpayOrderId": gatewayId,
      }).maxTimeMS(3000);

    if (matchingOrders !== 1) {
      throw problem(
        "DUPLICATE_GATEWAY_ORDER",
        "The saved payment reference needs administrator review. Do not pay again.",
      );
    }

    const client = getRazorpayClient();

    const gateway = await timedRead(() =>
      client.orders.fetch(gatewayId),
    );

    if (
      gateway?.id !== gatewayId ||
      gateway.currency !== "INR" ||
      gateway.amount !== expected ||
      gateway.receipt !== order.orderNumber
    ) {
      throw problem(
        "PAYMENT_MISMATCH",
        "Razorpay order details do not match this order. Do not pay again; contact support.",
      );
    }

    const history = await timedRead(() =>
      client.orders.fetchPayments(gatewayId),
    );

    if (
      !Array.isArray(history?.items) ||
      history.items.length >= 100 ||
      (
        history.count != null &&
        history.count !== history.items.length
      ) ||
      history.items.some(
        (row) =>
          !row ||
          ![
            "created",
            "authorized",
            "captured",
            "refunded",
            "failed",
          ].includes(row.status) ||
          row.order_id !== gatewayId ||
          row.currency !== "INR" ||
          !Number.isSafeInteger(row.amount) ||
          row.amount !== expected ||
          !/^pay_[A-Za-z0-9]+$/.test(
            row.id || "",
          ),
      ) ||
      new Set(
        history.items.map((row) => row.id),
      ).size !== history.items.length
    ) {
      throw problem(
        "PAYMENT_HISTORY_REVIEW",
        "Razorpay payment history needs review. Do not pay again.",
      );
    }

    const captured = history.items.filter(
      (row) =>
        ["captured", "refunded"].includes(
          row.status,
        ),
    );

    const authorized = history.items.filter(
      (row) => row.status === "authorized",
    );

    if (
      captured.length > 1 ||
      (captured.length && authorized.length)
    ) {
      throw problem(
        "MULTIPLE_PAYMENTS_REQUIRE_REVIEW",
        "Multiple payments need administrator review. Do not pay again.",
      );
    }

    if (!captured.length) {
      if (
        gateway.status === "paid" ||
        Number(gateway.amount_paid || 0) > 0
      ) {
        throw problem(
          "PAYMENT_HISTORY_REVIEW",
          "Razorpay totals and payment history differ. Do not pay again; contact support.",
        );
      }

      return summary(
        order,
        authorized.length
          ? "authorized"
          : "pending",
        authorized.length
          ? "Razorpay has received a payment authorization, but capture is not confirmed. Do not pay again; check later or contact support."
          : "No captured payment was found for this order yet. If your bank shows a deduction, do not pay again; check later or contact support.",
      );
    }

    const payment = await timedRead(() =>
      client.payments.fetch(captured[0].id),
    );

    const previousId =
      order.payment.razorpayPaymentId ||
      order.payment.transactionId;

    if (
      payment?.id !== captured[0].id ||
      payment.order_id !== gatewayId ||
      payment.currency !== "INR" ||
      payment.amount !== expected ||
      (
        previousId &&
        previousId !== payment.id
      )
    ) {
      throw problem(
        "PAYMENT_MISMATCH",
        "The captured payment does not match this order. Do not pay again.",
      );
    }

    if (
      payment.status === "refunded" ||
      Number(payment.amount_refunded || 0) > 0
    ) {
      throw problem(
        "PAYMENT_REFUND_REVIEW",
        "Razorpay has recorded a refund for this payment. Do not pay again; contact support.",
      );
    }

    if (
      payment.status !== "captured" ||
      !Number.isSafeInteger(
        payment.amount_refunded ?? 0,
      ) ||
      (payment.amount_refunded ?? 0) !== 0
    ) {
      throw problem(
        "PAYMENT_HISTORY_REVIEW",
        "Payment capture is not confirmed. Do not pay again.",
      );
    }

    if (!apply) {
      return summary(
        order,
        "captured",
        "Razorpay confirms capture. The website record still needs reconciliation.",
        {
          providerPaymentId: payment.id,
          providerAmount: expected / 100,
        },
      );
    }

    // Reuse the existing transactional payment and inventory finalizer.
    // Preserve its stock-unavailable cancellation/refund handling.
    const saved = await finalizeCapturedPayment(
      order._id,
      payment,
    );

    return summary(
      saved,
      closed(saved)
        ? "review"
        : received(saved)
          ? "verified"
          : "review",
      closed(saved)
        ? "Payment was found, but this order requires cancellation/refund review. Do not pay again; contact support."
        : received(saved)
          ? "Payment verified with Razorpay. Your order is confirmed and tracking can now be updated."
          : "Payment was found, but order confirmation needs review. Do not pay again; contact support.",
    );
  }

  return async function recoverOrderPayment(
    order,
    { apply = true } = {},
  ) {
    if (!order) {
      throw problem(
        "ORDER_NOT_FOUND",
        "Order not found for this account.",
        404,
      );
    }

    const key = `${order._id}:${apply}`;

    if (inFlight.has(key)) {
      return inFlight.get(key);
    }

    if (inFlight.size >= 1000) {
      throw problem(
        "PAYMENT_CHECK_UNAVAILABLE",
        "Payment checks are busy. Retry shortly; do not pay again.",
        503,
      );
    }

    const work = perform(order, apply)
      .catch((error) => {
        if (error.gymdrobe === true) {
          throw error;
        }

        if (
          [401, 403].includes(
            Number(
              error.statusCode || error.status,
            ),
          )
        ) {
          throw problem(
            "RAZORPAY_AUTH_FAILED",
            "The server could not authenticate with Razorpay. Support must check the original account's API keys. Do not pay again.",
            503,
          );
        }

        throw problem(
          "PAYMENT_CHECK_UNAVAILABLE",
          "Payment could not be checked. Do not pay again; retry or contact support.",
          503,
        );
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, work);

    return work;
  };
}

const recoverOrderPayment = createPaymentRecovery({
  Order: require("../models/Order"),

  ...require("../config/razorpay"),

  finalizeCapturedPayment:
    require("../middleware/controllers/razorpayController")
      .finalizeCapturedPayment,
});

module.exports = {
  createPaymentRecovery,
  recoverOrderPayment,
  expectedAmount,
};