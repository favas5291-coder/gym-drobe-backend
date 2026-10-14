const mongoose = require("mongoose");
const User = require("../../models/User");
const Order = require("../../models/Order");
const Address = require("../../models/Address");

const TIMEOUT = 10000;
const DAY = 86400000;

const CONFIRMED = [
  "confirmed",
  "processing",
  "packed",
  "shipped",
  "out-for-delivery",
  "delivered",
];

const FIELDS =
  "_id name email phone role isActive createdAt updatedAt";

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function text(value, maximum = 80) {
  if (value == null) return "";

  if (
    typeof value !== "string" ||
    value.trim().length > maximum
  ) {
    fail(400, "Check the search or filter value.");
  }

  return value.trim();
}

function integer(value, fallback, maximum) {
  if (value === undefined) return fallback;

  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    Number(value) > maximum
  ) {
    fail(400, "Use valid positive page and limit values.");
  }

  return Number(value);
}

function choice(value, allowed, fallback) {
  const selected =
    value === undefined || value === ""
      ? fallback
      : value;

  if (!allowed.includes(selected)) {
    fail(400, "Choose a supported filter.");
  }

  return selected;
}

function objectId(value) {
  if (
    typeof value !== "string" ||
    !mongoose.isObjectIdOrHexString(value)
  ) {
    fail(400, "Customer ID is invalid.");
  }

  return new mongoose.Types.ObjectId(value);
}

function calendar(value) {
  const input = text(value, 10);

  if (!input) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    fail(400, "Use a valid joined date.");
  }

  const date = new Date(`${input}T00:00:00+05:30`);

  if (
    !Number.isFinite(date.getTime()) ||
    new Date(date.getTime() + 330 * 60000)
      .toISOString()
      .slice(0, 10) !== input
  ) {
    fail(400, "Use a valid joined date.");
  }

  return date;
}

function contact(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
}

function customer(value, fallbackPhone = "") {
  const profilePhone = contact(value.phone);

  return {
    id: String(value._id),
    name: value.name || "",
    email: value.email || "",
    role: value.role,
    phone: profilePhone || contact(fallbackPhone),
    profilePhone,
    phoneSource: profilePhone
      ? "profile"
      : fallbackPhone
        ? "order"
        : "",
    isActive: value.isActive !== false,
    createdAt: value.createdAt || null,
    orderCount: value.orderCount || 0,
    purchaseCount: value.purchaseCount || 0,
    lastOrderAt: value.lastOrderAt || null,
  };
}

function paise(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return null;
  }

  const cents = Math.round(value * 100);

  return (
    Number.isSafeInteger(cents) &&
    Math.abs(value * 100 - cents) < 0.00001
  )
    ? cents
    : null;
}

function ledger(order) {
  const payment = order.payment || {};
  const refund = order.refund || {};

  if ((order.pricing?.currency || "INR") !== "INR") {
    return null;
  }

  const paid = paise(payment.amountPaid);

  if (paid === null) return null;

  const completed = ["refunded", "processed"].includes(
    refund.status
  )
    ? paise(refund.amount)
    : 0;

  if (completed === null) return null;

  if (payment.amountsReconciled === true) {
    const gross = paise(payment.grossCollected);
    const refunded = paise(payment.refundedAmount);

    if (
      gross === null ||
      refunded === null ||
      gross !== paid + refunded ||
      completed > refunded
    ) {
      return null;
    }

    return {
      collected: gross,
      refunded,
      retained: paid,
    };
  }

  if (
    payment.status === "refunded" &&
    paid === 0 &&
    completed > 0
  ) {
    return {
      collected: completed,
      refunded: completed,
      retained: 0,
    };
  }

  // Historical partial refunds may store either gross
  // or net amountPaid. Do not guess which one it is.
  if (
    completed > 0 ||
    paise(payment.refundedAmount || 0) !== 0 ||
    ["refunded", "partially-refunded"].includes(
      payment.status
    )
  ) {
    return null;
  }

  if (
    paid > 0 &&
    !["paid", "partially-paid"].includes(payment.status)
  ) {
    return null;
  }

  return {
    collected: paid,
    refunded: 0,
    retained: paid,
  };
}

function isTest(order) {
  return (
    order.metadata?.demo === true ||
    order.payment?.mode === "test" ||
    order.payment?.razorpayMode === "test"
  );
}

function sourceFilter(source) {
  const test = {
    $or: [
      { "metadata.demo": true },
      { "payment.mode": "test" },
      { "payment.razorpayMode": "test" },
    ],
  };

  return source === "test"
    ? test
    : source === "real"
      ? { $nor: test.$or }
      : {};
}

function guarded(handler) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Admin sign-in is required.",
      });
    }

    if (
      req.user.role !== "admin" ||
      req.user.isActive === false ||
      !mongoose.isObjectIdOrHexString(
        req.user._id || req.user.id
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "An active administrator account is required.",
      });
    }

    try {
      return await handler(req, res);
    } catch (error) {
      const status = [400, 403, 404, 409].includes(
        error.status
      )
        ? error.status
        : 503;

      if (status === 503) {
        console.error(
          "Customer administration failed:",
          error.name || "Error"
        );
      }

      return res.status(status).json({
        success: false,
        message:
          status === 503
            ? "Customer administration is temporarily unavailable. Reload before retrying an account change."
            : error.message,
      });
    }
  };
}

const getCustomers = guarded(async (req, res) => {
  const page = integer(req.query.page, 1, 10000);
  const limit = integer(req.query.limit, 25, 100);
  const search = text(req.query.search);

  const status = choice(
    req.query.status,
    ["all", "active", "disabled"],
    "all"
  );

  const activity = choice(
    req.query.activity,
    ["all", "with-orders", "no-orders", "repeat"],
    "all"
  );

  const sort = choice(
    req.query.sort,
    ["newest", "oldest", "name", "orders", "last-order"],
    "newest"
  );

  const from = calendar(req.query.from);
  const to = calendar(req.query.to);

  if (from && to && from > to) {
    fail(
      400,
      "The joined-from date cannot be after the joined-to date."
    );
  }

  const match = { role: "customer" };

  if (status !== "all") {
    match.isActive =
      status === "active" ? { $ne: false } : false;
  }

  if (from || to) {
    match.createdAt = {
      ...(from ? { $gte: from } : {}),
      ...(to
        ? { $lt: new Date(to.getTime() + DAY) }
        : {}),
    };
  }

  const phone = {
    $trim: {
      input: {
        $convert: {
          input: "$customer.phone",
          to: "string",
          onNull: "",
          onError: "",
        },
      },
    },
  };

  const pipeline = [
    { $match: match },

    {
      $project: {
        name: 1,
        email: 1,
        phone: 1,
        role: 1,
        isActive: 1,
        createdAt: 1,
      },
    },

    {
      $lookup: {
        from: Order.collection.name,
        let: { customerId: "$_id" },

        pipeline: [
          {
            $match: {
              $expr: {
                $eq: ["$user", "$$customerId"],
              },
            },
          },

          { $sort: { createdAt: -1, _id: -1 } },

          {
            $group: {
              _id: null,
              orderCount: { $sum: 1 },
              lastOrderAt: { $first: "$createdAt" },

              orderPhone: {
                $first: {
                  $cond: [
                    { $ne: [phone, ""] },
                    phone,
                    "$shippingAddress.phone",
                  ],
                },
              },

              purchaseCount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $in: ["$status", CONFIRMED] },
                        {
                          $ne: [
                            {
                              $ifNull: [
                                "$metadata.demo",
                                false,
                              ],
                            },
                            true,
                          ],
                        },
                        {
                          $ne: [
                            {
                              $ifNull: [
                                "$payment.mode",
                                "",
                              ],
                            },
                            "test",
                          ],
                        },
                        {
                          $ne: [
                            {
                              $ifNull: [
                                "$payment.razorpayMode",
                                "",
                              ],
                            },
                            "test",
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],

        as: "orderSummary",
      },
    },

    {
      $set: {
        orderSummary: {
          $arrayElemAt: ["$orderSummary", 0],
        },
      },
    },

    {
      $set: {
        orderCount: {
          $ifNull: ["$orderSummary.orderCount", 0],
        },
        purchaseCount: {
          $ifNull: ["$orderSummary.purchaseCount", 0],
        },
        lastOrderAt: {
          $ifNull: ["$orderSummary.lastOrderAt", null],
        },
        orderPhone: {
          $ifNull: ["$orderSummary.orderPhone", ""],
        },
      },
    },
  ];

  if (search) {
    const pattern = new RegExp(
      search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i"
    );

    pipeline.push({
      $match: {
        $or: [
          { name: pattern },
          { email: pattern },
          { phone: pattern },
          { orderPhone: pattern },

          ...(mongoose.isObjectIdOrHexString(search)
            ? [
                {
                  _id: new mongoose.Types.ObjectId(
                    search
                  ),
                },
              ]
            : []),
        ],
      },
    });
  }

  if (activity !== "all") {
    pipeline.push({
      $match:
        activity === "repeat"
          ? { purchaseCount: { $gte: 2 } }
          : {
              orderCount:
                activity === "with-orders"
                  ? { $gt: 0 }
                  : 0,
            },
    });
  }

  const sortBy = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    name: { name: 1 },
    orders: { orderCount: -1 },
    "last-order": { lastOrderAt: -1 },
  }[sort];

  pipeline.push({
    $facet: {
      rows: [
        { $sort: { ...sortBy, _id: 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ],
      total: [{ $count: "value" }],
    },
  });

  const [result, counts] = await Promise.all([
    User.aggregate(pipeline).option({
      maxTimeMS: TIMEOUT,
      allowDiskUse: true,
    }),

    User.aggregate([
      { $match: { role: "customer" } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },

          blocked: {
            $sum: {
              $cond: [
                { $eq: ["$isActive", false] },
                1,
                0,
              ],
            },
          },

          new30Days: {
            $sum: {
              $cond: [
                {
                  $gte: [
                    "$createdAt",
                    new Date(
                      Date.now() - 30 * DAY
                    ),
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]).option({ maxTimeMS: TIMEOUT }),
  ]);

  const total =
    result[0]?.total[0]?.value || 0;

  const pages = Math.max(
    1,
    Math.ceil(total / limit)
  );

  const global = counts[0] || {
    total: 0,
    blocked: 0,
    new30Days: 0,
  };

  return res.json({
    success: true,

    customers: (result[0]?.rows || []).map(
      (row) => customer(row, row.orderPhone)
    ),

    total,
    page,
    pages,
    limit,

    stats: {
      total: global.total,
      active: global.total - global.blocked,
      blocked: global.blocked,
      new30Days: global.new30Days,
    },

    generatedAt: new Date(),
  });
});

async function finances(filter) {
  const summary = {
    orders: 0,
    confirmed: 0,
    delivered: 0,
    cancelled: 0,
    returns: 0,
    orderValuePaise: 0,
    collectedPaise: 0,
    refundedPaise: 0,
    retainedPaise: 0,
    duePaise: 0,
    financialReviewOrders: 0,
    valueReviewOrders: 0,
    dueReviewOrders: 0,
  };

  const cursor = Order.find(filter)
    .select(
      "status pricing payment refund returnRequest.status"
    )
    .lean()
    .maxTimeMS(TIMEOUT)
    .cursor();

  const deadline = Date.now() + TIMEOUT;

  try {
    for await (const order of cursor) {
      if (Date.now() > deadline) {
        fail(503, "Customer summary timed out.");
      }

      summary.orders++;

      const confirmed = CONFIRMED.includes(
        order.status
      );

      if (confirmed) {
        summary.confirmed++;

        const value =
          (order.pricing?.currency || "INR") === "INR"
            ? paise(order.pricing?.finalTotal)
            : null;

        if (value === null) {
          summary.valueReviewOrders++;
        } else {
          summary.orderValuePaise += value;
        }

        const due =
          (order.pricing?.currency || "INR") === "INR"
            ? paise(order.payment?.amountDue)
            : null;

        if (due === null) {
          summary.dueReviewOrders++;
        } else {
          summary.duePaise += due;
        }
      }

      if (order.status === "delivered") {
        summary.delivered++;
      }

      if (order.status === "cancelled") {
        summary.cancelled++;
      }

      if (
        ["requested", "approved", "completed"].includes(
          order.returnRequest?.status
        )
      ) {
        summary.returns++;
      }

      const amounts = ledger(order);

      if (!amounts) {
        summary.financialReviewOrders++;
      } else {
        summary.collectedPaise += amounts.collected;
        summary.refundedPaise += amounts.refunded;
        summary.retainedPaise += amounts.retained;
      }

      if (
        !Object.values(summary).every(
          Number.isSafeInteger
        )
      ) {
        fail(
          503,
          "Customer amounts exceed the supported range."
        );
      }
    }
  } finally {
    await cursor.close();
  }

  return summary;
}

function orderRow(order) {
  const amounts = ledger(order);

  const inr =
    (order.pricing?.currency || "INR") === "INR";

  return {
    id: String(order._id),
    orderNumber:
      order.orderNumber || String(order._id),
    status: order.status,
    createdAt: order.createdAt,
    test: isTest(order),

    itemCount: (order.items || []).reduce(
      (sum, row) =>
        sum +
        (Number.isSafeInteger(row.quantity)
          ? row.quantity
          : 0),
      0
    ),

    totalPaise: inr
      ? paise(order.pricing?.finalTotal)
      : null,

    collectedPaise: amounts?.collected ?? null,
    retainedPaise: amounts?.retained ?? null,
    refundedPaise: amounts?.refunded ?? null,

    duePaise:
      order.status === "cancelled"
        ? 0
        : inr
          ? paise(order.payment?.amountDue)
          : null,

    paymentMethod:
      order.payment?.method ||
      order.paymentMethod ||
      "",

    paymentStatus: order.payment?.status || "",
    returnStatus:
      order.returnRequest?.status || "not-requested",
    refundStatus: order.refund?.status || "none",

    tracking: {
      carrier: order.tracking?.carrier || "",
      trackingNumber:
        order.tracking?.trackingNumber || "",
    },

    items: (order.items || []).map((row) => ({
      name: row.name || "Product",
      brand: row.brand || "",
      sku: row.sku || "",
      quantity: row.quantity,
      selectedSize: row.selectedSize || null,
      selectedColor: row.selectedColor || null,
      unitPricePaise: paise(row.price),
    })),

    pricingPaise: Object.fromEntries(
      [
        "subtotal",
        "kitDiscount",
        "couponDiscount",
        "shipping",
        "finalTotal",
      ].map((field) => [
        field,
        inr ? paise(order.pricing?.[field]) : null,
      ])
    ),

    shippingAddress: order.shippingAddress
      ? Object.fromEntries(
          [
            "fullName",
            "email",
            "phone",
            "addressLine",
            "landmark",
            "city",
            "state",
            "pincode",
          ].map((field) => [
            field,
            order.shippingAddress[field] || "",
          ])
        )
      : null,
  };
}

const getCustomer = guarded(async (req, res) => {
  const id = objectId(req.params.id);
  const page = integer(req.query.page, 1, 10000);
  const limit = integer(req.query.limit, 10, 50);

  const source = choice(
    req.query.source,
    ["real", "test", "all"],
    "real"
  );

  const user = await User.findOne({
    _id: id,
    role: "customer",
  })
    .select(FIELDS)
    .lean()
    .maxTimeMS(TIMEOUT);

  if (!user) {
    fail(404, "Customer not found.");
  }

  const filter = {
    user: id,
    ...sourceFilter(source),
  };

  const [summary, orders, latest, addresses] =
    await Promise.all([
      finances(filter),

      Order.find(filter)
        .select(
          "orderNumber status createdAt items.name items.brand items.sku items.quantity items.selectedSize items.selectedColor items.price shippingAddress pricing payment paymentMethod refund returnRequest.status tracking.carrier tracking.trackingNumber metadata.demo"
        )
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .maxTimeMS(TIMEOUT),

      Order.findOne({ user: id })
        .select("customer.phone shippingAddress")
        .sort({ createdAt: -1, _id: -1 })
        .lean()
        .maxTimeMS(TIMEOUT),

      Address.find({ user: id })
        .select(
          "fullName phone addressLine landmark city state pincode label isDefault"
        )
        .sort({ isDefault: -1, createdAt: -1 })
        .limit(10)
        .lean()
        .maxTimeMS(TIMEOUT),
    ]);

  return res.json({
    success: true,

    customer: customer(
      user,
      contact(latest?.customer?.phone) ||
        contact(latest?.shippingAddress?.phone)
    ),

    summary,
    orders: orders.map(orderRow),
    source,
    page,
    pages: Math.max(
      1,
      Math.ceil(summary.orders / limit)
    ),
    limit,

    addresses: addresses.map((row) => ({
      id: String(row._id),
      fullName: row.fullName,
      phone: row.phone,
      addressLine: row.addressLine,
      landmark: row.landmark,
      city: row.city,
      state: row.state,
      pincode: row.pincode,
      label: row.label,
      isDefault: row.isDefault === true,
    })),

    latestShippingAddress:
      latest?.shippingAddress
        ? Object.fromEntries(
            [
              "fullName",
              "phone",
              "addressLine",
              "landmark",
              "city",
              "state",
              "pincode",
            ].map((field) => [
              field,
              latest.shippingAddress[field] || "",
            ])
          )
        : null,

    generatedAt: new Date(),
  });
});

const setCustomerStatus = guarded(async (req, res) => {
  const id = objectId(req.params.id);
  const body = req.body;

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) =>
        !["isActive", "expectedIsActive"].includes(key)
    ) ||
    typeof body.isActive !== "boolean" ||
    typeof body.expectedIsActive !== "boolean" ||
    body.isActive === body.expectedIsActive
  ) {
    fail(
      400,
      "Choose whether to block or unblock the customer."
    );
  }

  if (
    String(req.user._id || req.user.id)
      .toLowerCase() ===
    String(id).toLowerCase()
  ) {
    fail(
      403,
      "You cannot change your own admin account here."
    );
  }

  const user = await User.findOneAndUpdate(
    {
      _id: id,
      role: "customer",

      isActive: body.expectedIsActive
        ? { $ne: false }
        : false,
    },
    {
      $set: { isActive: body.isActive },
      $inc: { authVersion: 1 },
    },
    {
      new: true,
      runValidators: true,
    }
  )
    .select(FIELDS)
    .lean()
    .maxTimeMS(TIMEOUT);

  if (!user) {
    const exists = await User.exists({
      _id: id,
      role: "customer",
    }).maxTimeMS(TIMEOUT);

    fail(
      exists ? 409 : 404,
      exists
        ? "This customer's status changed. Reload before trying again."
        : "Customer not found. Admin accounts cannot be changed here."
    );
  }

  return res.json({
    success: true,
    customer: customer(user),

    message: body.isActive
      ? "Customer unblocked. They can sign in again."
      : "Customer blocked. Existing orders remain available to administrators.",
  });
});

module.exports = {
  getCustomers,
  getCustomer,
  setCustomerStatus,
};