const crypto =
  require("crypto");
const mongoose =
  require("mongoose");
const Order =
  require("../models/Order");
const Product =
  require("../models/Product");
const {
  getRazorpayClient,
} =
  require(
    "../config/razorpay"
  );
const {
  roundMoney,
} =
  require(
    "../utils/orderPricing"
  );
const {
  getVariantStock,
  reserveVariantStock,
} =
  require(
    "../utils/orderInventory"
  );
// ======================================================
// COD ADVANCE
// ======================================================
const COD_ADVANCE_PERCENTAGE =
  10;
// ======================================================
// WEBHOOK SECRET
// ======================================================
function webhookSecret() {
  const secret =
    String(
      process.env
        .RAZORPAY_WEBHOOK_SECRET ||
        ""
    ).trim();
  if (
    !secret
  ) {
    throw new Error(
      "RAZORPAY_WEBHOOK_SECRET is missing."
    );
  }
  return secret;
}
// ======================================================
// RUPEES → PAISE
// ======================================================
function toPaise(
  rupees
) {
  const amount =
    Math.round(
      Number(
        rupees ||
          0
      ) *
        100
    );
  if (
    !Number.isSafeInteger(
      amount
    ) ||
    amount < 1
  ) {
    throw new Error(
      "Invalid Razorpay payment amount."
    );
  }
  return amount;
}
// ======================================================
// PAISE → RUPEES
// ======================================================
function fromPaise(
  paise
) {
  return roundMoney(
    Number(
      paise ||
        0
    ) /
      100
  );
}
// ======================================================
// CALCULATE COD ADVANCE
//
// 10% is calculated only from merchandise amount after
// coupon discount.
//
// Shipping is collected with the remaining COD balance.
// ======================================================
function calculateCodAdvance(
  pricing
) {
  const productAmount =
    Math.max(
      0,
      Number(
        pricing
          ?.totalAfterCoupon ||
          0
      )
    );
  const advanceAmount =
    roundMoney(
      (
        productAmount *
        COD_ADVANCE_PERCENTAGE
      ) /
        100
    );
  const finalTotal =
    roundMoney(
      Number(
        pricing
          ?.finalTotal ||
          0
      )
    );
  return {
    advancePercentage:
      COD_ADVANCE_PERCENTAGE,
    advanceAmount,
    amountDue:
      roundMoney(
        Math.max(
          0,
          finalTotal -
            advanceAmount
        )
      ),
  };
}
// ======================================================
// AMOUNT THAT RAZORPAY SHOULD HAVE COLLECTED
// ======================================================
function onlinePaymentAmount(
  order
) {
  if (
    order?.payment
      ?.method ===
    "cod-partial"
  ) {
    return calculateCodAdvance(
      order.pricing
    ).advanceAmount;
  }
  return roundMoney(
    Number(
      order?.pricing
        ?.finalTotal ||
        0
    )
  );
}
// ======================================================
// PAYMENT COMPLETE?
// ======================================================
function paymentRequirementCompleted(
  order
) {
  if (
    !order ||
    order.status !==
      "confirmed" ||
    !order.metadata
      ?.inventoryReserved
  ) {
    return false;
  }
  if (
    order.payment
      ?.method ===
    "razorpay"
  ) {
    return (
      order.payment
        ?.status ===
      "paid"
    );
  }
  if (
    order.payment
      ?.method ===
    "cod-partial"
  ) {
    return (
      order.payment
        ?.status ===
      "partially-paid"
    );
  }
  return false;
}
// ======================================================
// VERIFY WEBHOOK SIGNATURE
//
// req.body must remain a Buffer.
// ======================================================
function verifyWebhookSignature(
  req
) {
  if (
    !Buffer.isBuffer(
      req.body
    )
  ) {
    throw new Error(
      "Razorpay webhook requires the raw request body."
    );
  }
  const signature =
    String(
      req.headers[
        "x-razorpay-signature"
      ] ||
        ""
    ).trim();
  if (
    !signature
  ) {
    return false;
  }
  const expected =
    crypto
      .createHmac(
        "sha256",
        webhookSecret()
      )
      .update(
        req.body
      )
      .digest(
        "hex"
      );
  if (
    expected.length !==
    signature.length
  ) {
    return false;
  }
  return crypto
    .timingSafeEqual(
      Buffer.from(
        expected
      ),
      Buffer.from(
        signature
      )
    );
}
// ======================================================
// FIND GYMDROBE ORDER
// ======================================================
async function findGymDrobeOrder(
  razorpayOrderId
) {
  if (
    !razorpayOrderId
  ) {
    return null;
  }
  return Order.findOne({
    "payment.razorpayOrderId":
      razorpayOrderId,
  });
}
// ======================================================
// REFUND PAYMENT AFTER STOCK FAILURE
//
// Full online:
// refund 100%.
//
// COD partial:
// refund only 10% advance.
// ======================================================
async function startStockRefund({
  order,
  paymentId,
}) {
  if (
    !order ||
    !paymentId
  ) {
    throw new Error(
      "Refund information is incomplete."
    );
  }
  if (
    [
      "pending",
      "refunded",
      "manual-required",
    ].includes(
      order.refund
        ?.status
    )
  ) {
    return order;
  }
  const refundRupees =
    onlinePaymentAmount(
      order
    );
  const amount =
    toPaise(
      refundRupees
    );
  const razorpay =
    getRazorpayClient();
  try {
    const refund =
      await razorpay
        .payments
        .refund(
          paymentId,
          {
            amount,
            notes: {
              reason:
                "stock_unavailable",
              paymentMethod:
                order.payment
                  ?.method ||
                "",
              gymdrobeOrder:
                order.orderNumber,
            },
          }
        );
    const processed =
      refund.status ===
      "processed";
    order.status =
      "cancelled";
    order.payment.status =
      processed
        ? "refunded"
        : order.payment
              ?.method ===
            "cod-partial"
          ? "partially-paid"
          : "paid";
    order.payment.amountDue =
      0;
    order.payment.balanceStatus =
      "not-applicable";
    if (
      processed
    ) {
      order.payment.amountPaid =
        0;
    }
    order.cancellation.status =
      "cancelled";
    order.cancellation.reason =
      "Product stock changed after online payment.";
    order.cancellation.cancelledAt =
      order.cancellation
        ?.cancelledAt ||
      new Date();
    order.refund.status =
      processed
        ? "refunded"
        : "pending";
    order.refund.amount =
      refundRupees;
    order.refund.reference =
      refund.id ||
      "";
    order.refund.requestedAt =
      order.refund
        ?.requestedAt ||
      new Date();
    order.refund.refundedAt =
      processed
        ? new Date()
        : null;
    await order.save();
    return order;
  } catch (
    error
  ) {
    console.error(
      "Webhook automatic refund failed:",
      error
    );
    order.status =
      "cancelled";
    order.payment.status =
      order.payment
        ?.method ===
      "cod-partial"
        ? "partially-paid"
        : "paid";
    order.payment.amountDue =
      0;
    order.payment.balanceStatus =
      "not-applicable";
    order.cancellation.status =
      "cancelled";
    order.cancellation.reason =
      "Product stock changed after online payment and refund requires manual review.";
    order.cancellation.cancelledAt =
      order.cancellation
        ?.cancelledAt ||
      new Date();
    order.refund.status =
      "manual-required";
    order.refund.amount =
      refundRupees;
    order.refund.requestedAt =
      order.refund
        ?.requestedAt ||
      new Date();
    await order.save();
    return order;
  }
}
// ======================================================
// FINALIZE PAID ORDER
//
// Handles:
//
// razorpay
// → full online payment
//
// cod-partial
// → 10% online advance
// ======================================================
async function finalizePaidOrder({
  razorpayOrderId,
  razorpayPaymentId,
}) {
  const order =
    await findGymDrobeOrder(
      razorpayOrderId
    );
  if (
    !order
  ) {
    return {
      ignored:
        true,
      reason:
        "order-not-found",
    };
  }
  if (
    ![
      "razorpay",
      "cod-partial",
    ].includes(
      order.payment
        ?.method
    )
  ) {
    return {
      ignored:
        true,
      reason:
        "unsupported-payment-method",
    };
  }
  // ====================================================
  // ALREADY COMPLETED
  // ====================================================
  if (
    paymentRequirementCompleted(
      order
    )
  ) {
    return {
      existing:
        true,
      order,
    };
  }
  // ====================================================
  // ALREADY CANCELLED / REFUND FLOW
  // ====================================================
  if (
    order.status ===
      "cancelled" &&
    [
      "pending",
      "refunded",
      "manual-required",
    ].includes(
      order.refund
        ?.status
    )
  ) {
    return {
      existing:
        true,
      order,
    };
  }
  // ====================================================
  // FETCH PAYMENT FROM RAZORPAY
  // ====================================================
  const razorpay =
    getRazorpayClient();
  const payment =
    await razorpay
      .payments
      .fetch(
        razorpayPaymentId
      );
  if (
    payment.order_id !==
    razorpayOrderId
  ) {
    throw new Error(
      "Webhook payment does not belong to the stored Razorpay order."
    );
  }
  // ====================================================
  // VERIFY PAYMENT AMOUNT
  // ====================================================
  const expectedRupees =
    onlinePaymentAmount(
      order
    );
  const expectedAmount =
    toPaise(
      expectedRupees
    );
  if (
    Number(
      payment.amount
    ) !==
    expectedAmount
  ) {
    throw new Error(
      "Webhook payment amount does not match the GymDrobe order."
    );
  }
  if (
    String(
      payment.currency ||
        ""
    ).toUpperCase() !==
    "INR"
  ) {
    throw new Error(
      "Webhook payment currency is invalid."
    );
  }
  if (
    payment.status !==
      "captured" &&
    payment.captured !==
      true
  ) {
    throw new Error(
      "Razorpay payment is not captured."
    );
  }
  // ====================================================
  // RECORD VERIFIED PAYMENT
  // ====================================================
  const verifiedAt =
    new Date();
  order.payment.gateway =
    "razorpay";
  order.payment.transactionId =
    razorpayPaymentId;
  order.payment.razorpayOrderId =
    razorpayOrderId;
  order.payment.razorpayPaymentId =
    razorpayPaymentId;
  order.payment.verifiedAt =
    order.payment
      ?.verifiedAt ||
    verifiedAt;
  order.payment.failedAt =
    null;
  if (
    order.payment
      .method ===
    "cod-partial"
  ) {
    const partial =
      calculateCodAdvance(
        order.pricing
      );
    order.payment.status =
      "partially-paid";
    order.payment.totalAmount =
      roundMoney(
        order.pricing
          .finalTotal
      );
    order.payment.advancePercentage =
      partial.advancePercentage;
    order.payment.advanceAmount =
      partial.advanceAmount;
    order.payment.amountPaid =
      partial.advanceAmount;
    order.payment.amountDue =
      partial.amountDue;
    order.payment.advancePaidAt =
      order.payment
        .advancePaidAt ||
      verifiedAt;
    order.payment.balanceStatus =
      "pending";
    order.payment.balanceCollectedAt =
      null;
    order.payment.paidAt =
      null;
  } else {
    const total =
      roundMoney(
        order.pricing
          .finalTotal
      );
    order.payment.status =
      "paid";
    order.payment.totalAmount =
      total;
    order.payment.amountPaid =
      total;
    order.payment.amountDue =
      0;
    order.payment.advancePercentage =
      0;
    order.payment.advanceAmount =
      0;
    order.payment.advancePaidAt =
      null;
    order.payment.balanceStatus =
      "not-applicable";
    order.payment.balanceCollectedAt =
      null;
    order.payment.paidAt =
      order.payment
        .paidAt ||
      verifiedAt;
  }
  await order.save();
  // ====================================================
  // INVENTORY TRANSACTION
  // ====================================================
  const session =
    await mongoose
      .startSession();
  let savedOrder =
    null;
  try {
    await session
      .withTransaction(
        async () => {
          const current =
            await Order
              .findById(
                order._id
              )
              .session(
                session
              );
          if (
            !current
          ) {
            throw new Error(
              "GymDrobe order could not be loaded."
            );
          }
          // ============================================
          // ALREADY FINALIZED BY BROWSER
          // ============================================
          if (
            paymentRequirementCompleted(
              current
            )
          ) {
            savedOrder =
              current;
            return;
          }
          if (
            !current.metadata
          ) {
            current.metadata =
              {};
          }
          // ============================================
          // RESERVE INVENTORY ONLY ONCE
          // ============================================
          if (
            !current.metadata
              .inventoryReserved
          ) {
            const touchedProducts =
              new Map();
            for (
              const item
              of current.items
            ) {
              const productId = String(item.product);
              let product = touchedProducts.get(productId);
              if (!product) {
                product = await Product.findById(item.product).session(session);
                if (product) touchedProducts.set(productId, product);
              }
              if (
                !product ||
                product.isActive ===
                  false
              ) {
                const error =
                  new Error(
                    `${item.name} is no longer available after payment.`
                  );
                error.code =
                  "PAID_STOCK_UNAVAILABLE";
                throw error;
              }
              const available =
                getVariantStock(
                  product,
                  item.selectedSize,
                  item.selectedColor
                );
              if (
                available <
                item.quantity
              ) {
                const error =
                  new Error(
                    available > 0
                      ? `Only ${available} available for ${item.name} after payment.`
                      : `${item.name} became out of stock after payment.`
                  );
                error.code =
                  "PAID_STOCK_UNAVAILABLE";
                throw error;
              }
              reserveVariantStock(
                product,
                item.quantity,
                item.selectedSize,
                item.selectedColor
              );
              touchedProducts.set(
                String(
                  product._id
                ),
                product
              );
            }
            for (
              const product
              of touchedProducts
                .values()
            ) {
              await product.save({
                session,
              });
            }
            current.metadata.inventoryReserved =
              true;
          }
          // ============================================
          // CONFIRM GYMDROBE ORDER
          // ============================================
          current.status =
            "confirmed";
          current.payment.gateway =
            "razorpay";
          current.payment.transactionId =
            razorpayPaymentId;
          current.payment.razorpayOrderId =
            razorpayOrderId;
          current.payment.razorpayPaymentId =
            razorpayPaymentId;
          current.payment.verifiedAt =
            current.payment
              ?.verifiedAt ||
            verifiedAt;
          current.payment.failedAt =
            null;
          // ============================================
          // 10% ADVANCE COD
          // ============================================
          if (
            current.payment
              .method ===
            "cod-partial"
          ) {
            const partial =
              calculateCodAdvance(
                current.pricing
              );
            current.paymentMethod =
              "cod-partial";
            current.payment.status =
              "partially-paid";
            current.payment.totalAmount =
              roundMoney(
                current.pricing
                  .finalTotal
              );
            current.payment.advancePercentage =
              partial.advancePercentage;
            current.payment.advanceAmount =
              partial.advanceAmount;
            current.payment.amountPaid =
              partial.advanceAmount;
            current.payment.amountDue =
              partial.amountDue;
            current.payment.advancePaidAt =
              current.payment
                .advancePaidAt ||
              verifiedAt;
            current.payment.balanceStatus =
              "pending";
            current.payment.balanceCollectedAt =
              null;
            current.payment.paidAt =
              null;
          } else {
            // ==========================================
            // FULL ONLINE PAYMENT
            // ==========================================
            const total =
              roundMoney(
                current.pricing
                  .finalTotal
              );
            current.payment.method =
              "razorpay";
            current.paymentMethod =
              "razorpay";
            current.payment.status =
              "paid";
            current.payment.totalAmount =
              total;
            current.payment.amountPaid =
              total;
            current.payment.amountDue =
              0;
            current.payment.advancePercentage =
              0;
            current.payment.advanceAmount =
              0;
            current.payment.advancePaidAt =
              null;
            current.payment.balanceStatus =
              "not-applicable";
            current.payment.balanceCollectedAt =
              null;
            current.payment.paidAt =
              current.payment
                .paidAt ||
              verifiedAt;
          }
          // ============================================
          // TRACKING
          // ============================================
          if (
            !current.tracking
          ) {
            current.tracking = {
              events:
                [],
            };
          }
          if (
            !Array.isArray(
              current.tracking
                .events
            )
          ) {
            current.tracking.events =
              [];
          }
          const confirmationExists =
            current.tracking
              .events
              .some(
                (
                  event
                ) =>
                  event.status ===
                  "confirmed"
              );
          if (
            !confirmationExists
          ) {
            current.tracking
              .events
              .push({
                status:
                  "confirmed",
                description:
                  current.payment
                    .method ===
                  "cod-partial"
                    ? `10% COD advance paid online. Remaining ₹${current.payment.amountDue} is due on delivery.`
                    : "Online payment verified. Order confirmed by GymDrobe.",
                timestamp:
                  new Date(),
              });
          }
          await current.save({
            session,
          });
          savedOrder =
            current;
        }
      );
  } catch (
    finalizationError
  ) {
    // ==================================================
    // PAID BUT STOCK DISAPPEARED
    // ==================================================
    if (
      finalizationError.code ===
      "PAID_STOCK_UNAVAILABLE"
    ) {
      const latest =
        await Order.findById(
          order._id
        );
      if (
        latest
      ) {
        await startStockRefund({
          order:
            latest,
          paymentId:
            razorpayPaymentId,
        });
      }
      return {
        refunded:
          true,
        reason:
          finalizationError.message,
      };
    }
    throw finalizationError;
  } finally {
    await session
      .endSession();
  }
  return {
    order:
      savedOrder,
  };
}
// ======================================================
// PAYMENT FAILED
// ======================================================
async function handlePaymentFailed(
  payment
) {
  const razorpayOrderId =
    payment?.order_id;
  if (
    !razorpayOrderId
  ) {
    return;
  }
  const order =
    await findGymDrobeOrder(
      razorpayOrderId
    );
  if (
    !order
  ) {
    return;
  }
  /*
    Never overwrite a successful payment if another
    payment attempt against the same Razorpay order later
    fails.
  */
  if (
    [
      "paid",
      "partially-paid",
      "refunded",
    ].includes(
      order.payment
        ?.status
    )
  ) {
    return;
  }
  order.payment.status =
    "failed";
  order.payment.failedAt =
    new Date();
  if (
    payment?.id
  ) {
    order.payment.transactionId =
      payment.id;
    order.payment.razorpayPaymentId =
      payment.id;
  }
  await order.save();
}
// ======================================================
// REFUND PROCESSED
// ======================================================
async function handleRefundProcessed(
  refund
) {
  const paymentId =
    refund?.payment_id;
  if (
    !paymentId
  ) {
    return;
  }
  const order =
    await Order.findOne({
      $or: [
        {
          "payment.razorpayPaymentId":
            paymentId,
        },
        {
          "payment.transactionId":
            paymentId,
        },
      ],
    });
  if (
    !order
  ) {
    return;
  }
  const refundAmount =
    fromPaise(
      refund.amount
    );
  const expectedRefund =
    Number(
      order.refund
        ?.amount ||
        0
    );
  if (
    expectedRefund > 0 &&
    refundAmount +
      0.01 >=
      expectedRefund
  ) {
    order.refund.status =
      "refunded";
    order.refund.reference =
      refund.id ||
      order.refund
        ?.reference ||
      "";
    order.refund.refundedAt =
      new Date();
  }
  /*
    Fetch Razorpay payment to check whether all money
    collected ONLINE has been refunded.
    For cod-partial, the Razorpay payment itself is only
    the 10% advance. Therefore refunding that entire
    Razorpay payment means the online payment is fully
    refunded.
  */
  try {
    const razorpay =
      getRazorpayClient();
    const payment =
      await razorpay
        .payments
        .fetch(
          paymentId
        );
    const totalPaidOnline =
      Number(
        payment.amount ||
          0
      );
    const totalRefunded =
      Number(
        payment.amount_refunded ||
          0
      );
    if (
      totalPaidOnline > 0 &&
      totalRefunded >=
        totalPaidOnline
    ) {
      order.payment.status =
        "refunded";
      order.payment.amountPaid =
        0;
      if (
        order.status ===
        "cancelled"
      ) {
        order.payment.amountDue =
          0;
        order.payment.balanceStatus =
          "not-applicable";
      }
    }
  } catch (
    fetchError
  ) {
    console.error(
      "Unable to reconcile refunded Razorpay payment:",
      fetchError
    );
  }
  await order.save();
}
// ======================================================
// RAZORPAY WEBHOOK
//
// POST /api/payment-webhooks/razorpay
// ======================================================
async function razorpayWebhook(
  req,
  res
) {
  // ====================================================
  // VERIFY SIGNATURE
  // ====================================================
  let valid;
  try {
    valid =
      verifyWebhookSignature(
        req
      );
  } catch (
    error
  ) {
    console.error(
      "Razorpay webhook configuration error:",
      error
    );
    return res
      .status(500)
      .json({
        success:
          false,
      });
  }
  if (
    !valid
  ) {
    return res
      .status(401)
      .json({
        success:
          false,
        message:
          "Invalid Razorpay webhook signature.",
      });
  }
  // ====================================================
  // PARSE VERIFIED RAW JSON
  // ====================================================
  let body;
  try {
    body =
      JSON.parse(
        req.body.toString(
          "utf8"
        )
      );
  } catch {
    return res
      .status(400)
      .json({
        success:
          false,
        message:
          "Invalid webhook payload.",
      });
  }
  const event =
    String(
      body?.event ||
        ""
    );
  const eventId =
    String(
      req.headers[
        "x-razorpay-event-id"
      ] ||
        ""
    );
  try {
    // ==================================================
    // ORDER PAID
    //
    // Works for:
    // - Full online payment
    // - 10% COD advance
    // ==================================================
    if (
      event ===
      "order.paid"
    ) {
      const razorpayOrder =
        body?.payload
          ?.order
          ?.entity;
      const payment =
        body?.payload
          ?.payment
          ?.entity;
      const razorpayOrderId =
        razorpayOrder?.id ||
        payment?.order_id;
      const paymentId =
        payment?.id;
      if (
        razorpayOrderId &&
        paymentId
      ) {
        await finalizePaidOrder({
          razorpayOrderId,
          razorpayPaymentId:
            paymentId,
        });
      }
    }
    // ==================================================
    // PAYMENT FAILED
    // ==================================================
    else if (
      event ===
      "payment.failed"
    ) {
      const payment =
        body?.payload
          ?.payment
          ?.entity;
      await handlePaymentFailed(
        payment
      );
    }
    // ==================================================
    // REFUND PROCESSED
    // ==================================================
    else if (
      event ===
      "refund.processed"
    ) {
      const refund =
        body?.payload
          ?.refund
          ?.entity;
      await handleRefundProcessed(
        refund
      );
    }
    // ==================================================
    // FUTURE / UNSUBSCRIBED EVENTS
    // ==================================================
    else {
      console.log(
        `Ignored Razorpay webhook event: ${
          event ||
          "unknown"
        }`
      );
    }
    return res
      .status(200)
      .json({
        success:
          true,
        event,
        eventId:
          eventId ||
          undefined,
      });
  } catch (
    error
  ) {
    console.error(
      `Razorpay webhook processing failed (${
        event ||
        "unknown"
      }):`,
      error
    );
    /*
      Non-2xx allows Razorpay to retry transient webhook
      processing failures.
    */
    return res
      .status(500)
      .json({
        success:
          false,
        message:
          "Webhook processing failed.",
      });
  }
}
// ======================================================
// EXPORT
// ======================================================
module.exports = {
  razorpayWebhook,
};