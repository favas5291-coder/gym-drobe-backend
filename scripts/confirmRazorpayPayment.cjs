"use strict";

const path = require("node:path");

const {
  argumentsFor,
  failureReport,
} = require("./checkRazorpayPayment.cjs");

function stop(code) {
  throw Object.assign(new Error(code), {
    code,
    diagnostic: true,
  });
}

function paise(value) {
  if (
    !["number", "string"].includes(typeof value) ||
    !String(value).trim()
  ) {
    stop("SAVED_AMOUNT_INVALID");
  }

  const amount = Number(value);
  const result = Math.round(amount * 100);

  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(result) ||
    Math.abs(amount * 100 - result) > 0.000001
  ) {
    stop("SAVED_AMOUNT_INVALID");
  }

  return result;
}

async function timedRead(work) {
  let timer;

  try {
    return await Promise.race([
      Promise.resolve().then(work),

      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            Object.assign(
              new Error("PROVIDER_READ_TIMEOUT"),
              {
                code: "PROVIDER_READ_TIMEOUT",
                diagnostic: true,
              },
            ),
          );
        }, 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function summary(order, alreadyConfirmed) {
  return {
    success: true,
    alreadyConfirmed,
    order: order.orderNumber,
    orderStatus: order.status,
    paymentStatus: order.payment.status,
    amountPaidINR: order.payment.amountPaid,
    amountDueINR: order.payment.amountDue,
    paymentId: order.payment.razorpayPaymentId,
    inventoryReserved:
      order.metadata.inventoryReserved === true,
  };
}

// Maintenance operation for an existing order only.
// Provider access is read-only.
// No payment creation, capture, or refund.
//
// MongoDB changes use one transaction and the
// project's existing inventory helpers.
async function confirmPayment(args, services) {
  const {
    mongoose,
    Order,
    Product,
    inventory,
    client,
    keyId,
    initializeKitFulfillment,
  } = services;

  if (
    !/^rzp_(live|test)_[A-Za-z0-9]+$/.test(keyId)
  ) {
    stop("KEY_CONFIGURATION_INVALID");
  }

  const session = await mongoose.startSession();

  try {
    return await session.withTransaction(async () => {
      const order = await Order.findOne({
        orderNumber: args["--order"],
      }).session(session);

      if (!order) {
        stop("ORDER_NOT_FOUND_CHECK_DATABASE");
      }

      const payment = order.payment || {};

      if (
        payment.razorpayOrderId !==
        args["--gateway-order"]
      ) {
        stop("SAVED_GATEWAY_ORDER_MISMATCH");
      }

      if (
        typeof order.metadata?.demo !== "boolean" ||
        order.metadata.demo !==
          keyId.startsWith("rzp_test_")
      ) {
        stop("PAYMENT_MODE_MISMATCH_CHECK_LOCAL_KEYS");
      }

      const matches = await Order.countDocuments({
        "payment.razorpayOrderId":
          payment.razorpayOrderId,
      }).session(session);

      if (matches !== 1) {
        stop("GATEWAY_ORDER_HAS_MULTIPLE_DATABASE_RECORDS");
      }

      const total = paise(
        order.pricing?.finalTotal,
      );

      const cod =
        payment.method === "cod-partial";

      if (
        !["razorpay", "cod-partial"].includes(
          payment.method,
        ) ||
        order.paymentMethod !== payment.method ||
        paise(payment.totalAmount) !== total ||
        (order.pricing.currency || "INR") !== "INR"
      ) {
        stop("SAVED_PAYMENT_DETAILS_INVALID");
      }

      const expected = cod
        ? paise(payment.advanceAmount)
        : total;

      if (
        expected < 100 ||
        expected > total ||
        (
          cod &&
          (
            payment.advancePercentage !== 10 ||
            expected !== Math.round(
              paise(
                order.pricing.totalAfterCoupon,
              ) / 10,
            )
          )
        )
      ) {
        stop("SAVED_PAYMENT_DETAILS_INVALID");
      }

      const actual = await timedRead(() =>
        client.payments.fetch(
          args["--payment"],
        ),
      );

      if (
        actual?.id !== args["--payment"] ||
        actual.order_id !==
          payment.razorpayOrderId ||
        actual.currency !== "INR" ||
        !Number.isSafeInteger(actual.amount) ||
        actual.amount !== expected ||
        actual.status !== "captured" ||
        (actual.amount_refunded ?? 0) !== 0
      ) {
        stop("PAYMENT_NOT_ELIGIBLE_FOR_CONFIRMATION");
      }

      const history = await timedRead(() =>
        client.orders.fetchPayments(
          payment.razorpayOrderId,
        ),
      );

      if (
        !Array.isArray(history?.items) ||
        history.items.length >= 100
      ) {
        stop("PAYMENT_HISTORY_REQUIRES_REVIEW");
      }

      const collected = history.items.filter(
        (row) =>
          ["captured", "refunded"].includes(
            row.status,
          ),
      );

      if (
        collected.length !== 1 ||
        collected[0].id !== actual.id
      ) {
        stop("PAYMENT_HISTORY_REQUIRES_REVIEW");
      }

      const existingId =
        payment.razorpayPaymentId ||
        payment.transactionId;

      if (
        existingId &&
        existingId !== actual.id
      ) {
        stop("DIFFERENT_PAYMENT_ALREADY_RECORDED");
      }

      if (
        (
          order.refund?.status &&
          ![
            "none",
            "not-requested",
            "not-applicable",
          ].includes(order.refund.status)
        ) ||
        Number(order.refund?.amount || 0) > 0 ||
        Number(payment.refundedAmount || 0) > 0 ||
        (
          order.refund?.submissionState &&
          order.refund.submissionState !==
            "not-started"
        )
      ) {
        stop("ORDER_REFUND_REVIEW_REQUIRED");
      }

      const settled = [
        "confirmed",
        "processing",
        "shipped",
        "out-for-delivery",
        "delivered",
      ].includes(order.status);

      // A repeated run must not deduct stock again.
      if (
        settled &&
        payment.verifiedAt &&
        existingId === actual.id &&
        order.metadata.inventoryReserved === true &&
        ["paid", "partially-paid"].includes(
          payment.status,
        )
      ) {
        return summary(order, true);
      }

      if (
        order.status !== "payment-pending" ||
        payment.verifiedAt ||
        order.metadata.inventoryReserved ||
        !["pending", "failed"].includes(
          payment.status,
        ) ||
        paise(payment.amountPaid) !== 0 ||
        (
          order.cancellation?.status &&
          order.cancellation.status !==
            "not-cancelled"
        )
      ) {
        stop("ORDER_REQUIRES_REVIEW");
      }

      if (
        !Array.isArray(order.items) ||
        !order.items.length
      ) {
        stop("ORDER_ITEMS_MISSING");
      }

      const touched = new Map();

      for (const item of order.items) {
        if (
          !Number.isSafeInteger(item.quantity) ||
          item.quantity < 1
        ) {
          stop("ITEM_QUANTITY_INVALID");
        }

        const id = String(item.product || "");

        let product = touched.get(id);

        if (!product) {
          product = await Product.findById(
            item.product,
          ).session(session);
        }

        if (
          !product ||
          product.isActive === false ||
          inventory.getVariantStock(
            product,
            item.selectedSize,
            item.selectedColor,
          ) < item.quantity
        ) {
          stop("STOCK_CHANGED_NOTHING_SAVED");
        }

        inventory.reserveVariantStock(
          product,
          item.quantity,
          item.selectedSize,
          item.selectedColor,
        );

        touched.set(id, product);
      }

      const now = new Date();

      Object.assign(payment, {
        gateway: "razorpay",
        transactionId: actual.id,
        razorpayPaymentId: actual.id,
        verifiedAt: now,
        failedAt: null,
        totalAmount: total / 100,

        status:
          cod && expected < total
            ? "partially-paid"
            : "paid",

        amountPaid: expected / 100,
        amountDue: (total - expected) / 100,
        grossCollected: expected / 100,
        refundedAmount: 0,
        amountsReconciled: true,
        advancePercentage: cod ? 10 : 0,
        advanceAmount: cod ? expected / 100 : 0,
        advancePaidAt: cod ? now : null,

        balanceStatus:
          cod && expected < total
            ? "pending"
            : "not-applicable",

        paidAt:
          expected === total
            ? now
            : null,
      });

      order.metadata.inventoryReserved = true;
      order.status = "confirmed";

      if (
        order.kitSnapshots?.length &&
        !order.fulfillmentProgress
      ) {
        order.fulfillmentProgress =
          initializeKitFulfillment(order);
      }

      order.tracking = order.tracking || {};

      order.tracking.events =
        order.tracking.events || [];

      order.tracking.events.push({
        status: "confirmed",
        timestamp: now,

        description: cod
          ? `10% COD advance verified with Razorpay. Remaining ₹${payment.amountDue} is due on delivery.`
          : "Online payment verified with Razorpay. Order confirmed by GymDrobe.",
      });

      for (const product of touched.values()) {
        await product.save({ session });
      }

      await order.save({ session });

      return summary(order, false);
    });
  } finally {
    await session.endSession();
  }
}

async function main(
  argv = process.argv.slice(2),
) {
  let mongoose;
  let stage = "arguments";

  try {
    if (
      argv.filter(
        (value) => value === "--apply",
      ).length !== 1
    ) {
      stop("ADD_APPLY_TO_CONFIRM_EXISTING_PAYMENT");
    }

    const args = argumentsFor(
      argv.filter(
        (value) => value !== "--apply",
      ),
    );

    stage = "environment";

    require("dotenv").config({
      path: path.resolve(__dirname, "../.env"),
      quiet: true,
    });

    if (!process.env.MONGO_URI) {
      stop("MONGO_URI_MISSING");
    }

    mongoose = require("mongoose");

    const Order = require("../models/Order");
    const Product = require("../models/Product");

    const inventory = require(
      "../utils/orderInventory",
    );

    const {
      getRazorpayClient,
      getRazorpayKeyId,
    } = require("../config/razorpay");

    const {
      initializeKitFulfillment,
    } = require("../utils/kitFulfillmentProgress");

    const keyId = getRazorpayKeyId();
    const client = getRazorpayClient();

    stage = "database-connection";

    await mongoose.connect(
      process.env.MONGO_URI,
      {
        serverSelectionTimeoutMS: 10000,
        autoIndex: false,
        autoCreate: false,
      },
    );

    const hello =
      await mongoose.connection.db
        .admin()
        .command({ hello: 1 });

    if (
      !hello.setName &&
      hello.msg !== "isdbgrid"
    ) {
      stop("DATABASE_TRANSACTIONS_UNAVAILABLE");
    }

    stage = "verify-and-confirm-existing-order";

    const result = await confirmPayment(
      args,
      {
        mongoose,
        Order,
        Product,
        inventory,
        client,
        keyId,
        initializeKitFulfillment,
      },
    );

    console.log(
      JSON.stringify(result, null, 2),
    );
  } catch (error) {
    const report = failureReport(error, stage);

    delete report.readOnly;

    report.next =
      "Do not pay again. Share this report, then check the order before retrying.";

    if (error.name === "ValidationError") {
      report.fields = Object.keys(
        error.errors || {},
      ).filter(
        (field) =>
          /^[A-Za-z0-9_.$]{1,150}$/.test(field),
      );
    }

    console.error(
      JSON.stringify(report, null, 2),
    );

    process.exitCode = 1;
  } finally {
    if (mongoose) {
      await mongoose.disconnect();
    }
  }
}

module.exports = { confirmPayment };

if (require.main === module) {
  main();
}