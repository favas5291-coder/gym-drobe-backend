const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const mongoose = require("mongoose");

dotenv.config();

const connectDB = require("./config/db");

const productRoutes = require("./routes/productRoutes");
const authRoutes = require("./routes/authRoutes");
const addressRoutes = require("./routes/addressRoutes");
const orderRoutes = require("./routes/orderRoutes");
const paymentRoutes = require("./routes/paymentRoutes");

const paymentWebhookRoutes = require(
  "./routes/paymentWebhookRoutes",
);

const supportRoutes = require("./routes/supportRoutes");
const adminRoutes = require("./routes/adminRoutes");
const supplierRoutes = require("./routes/supplierRoutes");
const kitRoutes = require("./routes/kitRoutes");

const packingLocationRoutes = require(
  "./routes/packingLocationRoutes",
);

const shippingProfileRoutes = require(
  "./routes/shippingProfileRoutes",
);

const shippingSettingsRoutes = require(
  "./routes/shippingSettingsRoutes",
);

const packagePlanRoutes = require(
  "./routes/packagePlanRoutes",
);

const marketingRoutes = require(
  "./routes/marketingRoutes",
);

const SupportTicket = require("./models/SupportTicket");
const Supplier = require("./models/Supplier");
const KitTemplate = require("./models/KitTemplate");
const PackingLocation = require("./models/PackingLocation");
const ShippingProfile = require("./models/ShippingProfile");
const ShippingSettings = require("./models/ShippingSettings");
const PackagePlan = require("./models/PackagePlan");

const {
  Config: MarketingConfig,
  Consent: MarketingConsent,
  Event: MarketingEvent,
  Checkpoint: MarketingCheckpoint,
  FeedChunk: MarketingFeedChunk,
} = require("./models/MarketingStore");

const {
  DEFAULTS: MARKETING_DEFAULTS,
} = require("./utils/marketing/config");

const {
  startMarketingWorker,
  stopMarketingWorker,
} = require("./utils/marketing/worker");

const app = express();

app.use(cors());

// Razorpay signature verification requires the exact raw body.
// Keep this before express.json().
app.use(
  "/api/payment-webhooks",
  express.raw({
    type: "application/json",
    limit: "1mb",
  }),
  paymentWebhookRoutes,
);

app.use(
  express.json({
    limit: "1mb",
  }),
);

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "GymDrobe API is running",
  });
});

app.use("/api/products", productRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/package-plans", packagePlanRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/kits", kitRoutes);

app.use(
  "/api/packing-locations",
  packingLocationRoutes,
);

app.use(
  "/api/shipping-profiles",
  shippingProfileRoutes,
);

app.use(
  "/api/shipping-settings",
  shippingSettingsRoutes,
);

app.use("/api/marketing", marketingRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found.",
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status =
    error.type === "entity.too.large"
      ? 413
      : error.type === "entity.parse.failed"
        ? 400
        : 500;

  res.status(status).json({
    success: false,
    message:
      status === 413
        ? "Request is too large."
        : status === 400
          ? "Invalid JSON request."
          : "The server could not complete the request.",
  });
});

const PORT = process.env.PORT || 5000;

let server = null;
let startup = null;
let stopping = null;
let shuttingDown = false;
let marketingRetry = null;

async function initializeMarketing(attempt = 1) {
  if (shuttingDown) return;

  try {
    await Promise.all(
      [
        MarketingConfig,
        MarketingConsent,
        MarketingEvent,
        MarketingCheckpoint,
        MarketingFeedChunk,
      ].map((model) =>
        model.createIndexes({
          maxTimeMS: 10000,
        }),
      ),
    );

    if (shuttingDown) return;

    // Insert disabled defaults only when no configuration exists.
    // Preserve settings previously saved by an admin.
    try {
      await MarketingConfig.updateOne(
        {
          _id: "meta",
        },
        {
          $setOnInsert: {
            ...MARKETING_DEFAULTS,
            allowedEvents: [],
          },

          $set: {
            lastWorkerError: "",
          },
        },
        {
          upsert: true,
          runValidators: true,
          maxTimeMS: 2000,
        },
      );
    } catch (error) {
      // Another instance may have inserted the configuration.
      if (error.code !== 11000) {
        throw error;
      }
    }

    if (
      !shuttingDown &&
      server?.listening
    ) {
      startMarketingWorker();
    }
  } catch {
    // Optional marketing setup must not stop shopping.
    // Do not log credentials, event payloads or database messages.
    console.error(
      "Marketing setup paused. Shopping remains available.",
    );

    if (
      !shuttingDown &&
      MarketingConfig.db.readyState === 1
    ) {
      await MarketingConfig.updateOne(
        {
          _id: "meta",
        },
        {
          $set: {
            lastWorkerError:
              "MARKETING_WORKER_UNAVAILABLE",
          },
        },
        {
          maxTimeMS: 2000,
        },
      ).catch(() => {});
    }

    // Retry temporary setup failures at most twice.
    if (
      !shuttingDown &&
      attempt < 3
    ) {
      marketingRetry = setTimeout(
        () => {
          marketingRetry = null;

          void initializeMarketing(
            attempt + 1,
          );
        },
        60000,
      );

      marketingRetry.unref?.();
    }
  }
}

async function boot() {
  await connectDB();

  if (shuttingDown) {
    throw new Error(
      "SERVER_STOPPING",
    );
  }

  await SupportTicket.createIndexes();
  await Supplier.createIndexes();
  await KitTemplate.createIndexes();
  await PackingLocation.createIndexes();
  await ShippingProfile.createIndexes();
  await ShippingSettings.createIndexes();
  await PackagePlan.createIndexes();

  if (shuttingDown) {
    throw new Error(
      "SERVER_STOPPING",
    );
  }

  await new Promise(
    (resolve, reject) => {
      server = app.listen(PORT);

      const onError = (error) => {
        server.off(
          "listening",
          onReady,
        );

        reject(error);
      };

      const onReady = () => {
        server.off(
          "error",
          onError,
        );

        resolve();
      };

      server.once(
        "error",
        onError,
      );

      server.once(
        "listening",
        onReady,
      );
    },
  );

  console.log(
    `GymDrobe server running on http://localhost:${PORT}`,
  );

  // Serve shopping first. Start marketing after its indexes are ready.
  void initializeMarketing();

  return server;
}

function startServer() {
  if (shuttingDown) {
    return Promise.reject(
      new Error(
        "SERVER_STOPPING",
      ),
    );
  }

  if (!startup) {
    startup = boot();
  }

  return startup;
}

function shutdown() {
  if (stopping) {
    return stopping;
  }

  shuttingDown = true;

  if (marketingRetry) {
    clearTimeout(
      marketingRetry,
    );

    marketingRetry = null;
  }

  stopMarketingWorker();

  stopping = (async () => {
    const deadline = setTimeout(
      () => {
        server?.closeAllConnections?.();
      },
      25000,
    );

    deadline.unref?.();

    try {
      // Finish pending startup before disconnecting MongoDB.
      // boot() checks shuttingDown before opening the listener.
      await startup?.catch(
        () => {},
      );

      if (server?.listening) {
        await new Promise(
          (resolve, reject) => {
            server.close(
              (error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              },
            );
          },
        );
      }
    } finally {
      try {
        await mongoose.disconnect();
      } finally {
        clearTimeout(
          deadline,
        );
      }
    }
  })();

  return stopping;
}

if (
  require.main === module
) {
  const stop = () => {
    void shutdown().catch(
      () => {
        console.error(
          "Server shutdown could not finish cleanly.",
        );

        process.exitCode = 1;
      },
    );
  };

  process.once(
    "SIGTERM",
    stop,
  );

  process.once(
    "SIGINT",
    stop,
  );

  startServer().catch(
    async () => {
      console.error(
        "Server startup failed. Check database connectivity, required indexes and the configured port.",
      );

      process.exitCode = 1;

      await shutdown().catch(
        () => {},
      );
    },
  );
}

module.exports = {
  app,
  startServer,
  shutdown,
};