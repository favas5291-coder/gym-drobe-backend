const crypto = require("crypto");
const mongoose = require("mongoose");

const Order = require("../models/Order");
const Product = require("../models/Product");

const {
  getDiscountedPrice,
  getOriginalPrice,
  resolveCoupon,
  calculateOrderPricing,
  roundMoney,
} = require("../utils/orderPricing");

const {
  getVariantStock,
  reserveVariantStock,
  restoreVariantStock,
} = require("../utils/orderInventory");


// ======================================================
// HELPERS
// ======================================================

function httpError(status, message) {
  const error = new Error(message);

  error.status = status;

  return error;
}


function generateOrderNumber() {
  const time = Date.now()
    .toString(36)
    .toUpperCase();

  const random = crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();

  return `GD-${time}-${random}`;
}


function generateReturnNumber() {
  const time = Date.now()
    .toString(36)
    .toUpperCase();

  const random = crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();

  return `RET-${time}-${random}`;
}


function cleanString(
  value,
  maxLength = 300
) {
  return String(
    value ?? ""
  )
    .trim()
    .slice(
      0,
      maxLength
    );
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
    address.fullName.length <
    2
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
    address.addressLine.length <
    5
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
// NORMALIZE CHECKOUT ITEMS
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
    items.length >
    50
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


    if (!id) {
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
      raw?.selectedSize ==
      null
        ? null
        : cleanString(
            raw.selectedSize,
            50
          );


    const selectedColor =
      raw?.selectedColor ==
      null
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


    if (previous) {
      const total =
        previous.quantity +
        quantity;


      if (
        total >
        99
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
  session
) {
  const text =
    String(
      id
    );


  if (
    mongoose.Types
      .ObjectId
      .isValid(
        text
      )
  ) {
    const byId =
      await Product
        .findById(
          text
        )
        .session(
          session
        );


    if (byId) {
      return byId;
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
    const byLegacy =
      await Product
        .findOne({
          legacyId,
        })
        .session(
          session
        );


    if (byLegacy) {
      return byLegacy;
    }
  }


  return Product
    .findOne({
      slug:
        text.toLowerCase(),
    })
    .session(
      session
    );
}


// ======================================================
// ORDER LOOKUP
// ======================================================

function orderLookupConditions(
  id
) {
  const conditions = [
    {
      orderNumber:
        id,
    },
  ];


  if (
    mongoose.Types
      .ObjectId
      .isValid(
        id
      )
  ) {
    conditions.push({
      _id:
        id,
    });
  }


  return conditions;
}


// ======================================================
// DELIVERY DATE
// ======================================================

function getDeliveredAt(
  order
) {
  if (
    order?.delivery
      ?.deliveredAt
  ) {
    return order
      .delivery
      .deliveredAt;
  }


  const events =
    Array.isArray(
      order?.tracking
        ?.events
    )
      ? order
          .tracking
          .events
      : [];


  for (
    let index =
      events.length - 1;

    index >= 0;

    index--
  ) {
    if (
      events[index]
        ?.status ===
      "delivered"
    ) {
      return (
        events[index]
          .timestamp ||
        null
      );
    }
  }


  return null;
}


// ======================================================
// SAFE COUPON
// ======================================================

function safeCoupon(
  coupon
) {
  if (!coupon) {
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
// SAFE ORDER RESPONSE
// ======================================================

function safeOrder(
  order
) {
  const value =
    typeof order.toObject ===
    "function"
      ? order.toObject()
      : order;


  const rawUser =
    value.user;


  const userId =
    rawUser &&
    typeof rawUser ===
      "object" &&
    rawUser._id
      ? rawUser._id
      : rawUser;


  const safeUser = {
    id:
      String(
        userId ||
        ""
      ),
  };


  if (
    rawUser &&
    typeof rawUser ===
      "object"
  ) {
    if (
      rawUser.name
    ) {
      safeUser.name =
        rawUser.name;
    }


    if (
      rawUser.email
    ) {
      safeUser.email =
        rawUser.email;
    }


    if (
      rawUser.role
    ) {
      safeUser.role =
        rawUser.role;
    }
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

    user:
      safeUser,

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
// TRACKING
// ======================================================

function ensureTracking(
  order
) {
  if (
    !order.tracking
  ) {
    order.tracking = {
      carrier:
        null,

      trackingNumber:
        null,

      estimatedDelivery:
        null,

      events:
        [],
    };
  }


  if (
    !Array.isArray(
      order.tracking
        .events
    )
  ) {
    order.tracking.events =
      [];
  }
}


// ======================================================
// CALCULATE RETURN REFUND
//
// Coupon discount is proportionally allocated.
// Shipping is not automatically refunded.
// ======================================================

function calculateReturnRefund(
  order,
  requestedItems
) {
  const returnedSubtotal =
    roundMoney(
      requestedItems.reduce(
        (
          total,
          row
        ) => {
          const item =
            order.items[
              row.index
            ];


          return (
            total +
            Number(
              item?.price ||
              0
            ) *
              Number(
                row.quantity ||
                0
              )
          );
        },
        0
      )
    );


  const orderSubtotal =
    Number(
      order.pricing
        ?.subtotal ||
      0
    );


  const couponDiscount =
    Number(
      order.pricing
        ?.couponDiscount ||
      0
    );


  if (
    returnedSubtotal <=
    0
  ) {
    return 0;
  }


  if (
    orderSubtotal <=
      0 ||
    couponDiscount <=
      0
  ) {
    return returnedSubtotal;
  }


  const proportionalCoupon =
    roundMoney(
      couponDiscount *
        (
          returnedSubtotal /
          orderSubtotal
        )
    );


  return Math.max(
    0,

    roundMoney(
      returnedSubtotal -
        proportionalCoupon
    )
  );
}


// ======================================================
// BLANK REFUND
// ======================================================

function blankRefund() {
  return {
    status:
      "not-requested",

    amount:
      0,

    requestedAt:
      null,

    reference:
      "",

    refundedAt:
      null,
  };
}


// ======================================================
// LOAD PRODUCT FOR INVENTORY
// ======================================================

async function loadProductForInventory(
  item,
  session,
  cache
) {
  const key =
    String(
      item.product
    );


  let product =
    cache.get(
      key
    );


  if (!product) {
    product =
      await Product
        .findById(
          item.product
        )
        .session(
          session
        );


    if (!product) {
      throw httpError(
        409,
        `Unable to update inventory for ${item.name}. The product no longer exists.`
      );
    }


    cache.set(
      key,
      product
    );
  }


  return product;
}


// ======================================================
// CREATE ORDER
//
// IMPORTANT:
//
// New GymDrobe orders are created by paymentController.
//
// This route is kept only for compatibility / idempotent
// lookup of an order already created using checkoutToken.
//
// Free COD checkout is no longer allowed.
// ======================================================

async function createOrder(
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
    const existing =
      await Order.findOne({
        user:
          userId,

        checkoutToken,
      });


    if (
      existing
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
              existing
            ),
        });
    }


    return res
      .status(409)
      .json({
        success:
          false,

        paymentRequired:
          true,

        message:
          "Direct Cash on Delivery checkout is disabled. Complete payment through GymDrobe checkout first.",
      });

  } catch (
    error
  ) {
    console.error(
      "Direct order lookup error:",
      error
    );


    return res
      .status(500)
      .json({
        success:
          false,

        message:
          "Unable to verify this checkout attempt.",
      });
  }
}


// ======================================================
// GET CUSTOMER ORDERS
// ======================================================

async function getOrders(
  req,
  res
) {
  try {
    const orders =
      await Order
        .find({
          user:
            req.user._id,
        })
        .sort({
          createdAt:
            -1,
        });


    return res
      .status(200)
      .json({
        success:
          true,

        count:
          orders.length,

        orders:
          orders.map(
            safeOrder
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Get orders error:",
      error
    );


    return res
      .status(500)
      .json({
        success:
          false,

        message:
          "Unable to load orders.",
      });
  }
}


// ======================================================
// GET ONE CUSTOMER ORDER
// ======================================================

async function getOrderById(
  req,
  res
) {
  try {
    const id =
      cleanString(
        req.params.id,
        150
      );


    const order =
      await Order.findOne({
        user:
          req.user._id,

        $or:
          orderLookupConditions(
            id
          ),
      });


    if (
      !order
    ) {
      return res
        .status(404)
        .json({
          success:
            false,

          message:
            "Order not found.",
        });
    }


    return res
      .status(200)
      .json({
        success:
          true,

        order:
          safeOrder(
            order
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Get order error:",
      error
    );


    return res
      .status(500)
      .json({
        success:
          false,

        message:
          "Unable to load order.",
      });
  }
}


// ======================================================
// CANCEL ORDER
//
// Supports:
//
// 1. Full Razorpay payment
//    → refund full amount paid
//
// 2. COD with 10% advance
//    → refund only the online advance paid
//
// 3. Old/legacy COD
//    → no online refund
//
// Inventory is restored only once.
// ======================================================

async function cancelOrder(
  req,
  res
) {
  const userId =
    req.user._id;


  const id =
    cleanString(
      req.params.id,
      150
    );


  const reason =
    cleanString(
      req.body?.reason,
      500
    );


  if (
    reason.length <
    5
  ) {
    return res
      .status(400)
      .json({
        success:
          false,

        message:
          "Please enter a cancellation reason of at least 5 characters.",
      });
  }


  const session =
    await mongoose
      .startSession();


  let savedOrder =
    null;


  let alreadyCancelled =
    false;


  try {
    // ==================================================
    // CANCEL ORDER + RESTORE STOCK
    // ==================================================

    await session
      .withTransaction(
        async () => {
          const order =
            await Order
              .findOne({
                user:
                  userId,

                $or:
                  orderLookupConditions(
                    id
                  ),
              })
              .session(
                session
              );


          if (
            !order
          ) {
            throw httpError(
              404,
              "Order not found."
            );
          }


          if (
            order.status ===
              "cancelled" ||
            order.cancellation
              ?.status ===
              "cancelled"
          ) {
            alreadyCancelled =
              true;


            savedOrder =
              order;


            return;
          }


          if (
            ![
              "confirmed",
              "processing",
            ].includes(
              order.status
            )
          ) {
            throw httpError(
              409,
              "This order can no longer be cancelled because shipping has already started."
            );
          }


          const now =
            new Date();


          // ============================================
          // RESTORE INVENTORY
          // ============================================

          if (
            order.metadata
              ?.inventoryReserved !==
              false &&
            !order.cancellation
              ?.inventoryRestoredAt
          ) {
            const cache =
              new Map();


            const touched =
              new Map();


            for (
              const item
              of order.items ||
              []
            ) {
              const product =
                await loadProductForInventory(
                  item,
                  session,
                  cache
                );


              restoreVariantStock(
                product,
                item.quantity,
                item.selectedSize,
                item.selectedColor
              );


              touched.set(
                String(
                  product._id
                ),
                product
              );
            }


            for (
              const product
              of touched.values()
            ) {
              await product.save({
                session,
              });
            }


            if (
              !order.metadata
            ) {
              order.metadata =
                {};
            }


            order.metadata
              .inventoryReserved =
              false;


            order.cancellation
              .inventoryRestoredAt =
              now;
          }


          // ============================================
          // CANCEL
          // ============================================

          order.status =
            "cancelled";


          order.cancellation.status =
            "cancelled";


          order.cancellation.reason =
            reason;


          order.cancellation.cancelledAt =
            now;


          if (
            order.delivery
          ) {
            order.delivery.status =
              "cancelled";
          }


          // ============================================
          // PAYMENT / REFUND
          // ============================================

          const paymentMethod =
            order.payment
              ?.method ||
            order.paymentMethod;


          const onlinePayment =
            [
              "razorpay",
              "cod-partial",
            ].includes(
              paymentMethod
            );


          const amountPaid =
            roundMoney(
              Math.max(
                0,

                Number(
                  order.payment
                    ?.amountPaid ||
                    0
                )
              )
            );


          if (
            onlinePayment &&
            amountPaid >
              0 &&
            order.payment
              ?.status !==
              "refunded"
          ) {
            order.refund.status =
              order.refund
                ?.status ===
                "refunded"
                ? "refunded"
                : "pending";


            order.refund.amount =
              amountPaid;


            order.refund.requestedAt =
              order.refund
                ?.requestedAt ||
              now;


            order.payment.amountDue =
              0;


            order.payment.balanceStatus =
              "not-applicable";
          }


          ensureTracking(
            order
          );


          order.tracking
            .events
            .push({
              status:
                "cancelled",

              description:
                onlinePayment &&
                amountPaid >
                  0
                  ? `Order cancelled by customer. Refund of ₹${amountPaid} requested.`
                  : "Order cancelled by customer.",

              timestamp:
                now,
            });


          await order.save({
            session,
          });


          savedOrder =
            order;
        }
      );


    if (
      !savedOrder
    ) {
      throw new Error(
        "Order cancellation failed."
      );
    }


    // ==================================================
    // AUTOMATIC RAZORPAY REFUND
    // ==================================================

    let latestOrder =
      savedOrder;


    const paymentMethod =
      latestOrder.payment
        ?.method ||
      latestOrder.paymentMethod;


    const onlinePayment =
      [
        "razorpay",
        "cod-partial",
      ].includes(
        paymentMethod
      );


    const refundAmount =
      roundMoney(
        Math.max(
          0,

          Number(
            latestOrder.refund
              ?.amount ||
              0
          )
        )
      );


    const paymentId =
      latestOrder.payment
        ?.razorpayPaymentId ||
      latestOrder.payment
        ?.transactionId ||
      "";


    const refundAlreadyFinished =
      latestOrder.refund
        ?.status ===
        "refunded";


    const refundAlreadyStarted =
      latestOrder.refund
        ?.status ===
        "pending" &&
      Boolean(
        latestOrder.refund
          ?.reference
      );


    const refundNeedsManualReview =
      latestOrder.refund
        ?.status ===
        "manual-required";


    if (
      onlinePayment &&
      refundAmount >
        0 &&
      !refundAlreadyFinished &&
      !refundAlreadyStarted &&
      !refundNeedsManualReview
    ) {
      const refundNow =
        new Date();


      if (
        !paymentId
      ) {
        const current =
          await Order.findById(
            latestOrder._id
          );


        if (
          current
        ) {
          current.refund.status =
            "manual-required";


          current.refund.amount =
            refundAmount;


          current.refund.requestedAt =
            current.refund
              ?.requestedAt ||
            refundNow;


          current.payment.amountDue =
            0;


          current.payment.balanceStatus =
            "not-applicable";


          ensureTracking(
            current
          );


          current.tracking
            .events
            .push({
              status:
                "refund-manual-required",

              description:
                `Refund of ₹${refundAmount} requires manual processing because the Razorpay payment ID is missing.`,

              timestamp:
                refundNow,
            });


          await current.save();


          latestOrder =
            current;
        }

      } else {
        try {
          const {
            getRazorpayClient,
          } =
            require(
              "../config/razorpay"
            );


          const razorpay =
            getRazorpayClient();


          const refundPaise =
            Math.round(
              refundAmount *
                100
            );


          if (
            !Number.isSafeInteger(
              refundPaise
            ) ||
            refundPaise <
              1
          ) {
            throw new Error(
              "Refund amount is invalid."
            );
          }


          const razorpayRefund =
            await razorpay
              .payments
              .refund(
                paymentId,
                {
                  amount:
                    refundPaise,

                  notes: {
                    reason:
                      "customer_cancellation",

                    gymdrobe_order:
                      latestOrder
                        .orderNumber,

                    payment_method:
                      paymentMethod,
                  },
                }
              );


          const processed =
            razorpayRefund
              ?.status ===
            "processed";


          const current =
            await Order.findById(
              latestOrder._id
            );


          if (
            current
          ) {
            current.refund.status =
              processed
                ? "refunded"
                : "pending";


            current.refund.amount =
              refundAmount;


            current.refund.reference =
              razorpayRefund
                ?.id ||
              current.refund
                ?.reference ||
              "";


            current.refund.requestedAt =
              current.refund
                ?.requestedAt ||
              refundNow;


            current.refund.refundedAt =
              processed
                ? refundNow
                : null;


            current.payment.amountDue =
              0;


            current.payment.balanceStatus =
              "not-applicable";


            if (
              processed
            ) {
              current.payment.status =
                "refunded";


              current.payment.amountPaid =
                0;
            }


            ensureTracking(
              current
            );


            current.tracking
              .events
              .push({
                status:
                  processed
                    ? "refund-completed"
                    : "refund-requested",

                description:
                  processed
                    ? `Refund of ₹${refundAmount} completed through Razorpay.`
                    : `Refund of ₹${refundAmount} submitted to Razorpay.`,

                timestamp:
                  refundNow,
              });


            await current.save();


            latestOrder =
              current;
          }

        } catch (
          refundError
        ) {
          console.error(
            "Cancellation refund error:",
            refundError
          );


          const current =
            await Order.findById(
              latestOrder._id
            );


          if (
            current
          ) {
            current.refund.status =
              "manual-required";


            current.refund.amount =
              refundAmount;


            current.refund.requestedAt =
              current.refund
                ?.requestedAt ||
              refundNow;


            current.payment.amountDue =
              0;


            current.payment.balanceStatus =
              "not-applicable";


            ensureTracking(
              current
            );


            current.tracking
              .events
              .push({
                status:
                  "refund-manual-required",

                description:
                  `Automatic Razorpay refund of ₹${refundAmount} failed and requires manual review.`,

                timestamp:
                  refundNow,
              });


            await current.save();


            latestOrder =
              current;
          }
        }
      }
    }


    let message =
      alreadyCancelled
        ? "This order is already cancelled."
        : "Order cancelled successfully.";


    if (
      latestOrder.refund
        ?.status ===
        "refunded"
    ) {
      message =
        `Order cancelled successfully. ₹${roundMoney(
          Number(
            latestOrder.refund
              ?.amount ||
            0
          )
        )} refund completed.`;

    } else if (
      latestOrder.refund
        ?.status ===
        "pending"
    ) {
      message =
        `Order cancelled successfully. Refund of ₹${roundMoney(
          Number(
            latestOrder.refund
              ?.amount ||
            0
          )
        )} is being processed.`;

    } else if (
      latestOrder.refund
        ?.status ===
        "manual-required"
    ) {
      message =
        `Order cancelled successfully. Refund of ₹${roundMoney(
          Number(
            latestOrder.refund
              ?.amount ||
            0
          )
        )} requires manual review.`;
    }


    return res
      .status(200)
      .json({
        success:
          true,

        existing:
          alreadyCancelled,

        refundStatus:
          latestOrder.refund
            ?.status ||
          "not-requested",

        refundAmount:
          Number(
            latestOrder.refund
              ?.amount ||
              0
          ),

        manualReviewRequired:
          latestOrder.refund
            ?.status ===
          "manual-required",

        message,

        order:
          safeOrder(
            latestOrder
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Cancel order error:",
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
          "Unable to cancel order.",
      });

  } finally {
    await session
      .endSession();
  }
}


// ======================================================
// CUSTOMER RETURN / EXCHANGE REQUEST
// ======================================================

async function requestReturn(
  req,
  res
) {
  const userId =
    req.user._id;


  const id =
    cleanString(
      req.params.id,
      150
    );


  const type =
    cleanString(
      req.body?.type,
      20
    ).toLowerCase();


  const reason =
    cleanString(
      req.body?.reason,
      1000
    );


  const requestedItems =
    Array.isArray(
      req.body?.items
    )
      ? req.body.items
      : [];


  if (
    ![
      "return",
      "exchange",
    ].includes(
      type
    )
  ) {
    return res
      .status(400)
      .json({
        success:
          false,

        message:
          "Choose return or exchange.",
      });
  }


  if (
    reason.length <
    5
  ) {
    return res
      .status(400)
      .json({
        success:
          false,

        message:
          "Please describe the reason in at least 5 characters.",
      });
  }


  if (
    !requestedItems.length
  ) {
    return res
      .status(400)
      .json({
        success:
          false,

        message:
          "Select at least one item.",
      });
  }


  if (
    requestedItems.length >
    50
  ) {
    return res
      .status(400)
      .json({
        success:
          false,

        message:
          "Too many return items.",
      });
  }


  const session =
    await mongoose
      .startSession();


  let savedOrder =
    null;


  try {
    await session
      .withTransaction(
        async () => {
          const order =
            await Order
              .findOne({
                user:
                  userId,

                $or:
                  orderLookupConditions(
                    id
                  ),
              })
              .session(
                session
              );


          if (
            !order
          ) {
            throw httpError(
              404,
              "Order not found."
            );
          }


          if (
            order.status !==
            "delivered"
          ) {
            throw httpError(
              409,
              "Returns and exchanges open after delivery."
            );
          }


          const currentStatus =
            order.returnRequest
              ?.status ||
            "not-requested";


          if (
            currentStatus !==
              "not-requested" &&
            currentStatus !==
              "rejected"
          ) {
            throw httpError(
              409,
              "A return or exchange request is already recorded for this order."
            );
          }


          const deliveredAt =
            getDeliveredAt(
              order
            );


          const deliveryTime =
            Date.parse(
              deliveredAt
            );


          const nowMs =
            Date.now();


          if (
            !Number.isFinite(
              deliveryTime
            ) ||
            deliveryTime >
              nowMs
          ) {
            throw httpError(
              409,
              "Contact support to confirm the delivery date and return eligibility."
            );
          }


          const deadline =
            deliveryTime +
            7 *
              86400000;


          if (
            nowMs >
            deadline
          ) {
            throw httpError(
              409,
              "The 7-day request window has ended. Contact support for help."
            );
          }


          const seen =
            new Set();


          const cleanItems =
            [];


          for (
            const raw
            of requestedItems
          ) {
            const index =
              Number(
                raw?.index
              );


            const quantity =
              Number(
                raw?.quantity
              );


            if (
              !Number.isSafeInteger(
                index
              ) ||
              index <
                0 ||
              seen.has(
                index
              )
            ) {
              throw httpError(
                400,
                "Choose valid item quantities."
              );
            }


            const item =
              order.items[
                index
              ];


            if (
              !item ||
              !Number.isSafeInteger(
                quantity
              ) ||
              quantity <
                1 ||
              quantity >
                item.quantity
            ) {
              throw httpError(
                400,
                "Choose valid item quantities."
              );
            }


            let size =
              raw?.size ==
              null
                ? null
                : cleanString(
                    raw.size,
                    50
                  );


            let color =
              raw?.color ==
              null
                ? null
                : cleanString(
                    raw.color,
                    50
                  );


            if (
              type ===
              "exchange"
            ) {
              const product =
                await Product
                  .findById(
                    item.product
                  )
                  .session(
                    session
                  );


              if (
                !product ||
                product.isActive ===
                false
              ) {
                throw httpError(
                  409,
                  `${item.name}: This product is no longer available.`
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


              size =
                sizes.length
                  ? size
                  : null;


              color =
                colors.length
                  ? color
                  : null;


              const available =
                getVariantStock(
                  product,
                  size,
                  color
                );


              if (
                available <
                quantity
              ) {
                throw httpError(
                  409,

                  available >
                  0
                    ? `${item.name}: Only ${available} available for this selection.`
                    : `${item.name}: This selection is out of stock.`
                );
              }


              const sameSize =
                (
                  size ??
                  null
                ) ===
                (
                  item.selectedSize ??
                  null
                );


              const sameColor =
                (
                  color ??
                  null
                ) ===
                (
                  item.selectedColor ??
                  null
                );


              if (
                sameSize &&
                sameColor
              ) {
                throw httpError(
                  400,
                  "Choose a different size or colour for an exchange."
                );
              }

            } else {
              size =
                null;


              color =
                null;
            }


            cleanItems.push({
              index,

              quantity,

              size,

              color,
            });


            seen.add(
              index
            );
          }


          const requestedAt =
            new Date();


          order.returnRequest = {
            id:
              generateReturnNumber(),

            type,

            status:
              "requested",

            items:
              cleanItems,

            reason,

            requestedAt,

            response:
              "",

            respondedAt:
              null,

            approvedAt:
              null,

            rejectedAt:
              null,

            completedAt:
              null,

            originalInventoryRestoredAt:
              null,

            exchangeInventoryReservedAt:
              null,
          };


          order.refund =
            blankRefund();


          ensureTracking(
            order
          );


          order.tracking
            .events
            .push({
              status:
                type ===
                "exchange"
                  ? "exchange-requested"
                  : "return-requested",

              description:
                type ===
                "exchange"
                  ? "Exchange request submitted by customer."
                  : "Return request submitted by customer.",

              timestamp:
                requestedAt,
            });


          await order.save({
            session,
          });


          savedOrder =
            order;
        }
      );


    if (
      !savedOrder
    ) {
      throw new Error(
        "Return request was not created."
      );
    }


    return res
      .status(201)
      .json({
        success:
          true,

        message:
          type ===
          "exchange"
            ? "Exchange request submitted successfully."
            : "Return request submitted successfully.",

        order:
          safeOrder(
            savedOrder
          ),

        returnRequest:
          savedOrder
            .returnRequest,
      });

  } catch (
    error
  ) {
    console.error(
      "Return request error:",
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
          "Unable to submit return request.",
      });

  } finally {
    await session
      .endSession();
  }
}


// ======================================================
// ADMIN — LIST RETURN / EXCHANGE REQUESTS
// ======================================================

async function getAdminReturnRequests(
  req,
  res
) {
  try {
    const requestedStatus =
      cleanString(
        req.query?.status,
        30
      ).toLowerCase();


    const allowedStatuses = [
      "requested",
      "approved",
      "rejected",
      "completed",
    ];


    if (
      requestedStatus &&
      !allowedStatuses.includes(
        requestedStatus
      )
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          message:
            "Invalid return request status.",
        });
    }


    const query = {
      "returnRequest.status":
        requestedStatus
          ? requestedStatus
          : {
              $in:
                allowedStatuses,
            },
    };


    const orders =
      await Order
        .find(
          query
        )
        .populate(
          "user",
          "name email role"
        )
        .sort({
          "returnRequest.requestedAt":
            -1,

          createdAt:
            -1,
        });


    return res
      .status(200)
      .json({
        success:
          true,

        count:
          orders.length,

        orders:
          orders.map(
            safeOrder
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Admin return list error:",
      error
    );


    return res
      .status(500)
      .json({
        success:
          false,

        message:
          "Unable to load return and exchange requests.",
      });
  }
}


// ======================================================
// ADMIN — LIST ALL ORDERS
// ======================================================

async function getAdminOrders(
  req,
  res
) {
  try {
    const requestedStatus =
      cleanString(
        req.query?.status,
        40
      ).toLowerCase();


    const search =
      cleanString(
        req.query?.search,
        120
      );


    const page =
      Math.max(
        1,

        Number.parseInt(
          req.query?.page,
          10
        ) ||
        1
      );


    const limit =
      Math.min(
        100,

        Math.max(
          1,

          Number.parseInt(
            req.query?.limit,
            10
          ) ||
          25
        )
      );


    const allowedStatuses = [
      "payment-pending",
      "confirmed",
      "processing",
      "shipped",
      "out-for-delivery",
      "delivered",
      "cancelled",
    ];


    if (
      requestedStatus &&
      requestedStatus !==
        "all" &&
      !allowedStatuses.includes(
        requestedStatus
      )
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          message:
            "Invalid order status.",
        });
    }


    const query =
      {};


    if (
      requestedStatus &&
      requestedStatus !==
        "all"
    ) {
      query.status =
        requestedStatus;
    }


    if (
      search
    ) {
      const escapedSearch =
        search.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );


      const searchRegex =
        new RegExp(
          escapedSearch,
          "i"
        );


      query.$or = [
        {
          orderNumber:
            searchRegex,
        },

        {
          "customer.name":
            searchRegex,
        },

        {
          "customer.email":
            searchRegex,
        },

        {
          "customer.phone":
            searchRegex,
        },

        {
          "shippingAddress.city":
            searchRegex,
        },

        {
          "shippingAddress.pincode":
            searchRegex,
        },
      ];
    }


    const skip =
      (
        page -
        1
      ) *
      limit;


    const [
      orders,
      total,
    ] =
      await Promise.all([
        Order
          .find(
            query
          )
          .populate(
            "user",
            "name email role"
          )
          .sort({
            createdAt:
              -1,
          })
          .skip(
            skip
          )
          .limit(
            limit
          ),

        Order.countDocuments(
          query
        ),
      ]);


    return res
      .status(200)
      .json({
        success:
          true,

        count:
          orders.length,

        total,

        page,

        pages:
          Math.max(
            1,

            Math.ceil(
              total /
              limit
            )
          ),

        limit,

        orders:
          orders.map(
            safeOrder
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Admin order list error:",
      error
    );


    return res
      .status(500)
      .json({
        success:
          false,

        message:
          "Unable to load admin orders.",
      });
  }
}


// ======================================================
// ADMIN — GET ONE ORDER
// ======================================================

async function getAdminOrderById(
  req,
  res
) {
  try {
    const id =
      cleanString(
        req.params.id,
        150
      );


    const order =
      await Order
        .findOne({
          $or:
            orderLookupConditions(
              id
            ),
        })
        .populate(
          "user",
          "name email role"
        );


    if (
      !order
    ) {
      return res
        .status(404)
        .json({
          success:
            false,

          message:
            "Order not found.",
        });
    }


    return res
      .status(200)
      .json({
        success:
          true,

        order:
          safeOrder(
            order
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Admin get order error:",
      error
    );


    return res
      .status(500)
      .json({
        success:
          false,

        message:
          "Unable to load this order.",
      });
  }
}


// ======================================================
// ADMIN — UPDATE ORDER STATUS / TRACKING
// ======================================================

async function updateAdminOrderStatus(
  req,
  res
) {
  const id =
    cleanString(
      req.params.id,
      150
    );


  const status =
    cleanString(
      req.body?.status,
      40
    ).toLowerCase();


  const statusFlow = [
    "confirmed",
    "processing",
    "shipped",
    "out-for-delivery",
    "delivered",
  ];


  if (
    !statusFlow.includes(
      status
    )
  ) {
    return res
      .status(400)
      .json({
        success:
          false,

        message:
          "Choose a valid fulfilment status.",
      });
  }


  const hasCarrier =
    Object.prototype
      .hasOwnProperty.call(
        req.body ||
          {},
        "carrier"
      );


  const hasTrackingNumber =
    Object.prototype
      .hasOwnProperty.call(
        req.body ||
          {},
        "trackingNumber"
      );


  const hasEstimatedDelivery =
    Object.prototype
      .hasOwnProperty.call(
        req.body ||
          {},
        "estimatedDelivery"
      );


  const hasCodBalanceCollected =
    Object.prototype
      .hasOwnProperty.call(
        req.body ||
          {},
        "codBalanceCollected"
      );


  const carrier =
    hasCarrier
      ? cleanString(
          req.body?.carrier,
          100
        ) ||
        null
      : undefined;


  const trackingNumber =
    hasTrackingNumber
      ? cleanString(
          req.body
            ?.trackingNumber,
          150
        ) ||
        null
      : undefined;


  const codBalanceCollected =
    hasCodBalanceCollected &&
    req.body
      ?.codBalanceCollected ===
      true;


  let estimatedDelivery;


  if (
    hasEstimatedDelivery
  ) {
    const rawEstimatedDelivery =
      cleanString(
        req.body
          ?.estimatedDelivery,
        100
      );


    if (
      rawEstimatedDelivery
    ) {
      const parsed =
        new Date(
          rawEstimatedDelivery
        );


      if (
        Number.isNaN(
          parsed.getTime()
        )
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Enter a valid estimated delivery date.",
          });
      }


      estimatedDelivery =
        parsed;

    } else {
      estimatedDelivery =
        null;
    }
  }


  try {
    const order =
      await Order
        .findOne({
          $or:
            orderLookupConditions(
              id
            ),
        })
        .populate(
          "user",
          "name email role"
        );


    if (
      !order
    ) {
      return res
        .status(404)
        .json({
          success:
            false,

          message:
            "Order not found.",
        });
    }


    if (
      order.status ===
        "cancelled" ||
      order.cancellation
        ?.status ===
        "cancelled"
    ) {
      return res
        .status(409)
        .json({
          success:
            false,

          message:
            "A cancelled order cannot move through fulfilment.",
        });
    }


    if (
      order.status ===
      "payment-pending"
    ) {
      return res
        .status(409)
        .json({
          success:
            false,

          message:
            "This order is still waiting for payment verification.",
        });
    }


    const currentIndex =
      statusFlow.indexOf(
        order.status
      );


    const nextIndex =
      statusFlow.indexOf(
        status
      );


    if (
      currentIndex ===
      -1
    ) {
      return res
        .status(409)
        .json({
          success:
            false,

          message:
            "This order has an unsupported current status.",
        });
    }


    if (
      nextIndex <
      currentIndex
    ) {
      return res
        .status(409)
        .json({
          success:
            false,

          message:
            "Order status cannot move backwards.",
        });
    }


    if (
      nextIndex >
      currentIndex +
        1
    ) {
      return res
        .status(409)
        .json({
          success:
            false,

          message:
            "Complete the current fulfilment step before moving to the next status.",
        });
    }


    const isPartialCod =
      order.payment
        ?.method ===
        "cod-partial" ||
      order.paymentMethod ===
        "cod-partial";


    const balanceDue =
      roundMoney(
        Math.max(
          0,

          Number(
            order.payment
              ?.amountDue ||
            0
          )
        )
      );


    const balancePending =
      isPartialCod &&
      order.payment
        ?.balanceStatus ===
        "pending" &&
      balanceDue >
        0;


    if (
      status ===
        "delivered" &&
      isPartialCod &&
      ![
        "partially-paid",
        "paid",
      ].includes(
        order.payment
          ?.status
      )
    ) {
      return res
        .status(409)
        .json({
          success:
            false,

          message:
            "This Cash on Delivery order does not have a verified advance payment.",
        });
    }


    if (
      status ===
        "delivered" &&
      balancePending &&
      !codBalanceCollected
    ) {
      return res
        .status(409)
        .json({
          success:
            false,

          requiresCodBalanceConfirmation:
            true,

          amountDue:
            balanceDue,

          message:
            `Confirm that the remaining ₹${balanceDue} COD balance was collected before marking this order delivered.`,
        });
    }


    const now =
      new Date();


    const statusChanged =
      order.status !==
      status;


    ensureTracking(
      order
    );


    if (
      hasCarrier
    ) {
      order.tracking.carrier =
        carrier;
    }


    if (
      hasTrackingNumber
    ) {
      order.tracking
        .trackingNumber =
        trackingNumber;
    }


    if (
      hasEstimatedDelivery
    ) {
      order.tracking
        .estimatedDelivery =
        estimatedDelivery;
    }


    if (
      status ===
      "shipped"
    ) {
      const finalCarrier =
        String(
          order.tracking
            ?.carrier ||
          ""
        ).trim();


      const finalTrackingNumber =
        String(
          order.tracking
            ?.trackingNumber ||
          ""
        ).trim();


      if (
        !finalCarrier ||
        !finalTrackingNumber
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            message:
              "Enter the carrier and tracking number before marking this order shipped.",
          });
      }
    }


    let codBalanceWasCollected =
      false;


    if (
      status ===
        "delivered" &&
      isPartialCod &&
      balancePending &&
      codBalanceCollected
    ) {
      const totalAmount =
        roundMoney(
          Number(
            order.payment
              ?.totalAmount ||
            order.pricing
              ?.finalTotal ||
            0
          )
        );


      if (
        totalAmount <=
        0
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            message:
              "The order total is invalid. COD balance cannot be recorded.",
          });
      }


      order.payment.totalAmount =
        totalAmount;


      order.payment.amountPaid =
        totalAmount;


      order.payment.amountDue =
        0;


      order.payment.balanceStatus =
        "collected";


      order.payment.balanceCollectedAt =
        now;


      order.payment.status =
        "paid";


      order.payment.paidAt =
        now;


      codBalanceWasCollected =
        true;


      order.tracking
        .events
        .push({
          status:
            "cod-balance-collected",

          description:
            `Remaining COD balance of ₹${balanceDue} collected on delivery.`,

          timestamp:
            now,
        });
    }


    order.status =
      status;


    if (
      !order.delivery
    ) {
      order.delivery =
        {};
    }


    order.delivery.status =
      status ===
      "confirmed"
        ? "pending"
        : status;


    if (
      status ===
        "delivered" &&
      !order.delivery
        .deliveredAt
    ) {
      order.delivery
        .deliveredAt =
        now;
    }


    if (
      statusChanged
    ) {
      const descriptions = {
        confirmed:
          "Order confirmed by GymDrobe.",

        processing:
          "Order is being prepared for dispatch.",

        shipped:
          "Order has been shipped.",

        "out-for-delivery":
          "Order is out for delivery.",

        delivered:
          isPartialCod
            ? "Order delivered successfully. COD payment completed."
            : "Order delivered successfully.",
      };


      order.tracking
        .events
        .push({
          status,

          description:
            descriptions[
              status
            ],

          timestamp:
            now,
        });

    } else if (
      hasCarrier ||
      hasTrackingNumber ||
      hasEstimatedDelivery
    ) {
      order.tracking
        .events
        .push({
          status:
            "tracking-updated",

          description:
            "Tracking information updated by GymDrobe.",

          timestamp:
            now,
        });
    }


    await order.save();


    let message;


    if (
      codBalanceWasCollected
    ) {
      message =
        `Order delivered and remaining COD balance of ₹${balanceDue} recorded as collected.`;

    } else if (
      statusChanged
    ) {
      message =
        `Order status updated to ${status}.`;

    } else {
      message =
        "Order tracking information updated.";
    }


    return res
      .status(200)
      .json({
        success:
          true,

        codBalanceCollected:
          codBalanceWasCollected,

        message,

        order:
          safeOrder(
            order
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Admin order update error:",
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
          "Unable to update this order.",
      });
  }
}


// ======================================================
// ADMIN — APPROVE / REJECT RETURN / EXCHANGE
// ======================================================

async function reviewReturnRequest(
  req,
  res
) {
  const id =
    cleanString(
      req.params.id,
      150
    );


  const decision =
    cleanString(
      req.body?.decision,
      20
    ).toLowerCase();


  const responseText =
    cleanString(
      req.body?.response,
      1000
    );


  if (
    ![
      "approve",
      "reject",
    ].includes(
      decision
    )
  ) {
    return res
      .status(400)
      .json({
        success:
          false,

        message:
          "Choose approve or reject.",
      });
  }


  const session =
    await mongoose
      .startSession();


  let savedOrder =
    null;


  let existingDecision =
    false;


  try {
    await session
      .withTransaction(
        async () => {
          const order =
            await Order
              .findOne({
                $or:
                  orderLookupConditions(
                    id
                  ),
              })
              .session(
                session
              );


          if (
            !order
          ) {
            throw httpError(
              404,
              "Order not found."
            );
          }


          const currentStatus =
            order.returnRequest
              ?.status;


          if (
            decision ===
              "approve" &&
            currentStatus ===
              "approved"
          ) {
            existingDecision =
              true;


            savedOrder =
              order;


            return;
          }


          if (
            decision ===
              "reject" &&
            currentStatus ===
              "rejected"
          ) {
            existingDecision =
              true;


            savedOrder =
              order;


            return;
          }


          if (
            currentStatus !==
            "requested"
          ) {
            throw httpError(
              409,
              "This request is no longer waiting for review."
            );
          }


          const type =
            order.returnRequest
              .type;


          if (
            ![
              "return",
              "exchange",
            ].includes(
              type
            )
          ) {
            throw httpError(
              409,
              "This order does not contain a valid return request."
            );
          }


          const now =
            new Date();


          if (
            decision ===
            "reject"
          ) {
            order.returnRequest
              .status =
              "rejected";


            order.returnRequest
              .response =
              responseText;


            order.returnRequest
              .respondedAt =
              now;


            order.returnRequest
              .approvedAt =
              null;


            order.returnRequest
              .rejectedAt =
              now;


            order.returnRequest
              .completedAt =
              null;


            order.returnRequest
              .originalInventoryRestoredAt =
              null;


            order.returnRequest
              .exchangeInventoryReservedAt =
              null;


            order.refund =
              blankRefund();


            ensureTracking(
              order
            );


            order.tracking
              .events
              .push({
                status:
                  type ===
                  "exchange"
                    ? "exchange-rejected"
                    : "return-rejected",

                description:
                  type ===
                  "exchange"
                    ? "Exchange request rejected by GymDrobe."
                    : "Return request rejected by GymDrobe.",

                timestamp:
                  now,
              });


            await order.save({
              session,
            });


            savedOrder =
              order;


            return;
          }


          // ==========================================
          // APPROVE EXCHANGE
          // ==========================================

          if (
            type ===
            "exchange"
          ) {
            const cache =
              new Map();


            const touched =
              new Map();


            for (
              const row
              of order.returnRequest
                .items ||
              []
            ) {
              const item =
                order.items[
                  row.index
                ];


              if (
                !item
              ) {
                throw httpError(
                  409,
                  "An exchange item is no longer valid."
                );
              }


              const product =
                await loadProductForInventory(
                  item,
                  session,
                  cache
                );


              if (
                product.isActive ===
                false
              ) {
                throw httpError(
                  409,
                  `${item.name}: This product is no longer available.`
                );
              }


              const available =
                getVariantStock(
                  product,
                  row.size ??
                    null,
                  row.color ??
                    null
                );


              if (
                available <
                row.quantity
              ) {
                throw httpError(
                  409,

                  available >
                  0
                    ? `${item.name}: Only ${available} available for the requested replacement.`
                    : `${item.name}: The requested replacement is out of stock.`
                );
              }


              reserveVariantStock(
                product,
                row.quantity,
                row.size ??
                  null,
                row.color ??
                  null
              );


              touched.set(
                String(
                  product._id
                ),
                product
              );
            }


            for (
              const product
              of touched.values()
            ) {
              await product.save({
                session,
              });
            }


            order.returnRequest
              .exchangeInventoryReservedAt =
              now;


            order.refund = {
              status:
                "not-applicable",

              amount:
                0,

              requestedAt:
                null,

              reference:
                "",

              refundedAt:
                null,
            };

          } else {
            // ========================================
            // APPROVE RETURN
            // ========================================

            const refundAmount =
              calculateReturnRefund(
                order,

                order.returnRequest
                  .items ||
                []
              );


            order.refund = {
              status:
                refundAmount >
                0
                  ? "pending"
                  : "not-applicable",

              amount:
                refundAmount,

              requestedAt:
                refundAmount >
                0
                  ? now
                  : null,

              reference:
                "",

              refundedAt:
                null,
            };
          }


          order.returnRequest
            .status =
            "approved";


          order.returnRequest
            .response =
            responseText;


          order.returnRequest
            .respondedAt =
            now;


          order.returnRequest
            .approvedAt =
            now;


          order.returnRequest
            .rejectedAt =
            null;


          order.returnRequest
            .completedAt =
            null;


          order.returnRequest
            .originalInventoryRestoredAt =
            null;


          ensureTracking(
            order
          );


          order.tracking
            .events
            .push({
              status:
                type ===
                "exchange"
                  ? "exchange-approved"
                  : "return-approved",

              description:
                type ===
                "exchange"
                  ? "Exchange request approved by GymDrobe. Replacement stock has been reserved."
                  : "Return request approved by GymDrobe.",

              timestamp:
                now,
            });


          await order.save({
            session,
          });


          savedOrder =
            order;
        }
      );


    if (
      !savedOrder
    ) {
      throw new Error(
        "Return request review failed."
      );
    }


    return res
      .status(200)
      .json({
        success:
          true,

        existing:
          existingDecision,

        message:
          existingDecision
            ? `This request is already ${savedOrder.returnRequest.status}.`
            : decision ===
              "approve"
              ? "Request approved successfully."
              : "Request rejected successfully.",

        order:
          safeOrder(
            savedOrder
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Admin return review error:",
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
          "Unable to review this request.",
      });

  } finally {
    await session
      .endSession();
  }
}


// ======================================================
// ADMIN — COMPLETE APPROVED RETURN / EXCHANGE
// ======================================================

async function completeReturnRequest(
  req,
  res
) {
  const id =
    cleanString(
      req.params.id,
      150
    );


  const responseText =
    cleanString(
      req.body?.response,
      1000
    );


  const session =
    await mongoose
      .startSession();


  let savedOrder =
    null;


  let alreadyCompleted =
    false;


  try {
    await session
      .withTransaction(
        async () => {
          const order =
            await Order
              .findOne({
                $or:
                  orderLookupConditions(
                    id
                  ),
              })
              .session(
                session
              );


          if (
            !order
          ) {
            throw httpError(
              404,
              "Order not found."
            );
          }


          if (
            order.returnRequest
              ?.status ===
            "completed"
          ) {
            alreadyCompleted =
              true;


            savedOrder =
              order;


            return;
          }


          if (
            !order.returnRequest ||
            order.returnRequest
              .status !==
              "approved"
          ) {
            throw httpError(
              409,
              "Only an approved return or exchange can be completed."
            );
          }


          const type =
            order.returnRequest
              .type;


          if (
            ![
              "return",
              "exchange",
            ].includes(
              type
            )
          ) {
            throw httpError(
              409,
              "This order does not contain a valid return request."
            );
          }


          const now =
            new Date();


          const cache =
            new Map();


          const touched =
            new Map();


          // ==========================================
          // LEGACY EXCHANGE SAFETY
          // ==========================================

          if (
            type ===
              "exchange" &&
            !order.returnRequest
              .exchangeInventoryReservedAt
          ) {
            for (
              const row
              of order.returnRequest
                .items ||
              []
            ) {
              const item =
                order.items[
                  row.index
                ];


              if (
                !item
              ) {
                throw httpError(
                  409,
                  "An exchange item is no longer valid."
                );
              }


              const product =
                await loadProductForInventory(
                  item,
                  session,
                  cache
                );


              if (
                product.isActive ===
                false
              ) {
                throw httpError(
                  409,
                  `${item.name}: This product is no longer available.`
                );
              }


              const available =
                getVariantStock(
                  product,
                  row.size ??
                    null,
                  row.color ??
                    null
                );


              if (
                available <
                row.quantity
              ) {
                throw httpError(
                  409,

                  available >
                  0
                    ? `${item.name}: Only ${available} available for the requested replacement.`
                    : `${item.name}: The requested replacement is out of stock.`
                );
              }


              reserveVariantStock(
                product,
                row.quantity,
                row.size ??
                  null,
                row.color ??
                  null
              );


              touched.set(
                String(
                  product._id
                ),
                product
              );
            }


            order.returnRequest
              .exchangeInventoryReservedAt =
              now;
          }


          // ==========================================
          // RESTORE RETURNED ORIGINAL ITEMS
          // ==========================================

          if (
            !order.returnRequest
              .originalInventoryRestoredAt
          ) {
            for (
              const row
              of order.returnRequest
                .items ||
              []
            ) {
              const item =
                order.items[
                  row.index
                ];


              if (
                !item
              ) {
                throw httpError(
                  409,
                  "A return item is no longer valid."
                );
              }


              const product =
                await loadProductForInventory(
                  item,
                  session,
                  cache
                );


              restoreVariantStock(
                product,
                row.quantity,
                item.selectedSize ??
                  null,
                item.selectedColor ??
                  null
              );


              touched.set(
                String(
                  product._id
                ),
                product
              );
            }


            order.returnRequest
              .originalInventoryRestoredAt =
              now;
          }


          for (
            const product
            of touched.values()
          ) {
            await product.save({
              session,
            });
          }


          order.returnRequest
            .status =
            "completed";


          order.returnRequest
            .completedAt =
            now;


          order.returnRequest
            .respondedAt =
            now;


          if (
            responseText
          ) {
            order.returnRequest
              .response =
              responseText;
          }


          if (
            type ===
            "return"
          ) {
            const existingAmount =
              Number(
                order.refund
                  ?.amount
              );


            const amount =
              Number.isFinite(
                existingAmount
              ) &&
              existingAmount >=
                0
                ? roundMoney(
                    existingAmount
                  )
                : calculateReturnRefund(
                    order,

                    order.returnRequest
                      .items ||
                    []
                  );


            order.refund.amount =
              amount;


            order.refund.requestedAt =
              order.refund
                ?.requestedAt ||
              order.returnRequest
                ?.approvedAt ||
              now;


            order.refund.reference =
              order.refund
                ?.reference ||
              "";


            order.refund.refundedAt =
              null;


            order.refund.status =
              amount >
              0
                ? "manual-required"
                : "not-applicable";

          } else {
            order.refund = {
              status:
                "not-applicable",

              amount:
                0,

              requestedAt:
                null,

              reference:
                "",

              refundedAt:
                null,
            };
          }


          ensureTracking(
            order
          );


          order.tracking
            .events
            .push({
              status:
                type ===
                "exchange"
                  ? "exchange-completed"
                  : "return-completed",

              description:
                type ===
                "exchange"
                  ? "Exchange completed by GymDrobe."
                  : order.refund
                      .status ===
                    "manual-required"
                    ? "Return completed by GymDrobe. Refund requires manual processing."
                    : "Return completed by GymDrobe. No refund amount is due.",

              timestamp:
                now,
            });


          await order.save({
            session,
          });


          savedOrder =
            order;
        }
      );


    if (
      !savedOrder
    ) {
      throw new Error(
        "Return request completion failed."
      );
    }


    return res
      .status(200)
      .json({
        success:
          true,

        existing:
          alreadyCompleted,

        message:
          alreadyCompleted
            ? "This request is already completed."
            : savedOrder
                .returnRequest
                ?.type ===
              "exchange"
              ? "Exchange completed successfully."
              : savedOrder
                  .refund
                  ?.status ===
                "manual-required"
                ? "Return completed. The refund now requires manual processing."
                : "Return completed successfully.",

        order:
          safeOrder(
            savedOrder
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Admin return completion error:",
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
          "Unable to complete this request.",
      });

  } finally {
    await session
      .endSession();
  }
}


// ======================================================
// ADMIN — RECORD MANUAL REFUND
// ======================================================

async function recordReturnRefund(
  req,
  res
) {
  const id =
    cleanString(
      req.params.id,
      150
    );


  const reference =
    cleanString(
      req.body?.reference,
      200
    );


  if (
    reference.length <
    3
  ) {
    return res
      .status(400)
      .json({
        success:
          false,

        message:
          "Enter a valid refund reference.",
      });
  }


  const session =
    await mongoose
      .startSession();


  let savedOrder =
    null;


  let alreadyRefunded =
    false;


  try {
    await session
      .withTransaction(
        async () => {
          const order =
            await Order
              .findOne({
                $or:
                  orderLookupConditions(
                    id
                  ),
              })
              .session(
                session
              );


          if (
            !order
          ) {
            throw httpError(
              404,
              "Order not found."
            );
          }


          if (
            order.returnRequest
              ?.type !==
            "return"
          ) {
            throw httpError(
              409,
              "Refund recording is only available for return requests."
            );
          }


          if (
            order.returnRequest
              ?.status !==
            "completed"
          ) {
            throw httpError(
              409,
              "Complete the return before recording its refund."
            );
          }


          if (
            order.refund
              ?.status ===
            "refunded"
          ) {
            alreadyRefunded =
              true;


            savedOrder =
              order;


            return;
          }


          const amount =
            Number(
              order.refund
                ?.amount ||
              0
            );


          if (
            !Number.isFinite(
              amount
            ) ||
            amount <=
              0
          ) {
            throw httpError(
              409,
              "There is no refund amount to record for this return."
            );
          }


          if (
            ![
              "pending",
              "manual-required",
            ].includes(
              order.refund
                ?.status
            )
          ) {
            throw httpError(
              409,
              "This refund is not waiting for manual processing."
            );
          }


          const now =
            new Date();


          order.refund.status =
            "refunded";


          order.refund.reference =
            reference;


          order.refund.refundedAt =
            now;


          ensureTracking(
            order
          );


          order.tracking
            .events
            .push({
              status:
                "refund-recorded",

              description:
                "Return refund recorded by GymDrobe.",

              timestamp:
                now,
            });


          await order.save({
            session,
          });


          savedOrder =
            order;
        }
      );


    if (
      !savedOrder
    ) {
      throw new Error(
        "Refund recording failed."
      );
    }


    return res
      .status(200)
      .json({
        success:
          true,

        existing:
          alreadyRefunded,

        message:
          alreadyRefunded
            ? "This refund has already been recorded."
            : "Refund recorded successfully.",

        order:
          safeOrder(
            savedOrder
          ),
      });

  } catch (
    error
  ) {
    console.error(
      "Admin refund record error:",
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
          "Unable to record this refund.",
      });

  } finally {
    await session
      .endSession();
  }
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  createOrder,

  getOrders,

  getOrderById,

  cancelOrder,

  requestReturn,

  getAdminOrders,

  getAdminOrderById,

  updateAdminOrderStatus,

  getAdminReturnRequests,

  reviewReturnRequest,

  completeReturnRequest,

  recordReturnRefund,
};