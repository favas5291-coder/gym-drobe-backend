const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

const connectDB = require("../config/db");
const Order = require("../models/Order");


// ======================================================
// DEVELOPMENT-ONLY TEST HELPER
//
// Usage:
//
// node scripts/markOrderDelivered.js GD-ORDER-NUMBER
//
// Example:
//
// node scripts/markOrderDelivered.js GD-MABC123-XYZ789
// ======================================================

async function markOrderDelivered() {
  const orderNumber =
    String(
      process.argv[2] || ""
    ).trim();


  // ====================================================
  // BLOCK PRODUCTION USE
  // ====================================================

  if (
    process.env.NODE_ENV ===
    "production"
  ) {
    console.error(
      "❌ This test script cannot run in production."
    );

    process.exitCode = 1;

    return;
  }


  // ====================================================
  // REQUIRE ORDER NUMBER
  // ====================================================

  if (!orderNumber) {
    console.error(
      "❌ Please provide an order number."
    );

    console.log(
      "\nExample:"
    );

    console.log(
      "node scripts/markOrderDelivered.js GD-MABC123-XYZ789"
    );

    process.exitCode = 1;

    return;
  }


  try {
    console.log(
      "Connecting to MongoDB..."
    );


    await connectDB();


    // ==================================================
    // FIND ORDER
    // ==================================================

    const order =
      await Order.findOne({
        orderNumber,
      });


    if (!order) {
      console.error(
        `❌ Order not found: ${orderNumber}`
      );

      process.exitCode = 1;

      return;
    }


    // ==================================================
    // DON'T MODIFY CANCELLED ORDERS
    // ==================================================

    if (
      order.status ===
      "cancelled"
    ) {
      console.error(
        "❌ A cancelled order cannot be marked as delivered."
      );

      process.exitCode = 1;

      return;
    }


    const now =
      new Date();


    // ==================================================
    // ORDER STATUS
    // ==================================================

    order.status =
      "delivered";


    // ==================================================
    // DELIVERY DATA
    // ==================================================

    if (!order.delivery) {
      order.delivery = {};
    }


    order.delivery.status =
      "delivered";


    order.delivery.deliveredAt =
      now;


    // ==================================================
    // TRACKING
    // ==================================================

    if (!order.tracking) {
      order.tracking = {
        carrier: null,

        trackingNumber: null,

        estimatedDelivery: null,

        events: [],
      };
    }


    if (
      !Array.isArray(
        order.tracking.events
      )
    ) {
      order.tracking.events =
        [];
    }


    /*
      Remove an old delivered event first.

      This keeps this development helper repeatable
      without adding many duplicate delivered events.
    */

    order.tracking.events =
      order.tracking.events.filter(
        (event) =>
          event.status !==
          "delivered"
      );


    order.tracking.events.push({
      status:
        "delivered",

      description:
        "Order marked as delivered for development testing.",

      timestamp:
        now,
    });


    // ==================================================
    // SAVE
    // ==================================================

    await order.save();


    console.log(
      "\n✅ Test order marked as delivered."
    );


    console.log(
      `Order: ${order.orderNumber}`
    );


    console.log(
      `Status: ${order.status}`
    );


    console.log(
      `Delivered at: ${now.toISOString()}`
    );


    console.log(
      "\nYou can now test the 7-day return/exchange flow."
    );

  } catch (error) {
    console.error(
      "\n❌ Unable to mark order as delivered:"
    );

    console.error(
      error.message
    );


    process.exitCode = 1;

  } finally {
    if (
      mongoose.connection
        .readyState !== 0
    ) {
      await mongoose.disconnect();
    }
  }
}


markOrderDelivered();