const mongoose = require("mongoose");

const Order = require("../../models/Order");
const Product = require("../../models/Product");

const {
  restoreVariantStock,
} = require("../../utils/orderInventory");

const {
  getAdminOrderById,
} = require("./orderController");

function problem(
  status,
  message,
  code = "RETURN_COMPLETION_FAILED",
) {
  return Object.assign(new Error(message), {
    status,
    code,
  });
}

function text(value, name, maximum, minimum = 0) {
  if (typeof value !== "string") {
    throw problem(
      400,
      `${name} must be text.`,
      "INVALID_INSPECTION",
    );
  }

  const clean = value.trim();

  if (
    clean.length < minimum ||
    clean.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean)
  ) {
    throw problem(
      400,
      `Check ${name.toLowerCase()}.`,
      "INVALID_INSPECTION",
    );
  }

  return clean;
}

function whole(value, name, minimum = 0) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw problem(
      400,
      `Enter a valid whole-number ${name}.`,
      "INVALID_INSPECTION",
    );
  }

  return value;
}

function cents(value) {
  if (
    !["number", "string"].includes(typeof value) ||
    !String(value).trim()
  ) {
    throw problem(
      409,
      "Purchased prices and payment amounts need reconciliation.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  const amount = Number(value);
  const result = Math.round(amount * 100);

  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(result) ||
    Math.abs(amount * 100 - result) > 0.000001
  ) {
    throw problem(
      409,
      "Purchased prices and payment amounts need reconciliation.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  return result;
}

function refundAmount(order, rows) {
  const lines = order.items.map(item => {
    const quantity = whole(
      item.quantity,
      "purchased quantity",
      1,
    );

    const price = cents(item.price);
    const value = price * quantity;

    if (!Number.isSafeInteger(value)) {
      throw problem(
        409,
        "Purchased prices need review.",
        "REFUND_AMOUNT_INVALID",
      );
    }

    return { quantity, price, value };
  });

  const subtotal = lines.reduce(
    (sum, line) => sum + line.value,
    0,
  );

  const discount = cents(
    order.pricing.couponDiscount,
  );

  if (
    !Number.isSafeInteger(subtotal) ||
    subtotal !== cents(order.pricing.subtotal) ||
    discount > subtotal ||
    subtotal - discount !==
      cents(order.pricing.totalAfterCoupon)
  ) {
    throw problem(
      409,
      "Purchased prices and coupon savings need reconciliation.",
      "REFUND_AMOUNT_INVALID",
    );
  }

  const allocations = lines.map((line, index) => {
    const numerator =
      BigInt(line.value) * BigInt(discount);

    return {
      index,
      discount: subtotal
        ? Number(numerator / BigInt(subtotal))
        : 0,
      remainder: subtotal
        ? numerator % BigInt(subtotal)
        : 0n,
    };
  });

  let remaining =
    discount -
    allocations.reduce(
      (sum, line) => sum + line.discount,
      0,
    );

  const sorted = [...allocations].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );

  for (const line of sorted) {
    if (remaining-- <= 0) break;
    line.discount += 1;
  }

  return rows.reduce((sum, row) => {
    const line = lines[row.index];
    const allocated =
      allocations[row.index].discount;

    return (
      sum +
      line.price * row.returnedQuantity -
      Math.floor(allocated / line.quantity) *
        row.returnedQuantity -
      Math.min(
        allocated % line.quantity,
        row.returnedQuantity,
      )
    );
  }, 0);
}

function paymentCheck(order) {
  const payment = order.payment || {};

  const method =
    payment.method || order.paymentMethod;

  const total = cents(order.pricing?.finalTotal);
  const paid = cents(payment.amountPaid);
  const shipping = cents(order.pricing?.shipping);

  const merchandise = cents(
    order.pricing?.totalAfterCoupon,
  );

  if (
    total <= 0 ||
    cents(payment.totalAmount) !== total ||
    paid !== total ||
    cents(payment.amountDue) !== 0 ||
    merchandise + shipping !== total ||
    (order.pricing.currency || "INR") !== "INR" ||
    payment.status !== "paid" ||
    !["razorpay", "cod-partial", "cod"].includes(method) ||
    (order.paymentMethod &&
      order.paymentMethod !== method)
  ) {
    throw problem(
      409,
      "Confirm full payment and reconcile the order before completing this request.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  if (
    method !== "cod" &&
    (
      !payment.verifiedAt ||
      !(
        payment.razorpayPaymentId ||
        payment.transactionId
      )
    )
  ) {
    throw problem(
      409,
      "The online payment or COD advance is not verified.",
      "PAYMENT_NOT_VERIFIED",
    );
  }

  if (
    method === "cod-partial" &&
    (
      cents(payment.advanceAmount) !==
        Math.round(merchandise / 10) ||
      cents(payment.advanceAmount) <= 0 ||
      payment.balanceStatus !== "collected" ||
      !payment.balanceCollectedAt
    )
  ) {
    throw problem(
      409,
      "The COD advance and collected balance need reconciliation.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  if (
    payment.amountsReconciled === true &&
    (
      cents(payment.grossCollected) !== total ||
      cents(payment.refundedAmount) !== 0
    )
  ) {
    throw problem(
      409,
      "This payment has inconsistent collection or refund records.",
      "PAYMENT_RECONCILIATION_REQUIRED",
    );
  }

  return paid;
}

function inspectionRows(order, input) {
  const requested = order.returnRequest?.items;

  if (
    !Array.isArray(requested) ||
    !requested.length ||
    requested.length > 50 ||
    !Array.isArray(input) ||
    input.length !== requested.length
  ) {
    throw problem(
      400,
      "Record an inspection for every requested item.",
      "INVALID_INSPECTION",
    );
  }

  const byIndex = new Map();

  for (const row of input) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row)
    ) {
      throw problem(
        400,
        "Check the inspection items.",
        "INVALID_INSPECTION",
      );
    }

    const index = whole(row.index, "item index");

    const restockQuantity = whole(
      row.restockQuantity,
      "restock quantity",
    );

    const note = text(
      row.note ?? "",
      "Inspection note",
      500,
    );

    if (byIndex.has(index)) {
      throw problem(
        400,
        "Inspect each item only once.",
        "INVALID_INSPECTION",
      );
    }

    byIndex.set(index, {
      restockQuantity,
      note,
    });
  }

  const seen = new Set();

  return requested.map(row => {
    if (!row || typeof row !== "object") {
      throw problem(
        409,
        "The recorded request items need reconciliation.",
        "RETURN_ITEMS_INVALID",
      );
    }

    const index = whole(row.index, "item index");

    const returnedQuantity = whole(
      row.quantity,
      "received quantity",
      1,
    );

    const item = order.items?.[index];
    const inspection = byIndex.get(index);

    if (
      !item ||
      !inspection ||
      seen.has(index) ||
      returnedQuantity >
        whole(item.quantity, "purchased quantity", 1) ||
      inspection.restockQuantity > returnedQuantity ||
      (
        inspection.restockQuantity < returnedQuantity &&
        inspection.note.length < 3
      )
    ) {
      throw problem(
        400,
        "Check received and saleable quantities. Explain any items held out of stock.",
        "INVALID_INSPECTION",
      );
    }

    seen.add(index);

    return {
      index,
      returnedQuantity,
      ...inspection,
    };
  }).sort((a, b) => a.index - b.index);
}

function fingerprint(rows) {
  return JSON.stringify(
    rows.map(row => [
      row.index,
      row.returnedQuantity,
      row.restockQuantity,
      row.note,
    ]),
  );
}

async function completeInspectedReturn(req, res) {
  res.set("Cache-Control", "no-store");

  if (!req.user?._id) {
    return res.status(401).json({
      success: false,
      message: "Please sign in again.",
    });
  }

  if (
    req.user.role !== "admin" ||
    req.user.isActive === false
  ) {
    return res.status(403).json({
      success: false,
      message: "Active administrator access is required.",
    });
  }

  let session;

  try {
    if (
      !Order.schema.path(
        "returnRequest.inspectionItems",
      )
    ) {
      throw problem(
        503,
        "Install the updated Order model before completing inspections.",
        "INSPECTION_NOT_CONFIGURED",
      );
    }

    const body = req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.itemsReceived !== true
    ) {
      throw problem(
        400,
        "Confirm that all requested original items were received and inspected.",
        "INSPECTION_REQUIRED",
      );
    }

    const id = text(
      req.params?.id,
      "Order ID",
      150,
      1,
    );

    const requestId = text(
      body.requestId,
      "Request ID",
      100,
      1,
    );

    const response = text(
      body.response ?? "",
      "Customer response",
      1000,
    );

    const conditions = [{ orderNumber: id }];

    if (mongoose.isObjectIdOrHexString(id)) {
      conditions.push({ _id: id });
    }

    session = await mongoose.startSession();

    let existing = false;

    await session.withTransaction(async () => {
      existing = false;

      const order = await Order.findOne({
        $or: conditions,
      }).session(session);

      if (!order) {
        throw problem(
          404,
          "Order not found.",
          "ORDER_NOT_FOUND",
        );
      }

      const request = order.returnRequest;

      if (request?.id !== requestId) {
        throw problem(
          409,
          "The request changed. Reload it before completing.",
          "RETURN_CHANGED",
        );
      }

      const rows = inspectionRows(
        order,
        body.inspectionItems,
      );

      if (request.status === "completed") {
        const saved = Array.isArray(
          request.inspectionItems,
        )
          ? [...request.inspectionItems].sort(
              (a, b) => a.index - b.index,
            )
          : [];

        if (
          !request.inspectionCompletedAt ||
          fingerprint(saved) !== fingerprint(rows)
        ) {
          throw problem(
            409,
            "A different completion is already recorded. Reload the request.",
            "INSPECTION_ALREADY_RECORDED",
          );
        }

        existing = true;
        return;
      }

      if (
        order.status !== "delivered" ||
        order.cancellation?.status === "cancelled" ||
        request.status !== "approved" ||
        !["return", "exchange"].includes(request.type)
      ) {
        throw problem(
          409,
          "Only an approved request for a delivered order can be completed.",
          "RETURN_NOT_APPROVED",
        );
      }

      if (
        request.inspectionCompletedAt ||
        request.originalInventoryRestoredAt ||
        order.metadata?.inventoryReserved !== true
      ) {
        throw problem(
          409,
          "Original stock deductions or an earlier restoration need reconciliation.",
          "INVENTORY_RECONCILIATION_REQUIRED",
        );
      }

      const paid = paymentCheck(order);
      const refund = order.refund || {};

      const calculated = refundAmount(
        order,
        rows,
      );

      if (request.type === "return") {
        if (
          calculated > paid ||
          cents(refund.amount) !== calculated ||
          !["pending", "not-applicable"].includes(
            refund.status,
          ) ||
          refund.reference ||
          ["submitting", "submitted", "uncertain"].includes(
            refund.submissionState,
          )
        ) {
          throw problem(
            409,
            "The approved refund needs reconciliation before completing the return.",
            "REFUND_CHANGED",
          );
        }
      } else if (
        !request.exchangeInventoryReservedAt ||
        refund.status !== "not-applicable" ||
        cents(refund.amount) !== 0
      ) {
        throw problem(
          409,
          "Confirm reserved replacement stock and refund records first.",
          "EXCHANGE_RECONCILIATION_REQUIRED",
        );
      }

      const cache = new Map();

      for (const row of rows) {
        if (row.restockQuantity === 0) {
          continue;
        }

        const item = order.items[row.index];
        const key = String(item.product);

        let product = cache.get(key);

        if (!product) {
          product = await Product.findById(
            item.product,
          ).session(session);
        }

        if (!product) {
          throw problem(
            409,
            `${item.name}: the original product needs inventory review.`,
            "INVENTORY_RECONCILIATION_REQUIRED",
          );
        }

        try {
          restoreVariantStock(
            product,
            row.restockQuantity,
            item.selectedSize,
            item.selectedColor,
          );
        } catch {
          throw problem(
            409,
            `${item.name}: the original variant needs an admin correction before restocking.`,
            "INVENTORY_RECONCILIATION_REQUIRED",
          );
        }

        cache.set(key, product);
      }

      for (const product of cache.values()) {
        await product.save({ session });
      }

      const now = new Date();

      const restocked = rows.reduce(
        (sum, row) => sum + row.restockQuantity,
        0,
      );

      request.inspectionItems = rows;
      request.inspectionCompletedAt = now;
      request.inspectedBy = req.user._id;

      request.originalInventoryRestoredAt =
        restocked > 0 ? now : null;

      request.status = "completed";
      request.completedAt = now;
      request.respondedAt = now;

      if (response) {
        request.response = response;
      }

      if (request.type === "return") {
        refund.status =
          calculated > 0
            ? "manual-required"
            : "not-applicable";

        refund.submissionState = "manual";
      }

      order.tracking = order.tracking || {};
      order.tracking.events =
        order.tracking.events || [];

      order.tracking.events.push({
        status: `${request.type}-completed`,
        timestamp: now,
        description:
          `Original items received and inspected. ${restocked} accepted saleable units restored. ${
            request.type === "return"
              ? "Any refund must be processed separately."
              : "Reserved replacements require separate dispatch."
          }`,
      });

      await order.save({ session });
    });

    // Reuse the existing serializer and return persisted order details.
    return await getAdminOrderById(req, {
      responseStatus: 200,

      set: (...args) => res.set(...args),

      status(value) {
        this.responseStatus = value;
        return this;
      },

      json(data) {
        return res.status(
          this.responseStatus,
        ).json({
          ...data,

          ...(data.success
            ? {
                existing,
                message: existing
                  ? "This inspection is already recorded."
                  : "Inspection completed. Only accepted saleable quantities were restored.",
              }
            : {
                saveResultUnknown: true,
              }),
        });
      },
    });
  } catch (error) {
    const conflict = [
      "VersionError",
      "DocumentNotFoundError",
    ].includes(error.name);

    if (!error.status && !conflict) {
      console.error(
        "Return inspection failed:",
        error.name || "Error",
      );
    }

    return res.status(
      conflict ? 409 : error.status || 503,
    ).json({
      success: false,

      code: conflict
        ? "RETURN_CHANGED"
        : error.code || "RETURN_SERVICE_UNAVAILABLE",

      message: conflict
        ? "The request changed. Reload it before retrying."
        : error.status
          ? error.message
          : "Inspection could not be confirmed. Reload the request before retrying.",

      ...(!error.status && !conflict
        ? { saveResultUnknown: true }
        : {}),
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}

module.exports = {
  completeInspectedReturn,
};