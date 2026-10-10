const mongoose = require("mongoose");
const User = require("../models/User");
const Product = require("../models/Product");
const Order = require("../models/Order");
const SupportTicket = require("../models/SupportTicket");

const TIMEOUT = 10000;
const DAY = 86400000;
const IST = 330 * 60000;

const CUSTOMER_FIELDS =
  "_id name email phone isActive createdAt";

function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

function text(value, label, maximum) {
  if (value === undefined) return "";

  if (
    typeof value !== "string" ||
    value.trim().length > maximum
  ) {
    throw problem(400, "Check " + label + ".");
  }

  return value.trim();
}

function integer(value, fallback, maximum) {
  if (value === undefined) return fallback;

  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value)
  ) {
    throw problem(
      400,
      "Page and limit must be positive whole numbers.",
    );
  }

  const number = Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number > maximum
  ) {
    throw problem(
      400,
      "Page or limit exceeds the supported range.",
    );
  }

  return number;
}

function failure(res, error) {
  const status = [400, 403, 404, 409].includes(error.status)
    ? error.status
    : 503;

  if (status === 503) {
    console.error(
      "Admin request failed:",
      error.name || "Error",
    );
  }

  return res.status(status).json({
    success: false,
    message:
      status === 503
        ? "Admin information is temporarily unavailable. Please retry."
        : error.message,
  });
}

function customer(user, summary = {}) {
  const profilePhone = user.phone || "";
  const orderPhone = summary.orderPhone || "";

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: profilePhone || orderPhone,
    phoneSource: profilePhone
      ? "profile"
      : orderPhone
        ? "order"
        : "",
    isActive: user.isActive !== false,
    createdAt: user.createdAt,
    orderCount: summary.orderCount || 0,
  };
}

function dayKey(date) {
  return new Date(date.getTime() + IST)
    .toISOString()
    .slice(0, 10);
}

function paise(field) {
  return {
    $round: [
      {
        $multiply: [
          { $ifNull: [field, 0] },
          100,
        ],
      },
      0,
    ],
  };
}

async function getDashboard(req, res) {
  try {
    const days =
      text(req.query?.days, "the date range", 2) || "7";

    const source =
      text(req.query?.source, "the order type", 4) || "real";

    if (
      !["7", "30"].includes(days) ||
      !["real", "test"].includes(source)
    ) {
      throw problem(
        400,
        "Choose 7 or 30 days and a valid order type.",
      );
    }

    const now = new Date();

    const today = new Date(
      dayKey(now) + "T00:00:00+05:30",
    );

    const start = new Date(
      today.getTime() - (Number(days) - 1) * DAY,
    );

    const orderType = {
      "metadata.demo": source === "test",
    };

    const salesPipeline = [
      {
        $match: {
          ...orderType,

          createdAt: {
            $gte: start,
            $lte: now,
          },

          status: {
            $in: [
              "confirmed",
              "processing",
              "shipped",
              "out-for-delivery",
              "delivered",
            ],
          },

          "payment.status": {
            $in: [
              "paid",
              "partially-paid",
              "refunded",
            ],
          },

          $or: [
            { "pricing.currency": "INR" },
            {
              "pricing.currency": {
                $exists: false,
              },
            },
          ],
        },
      },

      {
        $project: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: "Asia/Kolkata",
            },
          },

          total: paise("$pricing.finalTotal"),
          paid: paise("$payment.amountPaid"),
          due: paise("$payment.amountDue"),

          refunded: {
            $cond: [
              {
                $in: [
                  "$refund.status",
                  ["refunded", "processed"],
                ],
              },
              paise("$refund.amount"),
              0,
            ],
          },
        },
      },

      {
        $group: {
          _id: "$day",

          sales: {
            $sum: {
              $max: [
                0,
                {
                  $subtract: [
                    "$total",
                    "$refunded",
                  ],
                },
              ],
            },
          },

          received: {
            $sum: {
              $max: [
                0,
                {
                  $subtract: [
                    "$paid",
                    "$refunded",
                  ],
                },
              ],
            },
          },

          due: {
            $sum: {
              $max: [0, "$due"],
            },
          },

          orders: {
            $sum: 1,
          },
        },
      },

      {
        $sort: {
          _id: 1,
        },
      },
    ];

    const [
      customers,
      blockedCustomers,
      activeProducts,
      lowStockProducts,
      outOfStockProducts,
      openOrders,
      pendingPayments,
      pendingReturns,
      openSupport,
      daily,
      recent,
    ] = await Promise.all([
      User.countDocuments({
        role: "customer",
      }).maxTimeMS(TIMEOUT),

      User.countDocuments({
        role: "customer",
        isActive: false,
      }).maxTimeMS(TIMEOUT),

      Product.countDocuments({
        isActive: { $ne: false },
      }).maxTimeMS(TIMEOUT),

      Product.countDocuments({
        isActive: { $ne: false },
        stock: { $gt: 0, $lte: 10 },
      }).maxTimeMS(TIMEOUT),

      Product.countDocuments({
        isActive: { $ne: false },
        stock: { $lte: 0 },
      }).maxTimeMS(TIMEOUT),

      Order.countDocuments({
        ...orderType,
        status: {
          $in: [
            "confirmed",
            "processing",
            "shipped",
            "out-for-delivery",
          ],
        },
      }).maxTimeMS(TIMEOUT),

      Order.countDocuments({
        ...orderType,
        status: "payment-pending",
      }).maxTimeMS(TIMEOUT),

      Order.countDocuments({
        ...orderType,
        "returnRequest.status": {
          $in: ["requested", "approved"],
        },
      }).maxTimeMS(TIMEOUT),

      SupportTicket.countDocuments({
        status: {
          $in: ["open", "waiting"],
        },
      }).maxTimeMS(TIMEOUT),

      Order.aggregate(salesPipeline).option({
        maxTimeMS: TIMEOUT,
      }),

      Order.find(orderType)
        .select(
          "orderNumber customer.name customer.phone shippingAddress.phone status payment.status pricing.finalTotal createdAt",
        )
        .sort({ createdAt: -1, _id: -1 })
        .limit(5)
        .lean()
        .maxTimeMS(TIMEOUT),
    ]);

    const byDay = new Map(
      daily.map((row) => [row._id, row]),
    );

    const points = Array.from(
      { length: Number(days) },
      (_, index) => {
        const date = dayKey(
          new Date(start.getTime() + index * DAY),
        );

        const row = byDay.get(date) || {};

        return {
          date,
          sales: Number(row.sales || 0) / 100,
          received: Number(row.received || 0) / 100,
          due: Number(row.due || 0) / 100,
          orders: Number(row.orders || 0),
        };
      },
    );

    const summary = points.reduce(
      (sum, point) => ({
        sales:
          sum.sales + Math.round(point.sales * 100),

        received:
          sum.received +
          Math.round(point.received * 100),

        due:
          sum.due + Math.round(point.due * 100),

        orders:
          sum.orders + point.orders,
      }),
      {
        sales: 0,
        received: 0,
        due: 0,
        orders: 0,
      },
    );

    for (const key of ["sales", "received", "due"]) {
      summary[key] /= 100;
    }

    return res.json({
      success: true,
      generatedAt: now.toISOString(),

      stats: {
        customers,
        blockedCustomers,
        activeProducts,
        lowStockProducts,
        outOfStockProducts,
        openOrders,
        pendingPayments,
        pendingReturns,
        openSupport,
      },

      sales: {
        days: Number(days),
        source,
        points,
        summary,
      },

      recentOrders: recent.map((order) => ({
        orderNumber: order.orderNumber,

        customerName:
          order.customer?.name || "Customer",

        customerPhone:
          order.customer?.phone ||
          order.shippingAddress?.phone ||
          "",

        status: order.status,

        paymentStatus:
          order.payment?.status || "pending",

        total:
          order.pricing?.finalTotal ?? null,

        createdAt: order.createdAt,
      })),
    });
  } catch (error) {
    return failure(res, error);
  }
}

async function getCustomers(req, res) {
  try {
    const query = req.query || {};

    const search = text(
      query.search,
      "the search",
      80,
    );

    const status = text(
      query.status,
      "the account status",
      20,
    );

    const requestedPage = integer(
      query.page,
      1,
      10000,
    );

    const limit = integer(
      query.limit,
      25,
      100,
    );

    if (
      !["", "all", "active", "disabled"].includes(status)
    ) {
      throw problem(
        400,
        "Choose a valid account status.",
      );
    }

    const filter = {
      role: "customer",
    };

    if (status === "active") {
      filter.isActive = { $ne: false };
    }

    if (status === "disabled") {
      filter.isActive = false;
    }

    if (search) {
      const pattern = new RegExp(
        search.replace(
          /[|\\{}()[\]^$+*?.]/g,
          "\\$&",
        ),
        "i",
      );

      filter.$or = [
        { name: pattern },
        { email: pattern },
        { phone: pattern },
      ];
    }

    const total = await User.countDocuments(
      filter,
    ).maxTimeMS(TIMEOUT);

    const pages = Math.max(
      1,
      Math.ceil(total / limit),
    );

    const page = Math.min(
      requestedPage,
      pages,
    );

    const users = await User.find(filter)
      .select(CUSTOMER_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .maxTimeMS(TIMEOUT);

    const summaries = users.length
      ? await Order.aggregate([
          {
            $match: {
              user: {
                $in: users.map((user) => user._id),
              },
            },
          },

          {
            $sort: {
              createdAt: -1,
              _id: -1,
            },
          },

          {
            $group: {
              _id: "$user",

              orderCount: {
                $sum: 1,
              },

              orderPhone: {
                $first: {
                  $ifNull: [
                    "$customer.phone",
                    "$shippingAddress.phone",
                  ],
                },
              },
            },
          },
        ]).option({
          maxTimeMS: TIMEOUT,
        })
      : [];

    const byUser = new Map(
      summaries.map((row) => [
        String(row._id),
        row,
      ]),
    );

    return res.json({
      success: true,
      page,
      limit,
      total,
      pages,

      customers: users.map((user) =>
        customer(
          user,
          byUser.get(String(user._id)),
        ),
      ),
    });
  } catch (error) {
    return failure(res, error);
  }
}

async function setCustomerStatus(req, res) {
  try {
    const id = req.params.id;

    const {
      isActive,
      expectedIsActive,
    } = req.body || {};

    if (!mongoose.isObjectIdOrHexString(id)) {
      throw problem(
        400,
        "Invalid customer ID.",
      );
    }

    if (
      typeof isActive !== "boolean" ||
      typeof expectedIsActive !== "boolean" ||
      isActive === expectedIsActive
    ) {
      throw problem(
        400,
        "Choose whether to block or unblock this customer.",
      );
    }

    if (String(req.user._id) === id) {
      throw problem(
        403,
        "You cannot block your own admin account.",
      );
    }

    const updated = await User.findOneAndUpdate(
      {
        _id: id,
        role: "customer",

        isActive: expectedIsActive
          ? { $ne: false }
          : false,
      },

      {
        $set: {
          isActive,
        },

        // Old sessions remain invalid after unblocking.
        $inc: {
          authVersion: 1,
        },
      },

      {
        new: true,
        runValidators: true,
      },
    )
      .select(CUSTOMER_FIELDS)
      .lean()
      .maxTimeMS(TIMEOUT);

    if (!updated) {
      const exists = await User.exists({
        _id: id,
        role: "customer",
      }).maxTimeMS(TIMEOUT);

      throw problem(
        exists ? 409 : 404,
        exists
          ? "This customer's status changed. Refresh the list and try again."
          : "Customer not found. Admin accounts cannot be changed here.",
      );
    }

    return res.json({
      success: true,

      message: isActive
        ? "Customer unblocked."
        : "Customer blocked.",

      customer: customer(updated),
    });
  } catch (error) {
    return failure(res, error);
  }
}

module.exports = {
  getDashboard,
  getCustomers,
  setCustomerStatus,
};