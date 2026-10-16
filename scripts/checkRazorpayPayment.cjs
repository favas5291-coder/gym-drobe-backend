"use strict";

const path = require("node:path");

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

function validationFields(error) {
  return Object.keys(error?.errors || {}).filter(
    (field) => /^[A-Za-z0-9_.$]{1,150}$/.test(field),
  );
}

function argumentsFor(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];

    if (
      ![
        "--order",
        "--payment",
        "--gateway-order",
      ].includes(key) ||
      result[key] !== undefined ||
      !argv[index + 1]
    ) {
      stop("INVALID_ARGUMENTS");
    }

    result[key] = argv[index + 1];
  }

  if (
    !/^GD-[A-Z0-9-]{5,76}$/.test(
      result["--order"] || "",
    ) ||
    !/^pay_[A-Za-z0-9]{1,90}$/.test(
      result["--payment"] || "",
    ) ||
    !/^order_[A-Za-z0-9]{1,90}$/.test(
      result["--gateway-order"] || "",
    )
  ) {
    stop("INVALID_ARGUMENTS");
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

// Read-only: no save, database update,
// payment capture, or refund calls.
async function inspectPayment(args, services) {
  const {
    Order,
    Product,
    inventory,
    client,
    keyId,
    transactionsSupported,
    finalizerAvailable,
  } = services;

  const order = await Order.findOne({
    orderNumber: args["--order"],
  });

  if (!order) {
    stop("ORDER_NOT_FOUND_CHECK_DATABASE");
  }

  const saved = order.payment || {};

  if (
    saved.razorpayOrderId !==
    args["--gateway-order"]
  ) {
    stop("SAVED_GATEWAY_ORDER_MISMATCH");
  }

  if (
    !/^rzp_(live|test)_[A-Za-z0-9]+$/.test(keyId)
  ) {
    stop("KEY_CONFIGURATION_INVALID");
  }

  const testMode = keyId.startsWith("rzp_test_");

  if (
    typeof order.metadata?.demo !== "boolean" ||
    order.metadata.demo !== testMode
  ) {
    stop("PAYMENT_MODE_MISMATCH_CHECK_LOCAL_KEYS");
  }

  const total = paise(order.pricing?.finalTotal);
  const method = saved.method;

  if (
    !["razorpay", "cod-partial"].includes(method) ||
    order.paymentMethod !== method ||
    paise(saved.totalAmount) !== total ||
    (order.pricing.currency || "INR") !== "INR"
  ) {
    stop("SAVED_PAYMENT_DETAILS_INVALID");
  }

  const expected =
    method === "cod-partial"
      ? paise(saved.advanceAmount)
      : total;

  if (
    method === "cod-partial" &&
    (
      saved.advancePercentage !== 10 ||
      expected !==
        Math.round(
          paise(order.pricing.totalAfterCoupon) / 10,
        )
    )
  ) {
    stop("SAVED_COD_ADVANCE_INVALID");
  }

  if (expected < 100 || expected > total) {
    stop("SAVED_PAYMENT_DETAILS_INVALID");
  }

  const payment = await timedRead(() =>
    client.payments.fetch(args["--payment"]),
  );

  if (
    payment?.id !== args["--payment"] ||
    payment.order_id !== saved.razorpayOrderId ||
    payment.currency !== "INR" ||
    !Number.isSafeInteger(payment.amount) ||
    payment.amount !== expected
  ) {
    stop("PROVIDER_PAYMENT_MISMATCH");
  }

  const refunded = payment.amount_refunded ?? 0;

  if (
    !Number.isSafeInteger(refunded) ||
    refunded < 0 ||
    refunded > payment.amount
  ) {
    stop("PROVIDER_REFUND_DETAILS_INVALID");
  }

  const existingId =
    saved.razorpayPaymentId ||
    saved.transactionId;

  if (existingId && existingId !== payment.id) {
    stop("DIFFERENT_PAYMENT_ALREADY_RECORDED");
  }

  const report = {
    readOnly: true,
    order: order.orderNumber,
    paymentId: payment.id,
    gatewayOrderId: payment.order_id,
    mode: testMode ? "test" : "live",
    orderStatus: order.status,
    savedPaymentStatus: saved.status,
    providerPaymentStatus: payment.status,
    paymentMatches: true,
    expectedPaymentINR: expected / 100,
    providerAmountINR: payment.amount / 100,
    providerRefundedINR: refunded / 100,
    savedAmountPaidINR: saved.amountPaid,
    savedAmountDueINR: saved.amountDue,
    transactionsSupported,
    finalizerAvailable,
    inventoryReserved:
      order.metadata?.inventoryReserved === true,
    issues: [],
  };

  if (!transactionsSupported) {
    report.issues.push(
      "DATABASE_TRANSACTIONS_UNAVAILABLE",
    );
  }

  if (!finalizerAvailable) {
    report.issues.push("PAYMENT_FINALIZER_MISSING");
  }

  if (
    payment.status !== "captured" ||
    refunded > 0
  ) {
    report.issues.push(
      "PAYMENT_NOT_ELIGIBLE_FOR_CONFIRMATION",
    );
  }

  if (
    ["pending", "manual-required", "refunded"].includes(
      order.refund?.status,
    )
  ) {
    report.issues.push(
      "ORDER_REFUND_REVIEW_REQUIRED",
    );
  }

  if (
    order.status !== "payment-pending" ||
    saved.verifiedAt ||
    report.inventoryReserved
  ) {
    report.issues.push(
      "ORDER_ALREADY_PROCESSED_OR_REQUIRES_REVIEW",
    );

    return report;
  }

  try {
    await order.validate();
  } catch (error) {
    if (error.name !== "ValidationError") {
      throw error;
    }

    report.issues.push({
      code: "ORDER_VALIDATION_FAILED",
      fields: validationFields(error),
    });
  }

  const touched = new Map();

  if (
    !Array.isArray(order.items) ||
    !order.items.length
  ) {
    report.issues.push("ORDER_ITEMS_MISSING");
  }

  for (
    const [index, item] of
    (order.items || []).entries()
  ) {
    if (
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1
    ) {
      report.issues.push({
        code: "ITEM_QUANTITY_INVALID",
        item: index + 1,
      });

      continue;
    }

    const id = String(item.product || "");
    let product = touched.get(id);

    if (!product) {
      product = await Product.findById(item.product);
    }

    if (!product || product.isActive === false) {
      report.issues.push({
        code: "ITEM_UNAVAILABLE",
        item: index + 1,
      });

      continue;
    }

    try {
      const available = inventory.getVariantStock(
        product,
        item.selectedSize,
        item.selectedColor,
      );

      if (available < item.quantity) {
        report.issues.push({
          code: "VARIANT_STOCK_UNAVAILABLE",
          item: index + 1,
        });

        continue;
      }

      // Change this in-memory document only.
      // Nothing is saved to MongoDB.
      inventory.reserveVariantStock(
        product,
        item.quantity,
        item.selectedSize,
        item.selectedColor,
      );

      touched.set(id, product);
    } catch {
      report.issues.push({
        code: "VARIANT_VALIDATION_FAILED",
        item: index + 1,
      });
    }
  }

  for (const product of touched.values()) {
    try {
      await product.validate();
    } catch (error) {
      if (error.name !== "ValidationError") {
        throw error;
      }

      report.issues.push({
        code: "PRODUCT_VALIDATION_FAILED",
        fields: validationFields(error),
      });
    }
  }

  report.next = report.issues.length
    ? "Share this report without credentials. Nothing was changed."
    : "Payment and preflight checks match. Backend reconciliation is still required. Nothing was changed.";

  return report;
}

function failureReport(error, stage) {
  let code =
    (error?.diagnostic || error?.gymdrobe) &&
    /^[A-Z0-9_]{1,80}$/.test(error.code || "")
      ? error.code
      : "CHECK_FAILED";

  const status = Number(
    error?.statusCode || error?.status || 0,
  );

  if (status === 401 || status === 403) {
    code = "RAZORPAY_KEYS_NOT_AUTHORIZED";
  } else if (
    error?.name === "MongoServerSelectionError"
  ) {
    code = "DATABASE_CONNECTION_FAILED";
  } else if (error?.code === "MODULE_NOT_FOUND") {
    code = "BACKEND_FILE_MISSING";
  }

  const missing =
    error?.code === "MODULE_NOT_FOUND"
      ? /^Cannot find module '(\.{1,2}\/[A-Za-z0-9_./-]+)'/
          .exec(error.message || "")?.[1]
      : null;

  return {
    readOnly: true,
    stage,
    code,

    ...(missing
      ? { missingModule: missing }
      : {}),

    errorType:
      /^[A-Za-z0-9_]{1,80}$/.test(error?.name || "")
        ? error.name
        : "Error",

    next:
      "Share this report without credentials. Do not pay again.",
  };
}

async function main(
  argv = process.argv.slice(2),
) {
  let mongoose;
  let stage = "arguments";

  try {
    const args = argumentsFor(argv);

    stage = "environment";

    require("dotenv").config({
      path: path.resolve(__dirname, "../.env"),
      quiet: true,
    });

    if (!process.env.MONGO_URI) {
      stop("MONGO_URI_MISSING");
    }

    stage = "load-backend-files";

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

    const controller = require(
      "../middleware/controllers/paymentController",
    );

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

    stage = "payment-and-inventory-check";

    const report = await inspectPayment(
      args,
      {
        Order,
        Product,
        inventory,
        client,
        keyId,

        transactionsSupported: Boolean(
          hello.setName ||
          hello.msg === "isdbgrid",
        ),

        finalizerAvailable:
          typeof controller.finalizeCapturedPayment ===
          "function",
      },
    );

    console.log(
      JSON.stringify(report, null, 2),
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        failureReport(error, stage),
        null,
        2,
      ),
    );

    process.exitCode = 1;
  } finally {
    if (mongoose) {
      await mongoose.disconnect();
    }
  }
}

module.exports = {
  argumentsFor,
  inspectPayment,
  failureReport,
};

if (require.main === module) {
  main();
}