const mongoose =
  require("mongoose");


// ======================================================
// ORDER ITEM
// ======================================================

const orderItemSchema =
  new mongoose.Schema(
    {
      product: {
        type:
          mongoose.Schema.Types
            .ObjectId,

        ref:
          "Product",

        required:
          true,
      },


      legacyId: {
        type:
          Number,

        default:
          null,
      },


      slug: {
        type:
          String,

        default:
          "",
      },


      sku: {
        type:
          String,

        default:
          "",
      },


      name: {
        type:
          String,

        required:
          true,
      },


      brand: {
        type:
          String,

        default:
          "",
      },


      image: {
        type:
          String,

        default:
          "",
      },


      originalPrice: {
        type:
          Number,

        required:
          true,

        min:
          0,
      },


      price: {
        type:
          Number,

        required:
          true,

        min:
          0,
      },


      discount: {
        type:
          Number,

        default:
          0,

        min:
          0,

        max:
          100,
      },


      quantity: {
        type:
          Number,

        required:
          true,

        min:
          1,
      },


      selectedSize: {
        type:
          String,

        default:
          null,
      },


      selectedColor: {
        type:
          String,

        default:
          null,
      },


      returnPolicy: {
        type:
          String,

        default:
          "",
      },
    },

    {
      _id:
        false,
    }
  );


// ======================================================
// SHIPPING ADDRESS
// ======================================================

const shippingAddressSchema =
  new mongoose.Schema(
    {
      fullName: {
        type:
          String,

        required:
          true,
      },


      name: {
        type:
          String,

        required:
          true,
      },


      email: {
        type:
          String,

        required:
          true,
      },


      phone: {
        type:
          String,

        required:
          true,
      },


      addressLine: {
        type:
          String,

        required:
          true,
      },


      landmark: {
        type:
          String,

        default:
          "",
      },


      city: {
        type:
          String,

        required:
          true,
      },


      state: {
        type:
          String,

        required:
          true,
      },


      pincode: {
        type:
          String,

        required:
          true,
      },


      label: {
        type:
          String,

        default:
          "Home",
      },
    },

    {
      _id:
        false,
    }
  );


// ======================================================
// PRICING
// ======================================================

const pricingSchema =
  new mongoose.Schema(
    {
      subtotal: {
        type:
          Number,

        required:
          true,

        min:
          0,
      },


      couponDiscount: {
        type:
          Number,

        default:
          0,

        min:
          0,
      },


      totalAfterCoupon: {
        type:
          Number,

        required:
          true,

        min:
          0,
      },


      shipping: {
        type:
          Number,

        required:
          true,

        min:
          0,
      },


      finalTotal: {
        type:
          Number,

        required:
          true,

        min:
          0,
      },


      currency: {
        type:
          String,

        default:
          "INR",
      },
    },

    {
      _id:
        false,
    }
  );


// ======================================================
// TRACKING EVENT
// ======================================================

const trackingEventSchema =
  new mongoose.Schema(
    {
      status: {
        type:
          String,

        required:
          true,
      },


      description: {
        type:
          String,

        default:
          "",
      },


      timestamp: {
        type:
          Date,

        default:
          Date.now,
      },
    },

    {
      _id:
        false,
    }
  );


// ======================================================
// RETURN / EXCHANGE ITEM
// ======================================================

const returnItemSchema =
  new mongoose.Schema(
    {
      index: {
        type:
          Number,

        required:
          true,

        min:
          0,
      },


      quantity: {
        type:
          Number,

        required:
          true,

        min:
          1,
      },


      size: {
        type:
          String,

        default:
          null,
      },


      color: {
        type:
          String,

        default:
          null,
      },
    },

    {
      _id:
        false,
    }
  );


// ======================================================
// RETURN / EXCHANGE REQUEST
// ======================================================

const returnRequestSchema =
  new mongoose.Schema(
    {
      id: {
        type:
          String,

        default:
          null,
      },


      type: {
        type:
          String,

        default:
          null,

        validate: {
          validator(
            value
          ) {
            return (
              value ==
                null ||
              [
                "return",
                "exchange",
              ].includes(
                value
              )
            );
          },

          message:
            "Invalid return request type.",
        },
      },


      status: {
        type:
          String,

        enum: [
          "not-requested",
          "requested",
          "approved",
          "rejected",
          "completed",
        ],

        default:
          "not-requested",
      },


      items: {
        type: [
          returnItemSchema,
        ],

        default:
          [],
      },


      reason: {
        type:
          String,

        default:
          "",

        maxlength:
          1000,
      },


      requestedAt: {
        type:
          Date,

        default:
          null,
      },


      response: {
        type:
          String,

        default:
          "",

        maxlength:
          1000,
      },


      respondedAt: {
        type:
          Date,

        default:
          null,
      },


      approvedAt: {
        type:
          Date,

        default:
          null,
      },


      rejectedAt: {
        type:
          Date,

        default:
          null,
      },


      completedAt: {
        type:
          Date,

        default:
          null,
      },


      originalInventoryRestoredAt: {
        type:
          Date,

        default:
          null,
      },


      exchangeInventoryReservedAt: {
        type:
          Date,

        default:
          null,
      },
    },

    {
      _id:
        false,
    }
  );


// ======================================================
// REFUND
// ======================================================

const refundSchema =
  new mongoose.Schema(
    {
      status: {
        type:
          String,

        enum: [
          "not-requested",
          "pending",
          "manual-required",
          "refunded",
          "not-applicable",
        ],

        default:
          "not-requested",
      },


      amount: {
        type:
          Number,

        default:
          0,

        min:
          0,
      },


      reference: {
        type:
          String,

        default:
          "",

        maxlength:
          200,
      },


      requestedAt: {
        type:
          Date,

        default:
          null,
      },


      refundedAt: {
        type:
          Date,

        default:
          null,
      },
    },

    {
      _id:
        false,
    }
  );


// ======================================================
// PAYMENT
// ======================================================

const paymentSchema =
  new mongoose.Schema(
    {
      // ==================================================
      // PAYMENT METHOD
      //
      // cod
      // Legacy normal COD orders.
      //
      // razorpay
      // Customer pays full amount online.
      //
      // cod-partial
      // Customer pays 10% online and remaining amount
      // during delivery.
      // ==================================================

      method: {
        type:
          String,

        enum: [
          "cod",
          "razorpay",
          "cod-partial",
        ],

        default:
          "cod",
      },


      // ==================================================
      // PAYMENT GATEWAY
      // ==================================================

      gateway: {
        type:
          String,

        enum: [
          "cod",
          "razorpay",
        ],

        default:
          "cod",
      },


      // ==================================================
      // PAYMENT STATUS
      //
      // pending
      // Nothing successfully paid yet.
      //
      // partially-paid
      // COD advance was successfully paid.
      //
      // paid
      // Full payment completed.
      //
      // failed
      // Online payment failed.
      //
      // refunded
      // Payment was fully refunded.
      // ==================================================

      status: {
        type:
          String,

        enum: [
          "pending",
          "partially-paid",
          "paid",
          "failed",
          "refunded",
        ],

        default:
          "pending",
      },


      // ==================================================
      // TOTAL ORDER AMOUNT
      //
      // Complete amount customer owes including
      // applicable shipping.
      // ==================================================

      totalAmount: {
        type:
          Number,

        default:
          0,

        min:
          0,
      },


      // ==================================================
      // AMOUNT ALREADY PAID
      // ==================================================

      amountPaid: {
        type:
          Number,

        default:
          0,

        min:
          0,
      },


      // ==================================================
      // AMOUNT STILL TO COLLECT
      // ==================================================

      amountDue: {
        type:
          Number,

        default:
          0,

        min:
          0,
      },


      // ==================================================
      // COD ADVANCE PERCENTAGE
      //
      // GymDrobe currently plans to use 10%.
      // Backend calculation will control this value.
      // ==================================================

      advancePercentage: {
        type:
          Number,

        default:
          0,

        min:
          0,

        max:
          100,
      },


      // ==================================================
      // COD ADVANCE AMOUNT
      // ==================================================

      advanceAmount: {
        type:
          Number,

        default:
          0,

        min:
          0,
      },


      // ==================================================
      // ADVANCE PAYMENT TIME
      // ==================================================

      advancePaidAt: {
        type:
          Date,

        default:
          null,
      },


      // ==================================================
      // REMAINING COD BALANCE
      //
      // not-applicable
      // Full online payment or legacy normal COD.
      //
      // pending
      // Advance paid, balance must be collected.
      //
      // collected
      // Delivery balance collected.
      //
      // waived
      // Admin intentionally removed balance.
      // ==================================================

      balanceStatus: {
        type:
          String,

        enum: [
          "not-applicable",
          "pending",
          "collected",
          "waived",
        ],

        default:
          "not-applicable",
      },


      // ==================================================
      // BALANCE COLLECTION TIME
      // ==================================================

      balanceCollectedAt: {
        type:
          Date,

        default:
          null,
      },


      // ==================================================
      // GENERIC TRANSACTION ID
      //
      // For Razorpay this stores Razorpay Payment ID.
      // ==================================================

      transactionId: {
        type:
          String,

        default:
          null,

        trim:
          true,
      },


      // ==================================================
      // RAZORPAY ORDER ID
      // ==================================================

      razorpayOrderId: {
        type:
          String,

        default:
          null,

        trim:
          true,
      },


      // ==================================================
      // RAZORPAY PAYMENT ID
      // ==================================================

      razorpayPaymentId: {
        type:
          String,

        default:
          null,

        trim:
          true,
      },


      // ==================================================
      // SERVER VERIFICATION TIME
      // ==================================================

      verifiedAt: {
        type:
          Date,

        default:
          null,
      },


      // ==================================================
      // FULL PAYMENT TIME
      //
      // For full Razorpay orders, set when fully paid.
      //
      // For cod-partial orders, advancePaidAt is used for
      // the 10% online payment and paidAt can later be set
      // when the remaining COD balance is collected.
      // ==================================================

      paidAt: {
        type:
          Date,

        default:
          null,
      },


      // ==================================================
      // FAILED PAYMENT TIME
      // ==================================================

      failedAt: {
        type:
          Date,

        default:
          null,
      },
    },

    {
      _id:
        false,
    }
  );


// ======================================================
// ORDER
// ======================================================

const orderSchema =
  new mongoose.Schema(
    {
      // ==================================================
      // IDENTIFIERS
      // ==================================================

      orderNumber: {
        type:
          String,

        required:
          true,

        unique:
          true,

        index:
          true,
      },


      user: {
        type:
          mongoose.Schema.Types
            .ObjectId,

        ref:
          "User",

        required:
          true,

        index:
          true,
      },


      checkoutToken: {
        type:
          String,

        required:
          true,

        trim:
          true,
      },


      // ==================================================
      // CHECKOUT SOURCE
      // ==================================================

      source: {
        type:
          String,

        enum: [
          "cart",
          "selection",
          "buy-now",
        ],

        default:
          "cart",
      },


      // ==================================================
      // ORDER STATUS
      //
      // payment-pending:
      // Waiting for required Razorpay payment.
      //
      // confirmed:
      // Payment requirement completed and order accepted.
      // ==================================================

      status: {
        type:
          String,

        enum: [
          "payment-pending",
          "confirmed",
          "processing",
          "shipped",
          "out-for-delivery",
          "delivered",
          "cancelled",
        ],

        default:
          "confirmed",

        index:
          true,
      },


      // ==================================================
      // OPTIONAL ORDER MESSAGES
      // ==================================================

      giftMessage: {
        type:
          String,

        default:
          "",

        maxlength:
          250,
      },


      orderNote: {
        type:
          String,

        default:
          "",

        maxlength:
          300,
      },


      // ==================================================
      // CUSTOMER SNAPSHOT
      // ==================================================

      customer: {
        name: {
          type:
            String,

          required:
            true,
        },


        email: {
          type:
            String,

          required:
            true,
        },


        phone: {
          type:
            String,

          required:
            true,
        },
      },


      // ==================================================
      // SHIPPING ADDRESS
      // ==================================================

      shippingAddress: {
        type:
          shippingAddressSchema,

        required:
          true,
      },


      // ==================================================
      // ORDER ITEMS
      // ==================================================

      items: {
        type: [
          orderItemSchema,
        ],

        required:
          true,

        validate: {
          validator(
            value
          ) {
            return (
              Array.isArray(
                value
              ) &&
              value.length >
                0
            );
          },

          message:
            "Order must contain at least one item.",
        },
      },


      // ==================================================
      // PRICING
      // ==================================================

      pricing: {
        type:
          pricingSchema,

        required:
          true,
      },


      // ==================================================
      // COUPON
      // ==================================================

      coupon: {
        code: {
          type:
            String,

          default:
            null,
        },


        type: {
          type:
            String,

          default:
            null,
        },


        value: {
          type:
            Number,

          default:
            null,
        },


        minimum: {
          type:
            Number,

          default:
            null,
        },
      },


      // ==================================================
      // PAYMENT
      // ==================================================

      payment: {
        type:
          paymentSchema,

        default:
          () => ({
            method:
              "cod",

            gateway:
              "cod",

            status:
              "pending",

            totalAmount:
              0,

            amountPaid:
              0,

            amountDue:
              0,

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
          }),
      },


      // ==================================================
      // LEGACY / FRONTEND PAYMENT METHOD
      //
      // Kept because existing customer and admin pages
      // already read order.paymentMethod.
      // ==================================================

      paymentMethod: {
        type:
          String,

        enum: [
          "cod",
          "razorpay",
          "cod-partial",
        ],

        default:
          "cod",
      },


      // ==================================================
      // DELIVERY
      // ==================================================

      delivery: {
        method: {
          type:
            String,

          enum: [
            "standard",
            "express",
          ],

          default:
            "standard",
        },


        status: {
          type:
            String,

          default:
            "pending",
        },


        label: {
          type:
            String,

          default:
            "Standard delivery",
        },


        estimatedTime: {
          type:
            String,

          default:
            null,
        },


        // Returns use actual delivery date.
        deliveredAt: {
          type:
            Date,

          default:
            null,
        },
      },


      deliveryMethod: {
        type:
          String,

        enum: [
          "standard",
          "express",
        ],

        default:
          "standard",
      },


      // ==================================================
      // TRACKING
      // ==================================================

      tracking: {
        carrier: {
          type:
            String,

          default:
            null,
        },


        trackingNumber: {
          type:
            String,

          default:
            null,
        },


        estimatedDelivery: {
          type:
            Date,

          default:
            null,
        },


        events: {
          type: [
            trackingEventSchema,
          ],

          default:
            [],
        },
      },


      // ==================================================
      // CANCELLATION
      // ==================================================

      cancellation: {
        status: {
          type:
            String,

          enum: [
            "not-cancelled",
            "cancelled",
          ],

          default:
            "not-cancelled",
        },


        reason: {
          type:
            String,

          default:
            "",

          maxlength:
            500,
        },


        cancelledAt: {
          type:
            Date,

          default:
            null,
        },


        inventoryRestoredAt: {
          type:
            Date,

          default:
            null,
        },
      },


      // ==================================================
      // RETURN / EXCHANGE
      // ==================================================

      returnRequest: {
        type:
          returnRequestSchema,

        default:
          () => ({}),
      },


      // ==================================================
      // REFUND
      // ==================================================

      refund: {
        type:
          refundSchema,

        default:
          () => ({}),
      },


      // ==================================================
      // METADATA
      // ==================================================

      metadata: {
        version: {
          type:
            String,

          default:
            "7.0",
        },


        demo: {
          type:
            Boolean,

          default:
            true,
        },


        /*
          inventoryReserved prevents the same order from
          reducing stock more than once.

          COD:
          Existing COD controller may reserve immediately.

          Full Razorpay:
          Reserve after verified payment.

          10% advance COD:
          Reserve after the 10% Razorpay payment has been
          successfully verified.
        */

        inventoryReserved: {
          type:
            Boolean,

          default:
            false,
        },
      },
    },

    {
      timestamps:
        true,
    }
  );


// ======================================================
// INDEXES
// ======================================================

orderSchema.index(
  {
    user:
      1,

    checkoutToken:
      1,
  },

  {
    unique:
      true,
  }
);


orderSchema.index({
  user:
    1,

  createdAt:
    -1,
});


orderSchema.index({
  "returnRequest.status":
    1,

  "returnRequest.requestedAt":
    -1,
});


/*
  Find a GymDrobe order from a Razorpay Order ID.
*/

orderSchema.index(
  {
    "payment.razorpayOrderId":
      1,
  },

  {
    sparse:
      true,
  }
);


/*
  Useful for payment reconciliation and admin tools.
*/

orderSchema.index({
  "payment.status":
    1,

  createdAt:
    -1,
});


/*
  Useful for finding outstanding COD balances.

  Example:
  payment.method = cod-partial
  payment.balanceStatus = pending
*/

orderSchema.index({
  "payment.method":
    1,

  "payment.balanceStatus":
    1,

  createdAt:
    -1,
});


// ======================================================
// MODEL
// ======================================================

const Order =
  mongoose.model(
    "Order",
    orderSchema
  );


module.exports =
  Order;