const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const connectDB = require("./config/db");

const productRoutes = require("./routes/productRoutes");
const authRoutes = require("./routes/authRoutes");
const addressRoutes = require("./routes/addressRoutes");
const orderRoutes = require("./routes/orderRoutes");
const paymentRoutes = require("./routes/paymentRoutes");

const paymentWebhookRoutes = require(
  "./routes/paymentWebhookRoutes"
);

const supportRoutes = require("./routes/supportRoutes");
const adminRoutes = require("./routes/adminRoutes");
const supplierRoutes = require("./routes/supplierRoutes");

const SupportTicket = require("./models/SupportTicket");
const Supplier = require("./models/Supplier");

const app = express();

app.use(cors());

// Razorpay needs the exact raw request body.
// Keep this route before express.json().
app.use(
  "/api/payment-webhooks",
  express.raw({
    type: "application/json",
    limit: "1mb",
  }),
  paymentWebhookRoutes
);

app.use(
  express.json({
    limit: "1mb",
  })
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
app.use("/api/suppliers", supplierRoutes);

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

async function startServer() {
  try {
    await connectDB();

    await SupportTicket.createIndexes();
    await Supplier.createIndexes();

    app.listen(PORT, () => {
      console.log(
        `GymDrobe server running on http://localhost:${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Server startup failed:",
      error.message
    );

    console.error(error);
    process.exit(1);
  }
}

startServer();