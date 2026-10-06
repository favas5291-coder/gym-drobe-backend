const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const connectDB = require("./config/db");

const productRoutes = require(
  "./routes/productRoutes",
);

const authRoutes = require(
  "./routes/authRoutes",
);

const addressRoutes = require(
  "./routes/addressRoutes",
);

const orderRoutes = require(
  "./routes/orderRoutes",
);

const paymentRoutes = require(
  "./routes/paymentRoutes",
);

const paymentWebhookRoutes = require(
  "./routes/paymentWebhookRoutes",
);

const supportRoutes = require(
  "./routes/supportRoutes",
);

const SupportTicket = require(
  "./models/SupportTicket",
);

const app = express();

app.use(cors());

// Webhooks must receive the exact raw body.
// Keep this BEFORE express.json().
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

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      message: "GymDrobe API is running",
    });
  },
);

app.use(
  "/api/products",
  productRoutes,
);

app.use(
  "/api/auth",
  authRoutes,
);

app.use(
  "/api/addresses",
  addressRoutes,
);

app.use(
  "/api/orders",
  orderRoutes,
);

app.use(
  "/api/payments",
  paymentRoutes,
);

app.use(
  "/api/support",
  supportRoutes,
);

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

const PORT =
  process.env.PORT || 5000;

async function startServer() {
  try {
    await connectDB();

    // Create the unique index before accepting
    // support requests, so retries are deduplicated.
    await SupportTicket.createIndexes();

    app.listen(PORT, () => {
      console.log(
        `GymDrobe server running on http://localhost:${PORT}`,
      );
    });
    } catch (error) {
    console.error(
      "Server startup failed:",
      error.message,
    );

    console.error(error);

    process.exit(1);
  }
}

startServer();