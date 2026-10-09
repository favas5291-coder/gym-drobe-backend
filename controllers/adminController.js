const User = require("../models/User");
const Product = require("../models/Product");
const Order = require("../models/Order");
const SupportTicket = require("../models/SupportTicket");

function inputError(message) {
  return Object.assign(new Error(message), {
    status: 400,
  });
}

function integer(value, fallback, maximum, label) {
  if (value === undefined) return fallback;

  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value)
  ) {
    throw inputError(`Choose a valid ${label}.`);
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed > maximum
  ) {
    throw inputError(`Choose a valid ${label}.`);
  }

  return parsed;
}

function sendError(res, error) {
  if (error.status === 400) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  console.error(
    "Admin data request failed:",
    error.name || "Error",
  );

  return res.status(503).json({
    success: false,
    message:
      "Admin information could not be loaded. Please retry.",
  });
}

// GET /api/admin/dashboard
async function getDashboard(req, res) {
  try {
    const [
      customers,
      activeProducts,
      lowStockProducts,
      outOfStockProducts,
      orders,
      pendingPayments,
      openOrders,
      pendingReturns,
      openSupport,
      testOrders,
      recentOrders,
    ] = await Promise.all([
      User.countDocuments({
        role: "customer",
      }),

      Product.countDocuments({
        isActive: { $ne: false },
      }),

      Product.countDocuments({
        isActive: { $ne: false },
        stock: { $gt: 0, $lte: 10 },
      }),

      Product.countDocuments({
        isActive: { $ne: false },
        stock: { $lte: 0 },
      }),

      Order.countDocuments({}),

      Order.countDocuments({
        status: "payment-pending",
      }),

      Order.countDocuments({
        status: {
          $in: [
            "confirmed",
            "processing",
            "shipped",
            "out-for-delivery",
          ],
        },
      }),

      Order.countDocuments({
        "returnRequest.status": {
          $in: ["requested", "approved"],
        },
      }),

      SupportTicket.countDocuments({
        status: {
          $in: ["open", "waiting"],
        },
      }),

      Order.countDocuments({
        "metadata.demo": true,
      }),

      Order.find({})
        .select(
          "orderNumber customer.name status payment.status createdAt",
        )
        .sort({
          createdAt: -1,
          _id: -1,
        })
        .limit(5)
        .lean(),
    ]);

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),

      stats: {
        customers,
        activeProducts,
        lowStockProducts,
        outOfStockProducts,
        orders,
        pendingPayments,
        openOrders,
        pendingReturns,
        openSupport,
        testOrders,
      },

      recentOrders: recentOrders.map((order) => ({
        orderNumber: order.orderNumber,
        customerName:
          order.customer?.name || "Customer",
        status: order.status,
        paymentStatus:
          order.payment?.status || "pending",
        createdAt: order.createdAt,
      })),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

// GET /api/admin/customers
async function getCustomers(req, res) {
  try {
    const page = integer(
      req.query.page,
      1,
      10000,
      "page number",
    );

    const limit = integer(
      req.query.limit,
      25,
      100,
      "page size",
    );

    const search = req.query.search ?? "";
    const status = req.query.status ?? "";

    if (
      typeof search !== "string" ||
      search.length > 80
    ) {
      throw inputError(
        "Search must contain no more than 80 characters.",
      );
    }

    if (
      !["", "active", "disabled"].includes(status)
    ) {
      throw inputError(
        "Choose active, disabled or all customers.",
      );
    }

    const query = {
      role: "customer",
    };

    if (status === "active") {
      query.isActive = { $ne: false };
    }

    if (status === "disabled") {
      query.isActive = false;
    }

    const term = search.trim();

    if (term) {
      // Search text is treated literally.
      const escaped = term.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );

      query.$or = [
        "name",
        "email",
        "phone",
      ].map((field) => ({
        [field]: {
          $regex: escaped,
          $options: "i",
        },
      }));
    }

    const [total, users] = await Promise.all([
      User.countDocuments(query),

      User.find(query)
        .select(
          "_id name email phone isActive createdAt",
        )
        .sort({
          createdAt: -1,
          _id: -1,
        })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const orderCounts = users.length
      ? await Order.aggregate([
          {
            $match: {
              user: {
                $in: users.map(
                  (user) => user._id,
                ),
              },
            },
          },
          {
            $group: {
              _id: "$user",
              count: { $sum: 1 },
            },
          },
        ])
      : [];

    const counts = new Map(
      orderCounts.map((row) => [
        String(row._id),
        row.count,
      ]),
    );

    return res.json({
      success: true,

      customers: users.map((user) => ({
        id: String(user._id),
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        isActive: user.isActive !== false,
        createdAt: user.createdAt,
        orderCount:
          counts.get(String(user._id)) || 0,
      })),

      total,
      page,
      pages: Math.max(
        1,
        Math.ceil(total / limit),
      ),
      limit,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = {
  getDashboard,
  getCustomers,
};