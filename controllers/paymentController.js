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
  getRazorpayKeyId,
} =
  require(
    "../config/razorpay"
  );
const {
  getDiscountedPrice,
  getOriginalPrice,
  resolveCoupon,
  calculateOrderPricing,
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
// COD ADVANCE CONFIG
// ======================================================
const COD_ADVANCE_PERCENTAGE =
  10;
// ======================================================
// ERROR HELPER
// ======================================================
function httpError(
  status,
  message,
  code = ""
) {
  const error =
    new Error(
      message
    );
  error.status =
    status;
  error.code =
    code;
  return error;
}
// ======================================================
// CLEAN STRING
// ======================================================
function cleanString(
  value,
  maxLength = 300
) {
  return String(
    value ??
      ""
  )
    .trim()
    .slice(
      0,
      maxLength
    );
}
// ======================================================
// ORDER NUMBER
// ======================================================
function generateOrderNumber() {
  const time =
    Date.now()
      .toString(36)
      .toUpperCase();
  const random =
    crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase();
  return `GD-${time}-${random}`;
}
// ======================================================
// ADDRESS
// ======================================================
function cleanAddress(
  value = {}
) {
  const address = {
    fullName:
      cleanString(
        value.fullName ||
          value.name,
        100
      ),
    email:
      cleanString(
        value.email,
        150
      ).toLowerCase(),
    phone:
      cleanString(
        value.phone,
        20
      ).replace(
        /\D/g,
        ""
      ),
    addressLine:
      cleanString(
        value.addressLine ||
          value.address,
        200
      ),
    landmark:
      cleanString(
        value.landmark,
        150
      ),
    city:
      cleanString(
        value.city,
        100
      ),
    state:
      cleanString(
        value.state,
        100
      ),
    pincode:
      cleanString(
        value.pincode,
        10
      ).replace(
        /\D/g,
        ""
      ),
    label:
      cleanString(
        value.label ||
          "Home",
        30
      ) ||
      "Home",
  };
  if (
    address.fullName
      .length < 2
  ) {
    throw httpError(
      400,
      "Enter your full name."
    );
  }
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      address.email
    )
  ) {
    throw httpError(
      400,
      "Enter a valid email."
    );
  }
  if (
    !/^[6-9]\d{9}$/.test(
      address.phone
    )
  ) {
    throw httpError(
      400,
      "Enter a valid 10-digit Indian mobile number."
    );
  }
  if (
    address.addressLine
      .length < 5
  ) {
    throw httpError(
      400,
      "Enter your house number and street."
    );
  }
  if (
    !address.city
  ) {
    throw httpError(
      400,
      "Enter your city."
    );
  }
  if (
    !address.state
  ) {
    throw httpError(
      400,
      "Enter your state."
    );
  }
  if (
    !/^[1-9]\d{5}$/.test(
      address.pincode
    )
  ) {
    throw httpError(
      400,
      "Enter a valid 6-digit pincode."
    );
  }
  return {
    ...address,
    name:
      address.fullName,
  };
}
// ======================================================
// NORMALIZE ITEMS
// ======================================================
function normalizeRequestedItems(
  items
) {
  if (
    !Array.isArray(
      items
    ) ||
    !items.length
  ) {
    throw httpError(
      400,
      "Your order is empty."
    );
  }
  if (
    items.length > 50
  ) {
    throw httpError(
      400,
      "Too many order items."
    );
  }
  const rows =
    new Map();
  for (
    const raw
    of items
  ) {
    const id =
      cleanString(
        raw?.id ||
          raw?.productId ||
          raw?.product,
        100
      );
    const quantity =
      Number(
        raw?.quantity
      );
    if (
      !id
    ) {
      throw httpError(
        400,
        "An order item is missing its product ID."
      );
    }
    if (
      !Number.isSafeInteger(
        quantity
      ) ||
      quantity < 1 ||
      quantity > 99
    ) {
      throw httpError(
        400,
        "Choose a whole-number quantity between 1 and 99."
      );
    }
    const selectedSize =
      raw?.selectedSize == null
        ? null
        : cleanString(
            raw.selectedSize,
            50
          );
    const selectedColor =
      raw?.selectedColor == null
        ? null
        : cleanString(
            raw.selectedColor,
            50
          );
    const key =
      JSON.stringify([
        id,
        selectedSize,
        selectedColor,
      ]);
    const previous =
      rows.get(
        key
      );
    if (
      previous
    ) {
      const total =
        previous.quantity +
        quantity;
      if (
        total > 99
      ) {
        throw httpError(
          400,
          "Quantity is too large."
        );
      }
      previous.quantity =
        total;
    } else {
      rows.set(
        key,
        {
          id,
          quantity,
          selectedSize,
          selectedColor,
        }
      );
    }
  }
  return [
    ...rows.values(),
  ];
}
// ======================================================
// FIND PRODUCT
// ======================================================
async function findProduct(
  id,
  session = null
) {
  const text =
    String(
      id
    );
  if (
    mongoose.Types
      .ObjectId
      .isValid(text)
  ) {
    let query =
      Product.findById(
        text
      );
    if (
      session
    ) {
      query =
        query.session(
          session
        );
    }
    const product =
      await query;
    if (
      product
    ) {
      return product;
    }
  }
  const legacyId =
    Number(
      text
    );
  if (
    Number.isSafeInteger(
      legacyId
    )
  ) {
    let query =
      Product.findOne({
        legacyId,
      });
    if (
      session
    ) {
      query =
        query.session(
          session
        );
    }
    const product =
      await query;
    if (
      product
    ) {
      return product;
    }
  }
  let query =
    Product.findOne({
      slug:
        text.toLowerCase(),
    });
  if (
    session
  ) {
    query =
      query.session(
        session
      );
  }
  return query;
}
// ======================================================
// SAFE COUPON
// ======================================================
function safeCoupon(
  coupon
) {
  if (
    !coupon
  ) {
    return {
      code:
        null,
      type:
        null,
      value:
        null,
      minimum:
        null,
    };
  }
  return {
    code:
      coupon.code,
    type:
      coupon.type,
    value:
      coupon.value,
    minimum:
      coupon.minimum,
  };
}
// ======================================================
// SAFE ORDER
// ======================================================
function safeOrder(
  order
) {
  const value =
    typeof order?.toObject ===
    "function"
      ? order.toObject()
      : order;
  if (
    !value
  ) {
    return null;
  }
  return {
    id:
      value.orderNumber,
    orderNumber:
      value.orderNumber,
    createdAt:
      value.createdAt,
    updatedAt:
      value.updatedAt,
    status:
      value.status,
    source:
      value.source,
    giftMessage:
      value.giftMessage ||
      "",
    orderNote:
      value.orderNote ||
      "",
    user: {
      id:
        String(
          value.user
        ),
    },
    customer:
      value.customer,
    shippingAddress:
      value.shippingAddress,
    items:
      (
        value.items ||
        []
      ).map(
        (
          item
        ) => ({
          id:
            String(
              item.product
            ),
          productId:
            String(
              item.product
            ),
          legacyId:
            item.legacyId,
          slug:
            item.slug,
          sku:
            item.sku,
          name:
            item.name,
          brand:
            item.brand,
          image:
            item.image,
          originalPrice:
            item.originalPrice,
          price:
            item.price,
          discount:
            item.discount,
          quantity:
            item.quantity,
          selectedSize:
            item.selectedSize,
          selectedColor:
            item.selectedColor,
          returnPolicy:
            item.returnPolicy,
        })
      ),
    pricing:
      value.pricing,
    coupon:
      value.coupon,
    payment:
      value.payment,
    paymentMethod:
      value.paymentMethod,
    delivery:
      value.delivery,
    deliveryMethod:
      value.deliveryMethod,
    tracking:
      value.tracking,
    cancellation:
      value.cancellation,
    returnRequest:
      value.returnRequest,
    refund:
      value.refund,
    metadata: {
      ...value.metadata,
      checkoutToken:
        value.checkoutToken,
    },
  };
}
// ======================================================
// PAYMENT METHOD
// ======================================================
function normalizePaymentMethod(
  value
) {
  if (
    value ===
    "cod-partial"
  ) {
    return "cod-partial";
  }
  return "razorpay";
}
// ======================================================
// CALCULATE COD ADVANCE
//
// IMPORTANT:
//
// 10% is calculated from:
// pricing.totalAfterCoupon
//
// This is the merchandise amount after coupon discount.
//
// Shipping is NOT included in the 10% advance.
//
// Example:
//
// Products after coupon: ₹2000
// Shipping:               ₹99
//
// Advance = ₹200
// COD balance = ₹1899
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
  const amountDue =
    roundMoney(
      Math.max(
        0,
        finalTotal -
          advanceAmount
      )
    );
  return {
    advancePercentage:
      COD_ADVANCE_PERCENTAGE,
    advanceAmount,
    amountDue,
  };
}
// ======================================================
// PAYMENT AMOUNT FOR RAZORPAY
// ======================================================
function getPaymentAmount({
  paymentMethod,
  pricing,
}) {
  if (
    paymentMethod ===
    "cod-partial"
  ) {
    return calculateCodAdvance(
      pricing
    ).advanceAmount;
  }
  return roundMoney(
    pricing.finalTotal
  );
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
        rupees
      ) *
        100
    );
  if (
    !Number.isSafeInteger(
      amount
    ) ||
    amount < 1
  ) {
    throw httpError(
      400,
      "Invalid payment amount."
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
// SERVER CHECKOUT SNAPSHOT
// ======================================================
async function buildCheckoutSnapshot({
  requestedItems,
  coupon,
  deliveryMethod,
  expectedTotal,
}) {
  const orderItems =
    [];
  const productCache =
    new Map();
  for (
    const requested
    of requestedItems
  ) {
    let product =
      productCache.get(
        requested.id
      );
    if (
      !product
    ) {
      product =
        await findProduct(
          requested.id
        );
      if (
        !product
      ) {
        throw httpError(
          409,
          "A product in your bag is no longer available."
        );
      }
      productCache.set(
        requested.id,
        product
      );
    }
    if (
      product.isActive ===
      false
    ) {
      throw httpError(
        409,
        `${product.name} is no longer available.`
      );
    }
    const sizes =
      (
        product.sizes ||
        []
      ).map(
        String
      );
    const colors =
      (
        product.colors ||
        []
      ).map(
        String
      );
    const selectedSize =
      sizes.length
        ? requested
            .selectedSize
        : null;
    const selectedColor =
      colors.length
        ? requested
            .selectedColor
        : null;
    const available =
      getVariantStock(
        product,
        selectedSize,
        selectedColor
      );
    if (
      available <
      requested.quantity
    ) {
      throw httpError(
        409,
        available > 0
          ? `Only ${available} available for ${product.name}.`
          : `${product.name} is out of stock for this selection.`
      );
    }
    const originalPrice =
      getOriginalPrice(
        product
      );
    const price =
      getDiscountedPrice(
        product
      );
    orderItems.push({
      product:
        product._id,
      legacyId:
        product.legacyId ??
        null,
      slug:
        product.slug ||
        "",
      sku:
        product.sku ||
        "",
      name:
        product.name,
      brand:
        product.brand ||
        "",
      image:
        product.image ||
        "",
      originalPrice,
      price,
      discount:
        Math.max(
          0,
          Math.min(
            100,
            Number(
              product.discount ||
                0
            )
          )
        ),
      quantity:
        requested.quantity,
      selectedSize,
      selectedColor,
      returnPolicy:
        product.returnPolicy ||
        "",
    });
  }
  const pricing =
    calculateOrderPricing({
      cart:
        orderItems,
      coupon,
      deliveryMethod,
    });
  if (
    Number.isFinite(
      expectedTotal
    ) &&
    Math.abs(
      roundMoney(
        expectedTotal
      ) -
        pricing.finalTotal
    ) >
      0.01
  ) {
    throw httpError(
      409,
      "Your order total changed. Review the latest total and try again."
    );
  }
  return {
    orderItems,
    pricing,
  };
}
// ======================================================
// SIGNATURE VERIFICATION
// ======================================================
function validSignature({
  razorpayOrderId,
  razorpayPaymentId,
  signature,
}) {
  const secret =
    String(
      process.env
        .RAZORPAY_KEY_SECRET ||
        ""
    ).trim();
  if (
    !secret
  ) {
    throw new Error(
      "Razorpay secret is missing."
    );
  }
  const expected =
    crypto
      .createHmac(
        "sha256",
        secret
      )
      .update(
        `${razorpayOrderId}|${razorpayPaymentId}`
      )
      .digest(
        "hex"
      );
  const received =
    cleanString(
      signature,
      500
    );
  if (
    expected.length !==
    received.length
  ) {
    return false;
  }
  return crypto
    .timingSafeEqual(
      Buffer.from(
        expected
      ),
      Buffer.from(
        received
      )
    );
}
// ======================================================
// IS ORDER PAYMENT FINISHED?
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
// CREATE PAYMENT ORDER
//
// POST /api/payments/razorpay/order
//
// Handles:
//
// paymentMethod = razorpay
// → 100% online
//
// paymentMethod = cod-partial
// → 10% online advance
// ======================================================
async function createRazorpayOrder(
  req,
  res
) {
  const userId =
    req.user._id;
  const checkoutToken =
    cleanString(
      req.body
        ?.checkoutToken,
      200
    );
  if (
    !checkoutToken
  ) {
    return res
      .status(400)
      .json({
        success:
          false,
        message:
          "Checkout token is missing. Refresh checkout and try again.",
      });
  }
  try {
    // ==================================================
    // PAYMENT TYPE
    // ==================================================
    const paymentMethod =
      normalizePaymentMethod(
        req.body
          ?.paymentMethod
      );
    // ==================================================
    // IDEMPOTENCY
    // ==================================================
    let pendingOrder =
      await Order.findOne({
        user:
          userId,
        checkoutToken,
      });
    if (
      pendingOrder
    ) {
      if (
        pendingOrder
          .payment
          ?.method !==
        paymentMethod
      ) {
        throw httpError(
          409,
          "This checkout attempt was already used for another payment method. Refresh checkout and try again."
        );
      }
      if (
        paymentRequirementCompleted(
          pendingOrder
        )
      ) {
        return res
          .status(200)
          .json({
            success:
              true,
            alreadyPaid:
              true,
            order:
              safeOrder(
                pendingOrder
              ),
          });
      }
      if (
        pendingOrder
          .payment
          ?.status ===
        "refunded"
      ) {
        throw httpError(
          409,
          "This checkout payment was already refunded. Start a new checkout."
        );
      }
      /*
        If we already created a Razorpay order for this
        checkout, reuse it.
        This avoids creating unnecessary duplicate
        Razorpay orders when the customer retries.
      */
      if (
        pendingOrder
          .payment
          ?.razorpayOrderId
      ) {
        const amount =
          getPaymentAmount({
            paymentMethod,
            pricing:
              pendingOrder
                .pricing,
          });
        return res
          .status(200)
          .json({
            success:
              true,
            existing:
              true,
            paymentMethod,
            keyId:
              getRazorpayKeyId(),
            razorpayOrderId:
              pendingOrder
                .payment
                .razorpayOrderId,
            amount:
              toPaise(
                amount
              ),
            amountRupees:
              amount,
            currency:
              "INR",
            orderNumber:
              pendingOrder
                .orderNumber,
            paymentSummary:
              {
                totalAmount:
                  pendingOrder
                    .payment
                    .totalAmount,
                amountToPayNow:
                  amount,
                amountDue:
                  pendingOrder
                    .payment
                    .amountDue,
                advancePercentage:
                  pendingOrder
                    .payment
                    .advancePercentage,
                advanceAmount:
                  pendingOrder
                    .payment
                    .advanceAmount,
              },
          });
      }
    }
    // ==================================================
    // REQUEST DATA
    // ==================================================
    const requestedItems =
      normalizeRequestedItems(
        req.body?.items
      );
    const shippingAddress =
      cleanAddress(
        req.body
          ?.shippingAddress
      );
    const deliveryMethod =
      req.body
        ?.deliveryMethod ===
      "express"
        ? "express"
        : "standard";
    const source =
      [
        "cart",
        "selection",
        "buy-now",
      ].includes(
        req.body?.source
      )
        ? req.body.source
        : "cart";
    const coupon =
      resolveCoupon(
        req.body?.coupon
      );
    const expectedTotal =
      Number(
        req.body
          ?.expectedTotal
      );
    const giftMessage =
      cleanString(
        req.body
          ?.giftMessage,
        250
      );
    const orderNote =
      cleanString(
        req.body
          ?.orderNote,
        300
      );
    // ==================================================
    // SERVER-SIDE PRICE + STOCK CHECK
    // ==================================================
    const {
      orderItems,
      pricing,
    } =
      await buildCheckoutSnapshot({
        requestedItems,
        coupon,
        deliveryMethod,
        expectedTotal,
      });
    // ==================================================
    // PAYMENT VALUES
    // ==================================================
    const finalTotal =
      roundMoney(
        pricing.finalTotal
      );
    let paymentData;
    if (
      paymentMethod ===
      "cod-partial"
    ) {
      const partial =
        calculateCodAdvance(
          pricing
        );
      if (
        partial.advanceAmount <
        1
      ) {
        throw httpError(
          400,
          "This order amount is too low for COD advance payment."
        );
      }
      paymentData = {
        method:
          "cod-partial",
        gateway:
          "razorpay",
        status:
          "pending",
        totalAmount:
          finalTotal,
        amountPaid:
          0,
        amountDue:
          finalTotal,
        advancePercentage:
          partial.advancePercentage,
        advanceAmount:
          partial.advanceAmount,
        advancePaidAt:
          null,
        balanceStatus:
          "pending",
        balanceCollectedAt:
          null,
        transactionId:
          null,
        razorpayOrderId:
          null,
        razorpayPaymentId:
          null,
        verifiedAt:
          null,
        paidAt:
          null,
        failedAt:
          null,
      };
    } else {
      paymentData = {
        method:
          "razorpay",
        gateway:
          "razorpay",
        status:
          "pending",
        totalAmount:
          finalTotal,
        amountPaid:
          0,
        amountDue:
          finalTotal,
        advancePercentage:
          0,
        advanceAmount:
          0,
        advancePaidAt:
          null,
        balanceStatus:
          "not-applicable",
        balanceCollectedAt:
          null,
        transactionId:
          null,
        razorpayOrderId:
          null,
        razorpayPaymentId:
          null,
        verifiedAt:
          null,
        paidAt:
          null,
        failedAt:
          null,
      };
    }
    // ==================================================
    // CREATE PENDING GYMDROBE ORDER
    //
    // Stock is not reduced until Razorpay payment has
    // been verified.
    // ==================================================
    if (
      !pendingOrder
    ) {
      try {
        pendingOrder =
          await Order.create({
            orderNumber:
              generateOrderNumber(),
            user:
              userId,
            checkoutToken,
            source,
            status:
              "payment-pending",
            giftMessage,
            orderNote,
            customer: {
              name:
                shippingAddress
                  .fullName,
              email:
                shippingAddress
                  .email,
              phone:
                shippingAddress
                  .phone,
            },
            shippingAddress,
            items:
              orderItems,
            pricing: {
              ...pricing,
              currency:
                "INR",
            },
            coupon:
              safeCoupon(
                coupon
              ),
            payment:
              paymentData,
            paymentMethod,
            delivery: {
              method:
                deliveryMethod,
              status:
                "pending",
              label:
                deliveryMethod ===
                "express"
                  ? "Express delivery"
                  : "Standard delivery",
              estimatedTime:
                null,
              deliveredAt:
                null,
            },
            deliveryMethod,
            tracking: {
              carrier:
                null,
              trackingNumber:
                null,
              estimatedDelivery:
                null,
              events:
                [],
            },
            cancellation: {
              status:
                "not-cancelled",
            },
            returnRequest: {
              status:
                "not-requested",
            },
            refund: {
              status:
                "not-requested",
              amount:
                0,
            },
            metadata: {
              version:
                "7.0",
              demo:
                getRazorpayKeyId()
                  .startsWith(
                    "rzp_test_"
                  ),
              inventoryReserved:
                false,
            },
          });
      } catch (
        createError
      ) {
        if (
          createError?.code ===
          11000
        ) {
          pendingOrder =
            await Order.findOne({
              user:
                userId,
              checkoutToken,
            });
        } else {
          throw createError;
        }
      }
    }
    if (
      !pendingOrder
    ) {
      throw new Error(
        "Unable to prepare your payment order."
      );
    }
    // ==================================================
    // DETERMINE AMOUNT RAZORPAY SHOULD COLLECT
    // ==================================================
    const amountRupees =
      getPaymentAmount({
        paymentMethod,
        pricing:
          pendingOrder
            .pricing,
      });
    const amount =
      toPaise(
        amountRupees
      );
    // ==================================================
    // CREATE RAZORPAY ORDER
    // ==================================================
    const razorpay =
      getRazorpayClient();
    let gatewayOrder;
    try {
      gatewayOrder =
        await razorpay
          .orders
          .create({
            amount,
            currency:
              "INR",
            receipt:
              pendingOrder
                .orderNumber
                .slice(
                  0,
                  40
                ),
            notes: {
              gymdrobeOrder:
                pendingOrder
                  .orderNumber,
              paymentMethod,
              checkoutToken:
                checkoutToken
                  .slice(
                    0,
                    100
                  ),
              userId:
                String(
                  userId
                ),
            },
          });
    } catch (
      razorpayError
    ) {
      pendingOrder.payment.status =
        "failed";
      pendingOrder.payment.failedAt =
        new Date();
      await pendingOrder
        .save();
      console.error(
        "Razorpay order creation error:",
        razorpayError
      );
      throw httpError(
        502,
        "Unable to start Razorpay payment. Please try again."
      );
    }
    // ==================================================
    // STORE RAZORPAY ORDER
    // ==================================================
    pendingOrder.payment.razorpayOrderId =
      gatewayOrder.id;
    pendingOrder.payment.status =
      "pending";
    pendingOrder.payment.failedAt =
      null;
    await pendingOrder
      .save();
    // ==================================================
    // RESPONSE TO REACT
    // ==================================================
    return res
      .status(201)
      .json({
        success:
          true,
        paymentMethod,
        keyId:
          getRazorpayKeyId(),
        razorpayOrderId:
          gatewayOrder.id,
        amount:
          gatewayOrder.amount,
        amountRupees,
        currency:
          gatewayOrder.currency,
        orderNumber:
          pendingOrder
            .orderNumber,
        paymentSummary: {
          totalAmount:
            pendingOrder
              .payment
              .totalAmount,
          amountToPayNow:
            amountRupees,
          amountDue:
            paymentMethod ===
            "cod-partial"
              ? roundMoney(
                  pendingOrder
                    .payment
                    .totalAmount -
                    amountRupees
                )
              : 0,
          advancePercentage:
            pendingOrder
              .payment
              .advancePercentage,
          advanceAmount:
            pendingOrder
              .payment
              .advanceAmount,
        },
      });
  } catch (
    error
  ) {
    console.error(
      "Create Razorpay payment order error:",
      error
    );
    return res
      .status(
        error.status ||
          500
      )
      .json({
        success:
          false,
        message:
          error.message ||
          "Unable to start payment.",
      });
  }
}
// ======================================================
// VERIFY RAZORPAY PAYMENT
//
// POST /api/payments/razorpay/verify
// ======================================================
async function verifyRazorpayPayment(
  req,
  res
) {
  const userId =
    req.user._id;
  const checkoutToken =
    cleanString(
      req.body
        ?.checkoutToken,
      200
    );
  const razorpayOrderId =
    cleanString(
      req.body
        ?.razorpay_order_id,
      200
    );
  const razorpayPaymentId =
    cleanString(
      req.body
        ?.razorpay_payment_id,
      200
    );
  const razorpaySignature =
    cleanString(
      req.body
        ?.razorpay_signature,
      500
    );
  if (
    !checkoutToken ||
    !razorpayOrderId ||
    !razorpayPaymentId ||
    !razorpaySignature
  ) {
    return res
      .status(400)
      .json({
        success:
          false,
        message:
          "Incomplete Razorpay payment details.",
      });
  }
  let order;
  try {
    // ==================================================
    // LOAD ORDER
    // ==================================================
    order =
      await Order.findOne({
        user:
          userId,
        checkoutToken,
      });
    if (
      !order
    ) {
      throw httpError(
        404,
        "Payment order was not found."
      );
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
      throw httpError(
        400,
        "This order is not waiting for a Razorpay payment."
      );
    }
    // ==================================================
    // ALREADY COMPLETED
    // ==================================================
    if (
      paymentRequirementCompleted(
        order
      )
    ) {
      return res
        .status(200)
        .json({
          success:
            true,
          existing:
            true,
          order:
            safeOrder(
              order
            ),
        });
    }
    if (
      order.payment
        ?.status ===
      "refunded"
    ) {
      throw httpError(
        409,
        "This payment has already been refunded."
      );
    }
    // ==================================================
    // MATCH STORED RAZORPAY ORDER
    // ==================================================
    const storedRazorpayOrderId =
      order.payment
        ?.razorpayOrderId;
    if (
      !storedRazorpayOrderId ||
      storedRazorpayOrderId !==
        razorpayOrderId
    ) {
      throw httpError(
        400,
        "Razorpay order ID does not match this checkout."
      );
    }
    // ==================================================
    // VERIFY SIGNATURE
    // ==================================================
    if (
      !validSignature({
        razorpayOrderId:
          storedRazorpayOrderId,
        razorpayPaymentId,
        signature:
          razorpaySignature,
      })
    ) {
      throw httpError(
        400,
        "Payment verification failed."
      );
    }
    // ==================================================
    // FETCH PAYMENT DIRECTLY FROM RAZORPAY
    // ==================================================
    const razorpay =
      getRazorpayClient();
    let payment =
      await razorpay
        .payments
        .fetch(
          razorpayPaymentId
        );
    const paymentMethod =
      order.payment
        .method;
    const expectedRupees =
      getPaymentAmount({
        paymentMethod,
        pricing:
          order.pricing,
      });
    const expectedAmount =
      toPaise(
        expectedRupees
      );
    if (
      payment.order_id !==
      storedRazorpayOrderId
    ) {
      throw httpError(
        400,
        "Razorpay payment does not belong to this order."
      );
    }
    if (
      Number(
        payment.amount
      ) !==
      expectedAmount
    ) {
      throw httpError(
        400,
        "Razorpay payment amount does not match this order."
      );
    }
    if (
      String(
        payment.currency
      ).toUpperCase() !==
      "INR"
    ) {
      throw httpError(
        400,
        "Unexpected payment currency."
      );
    }
    // ==================================================
    // CAPTURE AUTHORIZED PAYMENT
    // ==================================================
    if (
      payment.status ===
      "authorized"
    ) {
      payment =
        await razorpay
          .payments
          .capture(
            razorpayPaymentId,
            expectedAmount,
            "INR"
          );
    }
    if (
      payment.status !==
        "captured" &&
      payment.captured !==
        true
    ) {
      throw httpError(
        409,
        "Payment has not been captured yet. Please wait and try again."
      );
    }
    // ==================================================
    // STORE VERIFIED PAYMENT
    //
    // Do this before inventory work.
    //
    // If server finalization is interrupted, verification
    // can safely be retried without charging again.
    // ==================================================
    const verifiedAt =
      new Date();
    order.payment.transactionId =
      razorpayPaymentId;
    order.payment.razorpayPaymentId =
      razorpayPaymentId;
    order.payment.verifiedAt =
      order.payment
        .verifiedAt ||
      verifiedAt;
    order.payment.failedAt =
      null;
    if (
      paymentMethod ===
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
    // ==================================================
    // RESERVE INVENTORY + CONFIRM ORDER
    // ==================================================
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
                .findOne({
                  user:
                    userId,
                  checkoutToken,
                })
                .session(
                  session
                );
            if (
              !current
            ) {
              throw httpError(
                404,
                "Order disappeared during payment confirmation."
              );
            }
            // ==========================================
            // ALREADY FINALIZED
            // ==========================================
            if (
              current.status ===
                "confirmed" &&
              current.metadata
                ?.inventoryReserved
            ) {
              savedOrder =
                current;
              return;
            }
            // ==========================================
            // INVENTORY
            // ==========================================
            if (
              !current.metadata
                ?.inventoryReserved
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
                  throw httpError(
                    409,
                    `${item.name} is no longer available after payment.`,
                    "PAID_STOCK_UNAVAILABLE"
                  );
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
                  throw httpError(
                    409,
                    available > 0
                      ? `Only ${available} available for ${item.name} after payment.`
                      : `${item.name} became out of stock after payment.`,
                    "PAID_STOCK_UNAVAILABLE"
                  );
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
            // ==========================================
            // CONFIRM ORDER
            // ==========================================
            current.status =
              "confirmed";
            current.payment.gateway =
              "razorpay";
            current.payment.transactionId =
              razorpayPaymentId;
            current.payment.razorpayOrderId =
              storedRazorpayOrderId;
            current.payment.razorpayPaymentId =
              razorpayPaymentId;
            current.payment.verifiedAt =
              current.payment
                .verifiedAt ||
              verifiedAt;
            current.payment.failedAt =
              null;
            if (
              paymentMethod ===
              "cod-partial"
            ) {
              const partial =
                calculateCodAdvance(
                  current.pricing
                );
              current.payment.method =
                "cod-partial";
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
              current.payment.paidAt =
                null;
            } else {
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
              current.payment.balanceStatus =
                "not-applicable";
              current.payment.paidAt =
                current.payment
                  .paidAt ||
                verifiedAt;
            }
            // ==========================================
            // TRACKING
            // ==========================================
            const alreadyTracked =
              (
                current.tracking
                  ?.events ||
                []
              ).some(
                (
                  event
                ) =>
                  event.status ===
                  "confirmed"
              );
            if (
              !alreadyTracked
            ) {
              current.tracking.events.push({
                status:
                  "confirmed",
                description:
                  paymentMethod ===
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
      // =================================================
      // PAYMENT SUCCESSFUL BUT STOCK UNAVAILABLE
      //
      // Refund ONLY what customer paid online.
      //
      // Full online:
      // refund full amount.
      //
      // COD partial:
      // refund only 10% advance.
      // =================================================
      if (
        finalizationError.code ===
        "PAID_STOCK_UNAVAILABLE"
      ) {
        try {
          const refund =
            await razorpay
              .payments
              .refund(
                razorpayPaymentId,
                {
                  amount:
                    expectedAmount,
                  notes: {
                    reason:
                      "stock_unavailable",
                    paymentMethod,
                    gymdrobeOrder:
                      order.orderNumber,
                  },
                }
              );
          const refundProcessed =
            refund.status ===
            "processed";
          order =
            await Order.findById(
              order._id
            );
          if (
            !order
          ) {
            throw new Error(
              "Order could not be loaded after refund."
            );
          }
          order.status =
            "cancelled";
          order.payment.status =
            refundProcessed
              ? "refunded"
              : paymentMethod ===
                  "cod-partial"
                ? "partially-paid"
                : "paid";
          order.payment.transactionId =
            razorpayPaymentId;
          order.payment.razorpayPaymentId =
            razorpayPaymentId;
          order.payment.verifiedAt =
            order.payment
              .verifiedAt ||
            verifiedAt;
          /*
            Cancelled order has no remaining COD amount
            to collect.
          */
          order.payment.amountDue =
            0;
          order.payment.balanceStatus =
            "not-applicable";
          if (
            refundProcessed
          ) {
            order.payment.amountPaid =
              0;
          }
          order.cancellation.status =
            "cancelled";
          order.cancellation.reason =
            "Product stock changed after online payment.";
          order.cancellation.cancelledAt =
            new Date();
          order.refund.status =
            refundProcessed
              ? "refunded"
              : "pending";
          order.refund.amount =
            fromPaise(
              expectedAmount
            );
          order.refund.reference =
            refund.id ||
            "";
          order.refund.requestedAt =
            new Date();
          order.refund.refundedAt =
            refundProcessed
              ? new Date()
              : null;
          await order.save();
          return res
            .status(409)
            .json({
              success:
                false,
              paymentReceived:
                true,
              refundStarted:
                true,
              message:
                paymentMethod ===
                "cod-partial"
                  ? "Your 10% COD advance was paid, but the product went out of stock before the order could be confirmed. Your advance refund has been started."
                  : "Your payment succeeded, but stock changed before the order could be confirmed. A full refund has been started.",
              order:
                safeOrder(
                  order
                ),
            });
        } catch (
          refundError
        ) {
          console.error(
            "Automatic Razorpay refund error:",
            refundError
          );
          order =
            await Order.findById(
              order._id
            );
          if (
            order
          ) {
            /*
              Stop fulfillment.
              Customer has already paid money, so this
              order requires manual refund review.
            */
            order.status =
              "cancelled";
            order.payment.status =
              paymentMethod ===
              "cod-partial"
                ? "partially-paid"
                : "paid";
            order.payment.transactionId =
              razorpayPaymentId;
            order.payment.razorpayPaymentId =
              razorpayPaymentId;
            order.payment.verifiedAt =
              order.payment
                .verifiedAt ||
              verifiedAt;
            order.payment.amountDue =
              0;
            order.payment.balanceStatus =
              "not-applicable";
            order.cancellation.status =
              "cancelled";
            order.cancellation.reason =
              "Product stock changed after online payment and refund requires manual review.";
            order.cancellation.cancelledAt =
              new Date();
            order.refund.status =
              "manual-required";
            order.refund.amount =
              fromPaise(
                expectedAmount
              );
            order.refund.requestedAt =
              new Date();
            await order.save();
          }
          return res
            .status(409)
            .json({
              success:
                false,
              paymentReceived:
                true,
              refundStarted:
                false,
              message:
                paymentMethod ===
                "cod-partial"
                  ? "Your 10% advance was received, but stock changed and the automatic refund could not be completed. Do not pay again. This refund requires review."
                  : "Your payment was received, but stock changed and the automatic refund could not be completed. Do not pay again. This refund requires review.",
            });
        }
      }
      // =================================================
      // PAYMENT CAPTURED BUT ORDER FINALIZATION INTERRUPTED
      // =================================================
      console.error(
        "Razorpay order finalization error:",
        finalizationError
      );
      return res
        .status(500)
        .json({
          success:
            false,
          paymentReceived:
            true,
          retryVerification:
            true,
          message:
            "Your payment was received, but order confirmation was interrupted. Do not pay again. Please retry confirmation.",
        });
    } finally {
      await session
        .endSession();
    }
    // ==================================================
    // SUCCESS
    // ==================================================
    if (
      !savedOrder
    ) {
      throw new Error(
        "Payment succeeded but the order could not be loaded."
      );
    }
    return res
      .status(200)
      .json({
        success:
          true,
        paymentVerified:
          true,
        paymentMethod,
        paymentSummary: {
          totalAmount:
            savedOrder
              .payment
              .totalAmount,
          amountPaid:
            savedOrder
              .payment
              .amountPaid,
          amountDue:
            savedOrder
              .payment
              .amountDue,
          advancePercentage:
            savedOrder
              .payment
              .advancePercentage,
          advanceAmount:
            savedOrder
              .payment
              .advanceAmount,
          balanceStatus:
            savedOrder
              .payment
              .balanceStatus,
        },
        order:
          safeOrder(
            savedOrder
          ),
      });
  } catch (
    error
  ) {
    console.error(
      "Verify Razorpay payment error:",
      error
    );
    return res
      .status(
        error.status ||
          500
      )
      .json({
        success:
          false,
        message:
          error.message ||
          "Unable to verify payment.",
      });
  }
}
// ======================================================
// EXPORTS
// ======================================================
module.exports = {
  createRazorpayOrder,
  verifyRazorpayPayment,
};