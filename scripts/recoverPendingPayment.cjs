"use strict";

const path = require("node:path");

async function main(argv = process.argv.slice(2)) {
  let mongoose;

  try {
    const apply = argv.includes("--apply");

    const args = argv.filter(
      (value) => value !== "--apply",
    );

    if (
      args.length !== 2 ||
      args[0] !== "--order" ||
      !/^GD-[A-Z0-9-]{3,140}$/.test(args[1]) ||
      argv.filter(
        (value) => value === "--apply",
      ).length > 1
    ) {
      throw Object.assign(new Error(), {
        code: "USE_ORDER_NUMBER_WITH_OPTIONAL_APPLY",
      });
    }

    require("dotenv").config({
      path: path.resolve(__dirname, "../.env"),
      quiet: true,
    });

    if (!process.env.MONGO_URI) {
      throw Object.assign(new Error(), {
        code: "MONGO_URI_MISSING",
      });
    }

    mongoose = require("mongoose");

    const Order = require("../models/Order");

    const {
      recoverOrderPayment,
    } = require("../utils/paymentRecovery");

    await mongoose.connect(
      process.env.MONGO_URI,
      {
        serverSelectionTimeoutMS: 10000,
        autoIndex: false,
        autoCreate: false,
      },
    );

    const order = await Order.findOne({
      orderNumber: args[1],
    }).maxTimeMS(5000);

    const result = await recoverOrderPayment(
      order,
      { apply },
    );

    console.log(
      JSON.stringify(
        {
          readOnly: !apply,
          result,
        },
        null,
        2,
      ),
    );

    if (!apply && result.state === "captured") {
      console.log(
        "Provider capture matches. Rerun the same command with --apply to reconcile this existing order through the normal inventory/payment flow.",
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          success: false,

          code: /^[A-Z0-9_]{1,100}$/.test(
            error.code || "",
          )
            ? error.code
            : "PAYMENT_RECOVERY_FAILED",

          message:
            "Do not pay again. Share this redacted report with support; never share .env, API secrets or database credentials.",
        },
        null,
        2,
      ),
    );

    process.exitCode = 1;
  } finally {
    if (mongoose) {
      await mongoose
        .disconnect()
        .catch(() => {});
    }
  }
}

module.exports = {
  main,
};

if (require.main === module) {
  void main();
}