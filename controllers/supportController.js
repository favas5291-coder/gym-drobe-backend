const mongoose = require("mongoose");

const Ticket = require("../models/SupportTicket");
const Order = require("../models/Order");

const categories = [
  "General",
  "Product question",
  "Order issue",
  "Delivery",
  "Return or exchange",
  "Payment question",
];

const statuses = [
  "open",
  "waiting",
  "resolved",
];

function bad(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function field(value, name, min, max) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  ) {
    bad(
      `${name} must contain ${min}–${max} characters.`,
    );
  }

  return value.trim();
}

function requestKey(value) {
  const key = field(
    value,
    "Request ID",
    16,
    80,
  );

  if (!/^[A-Za-z0-9-]+$/.test(key)) {
    bad("Invalid request ID.");
  }

  return key;
}

function scope(req) {
  if (
    !mongoose.isObjectIdOrHexString(
      req.params.id,
    )
  ) {
    bad("Ticket not found.", 404);
  }

  return {
    _id: req.params.id,
    ...(req.user.role === "admin"
      ? {}
      : { user: req.user._id }),
  };
}

function serialize(doc) {
  const t = doc.toObject
    ? doc.toObject()
    : doc;

  return {
    id: String(t._id),
    subject: t.subject,
    category: t.category,
    email: t.email,
    orderId: t.orderId,
    productId: t.productId,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    messages: (t.messages || []).map(
      (message) => ({
        id: String(message._id),
        by: message.by,
        text: message.text,
        createdAt: message.createdAt,
      }),
    ),
  };
}

const handle = (fn) => async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    await fn(req, res);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.status
        ? error.message
        : "Support could not be updated. Please try again.",
    });
  }
};

// Create a request for the signed-in customer.
exports.createTicket = handle(
  async (req, res) => {
    const key = requestKey(
      req.body.requestId,
    );

    const existing = await Ticket.findOne({
      user: req.user._id,
      requestId: key,
    });

    if (existing) {
      return res.json({
        success: true,
        ticket: serialize(existing),
      });
    }

    const subject = field(
      req.body.subject,
      "Subject",
      1,
      120,
    );

    const text = field(
      req.body.message,
      "Message",
      10,
      2000,
    );

    const category =
      req.body.category || "General";

    if (!categories.includes(category)) {
      bad("Choose a valid topic.");
    }

    // Use the authenticated account email.
    const email = field(
      req.user.email,
      "Account email",
      3,
      254,
    );

    const orderId = field(
      req.body.orderId || "",
      "Order ID",
      0,
      120,
    );

    const productId = field(
      req.body.productId || "",
      "Product ID",
      0,
      120,
    );

    if (orderId) {
      const conditions = [
        { orderNumber: orderId },
      ];

      if (
        mongoose.isObjectIdOrHexString(
          orderId,
        )
      ) {
        conditions.push({
          _id: orderId,
        });
      }

      const order = await Order.exists({
        user: req.user._id,
        $or: conditions,
      });

      if (!order) {
        bad(
          "That order is not available for your account.",
        );
      }
    }

    let ticket;

    try {
      ticket = await Ticket.create({
        user: req.user._id,
        requestId: key,
        subject,
        category,
        email,
        orderId,
        productId,
        messages: [
          {
            requestId: key,
            by: "customer",
            text,
          },
        ],
      });
    } catch (error) {
      // A retry may reach the server after
      // the original request was already saved.
      if (error.code !== 11000) {
        throw error;
      }

      ticket = await Ticket.findOne({
        user: req.user._id,
        requestId: key,
      });

      if (!ticket) {
        throw error;
      }
    }

    res.status(201).json({
      success: true,
      ticket: serialize(ticket),
    });
  },
);

// Customers see their own requests.
// Admin inbox routes see all requests.
exports.listTickets = handle(
  async (req, res) => {
    const admin =
      req.user.role === "admin" &&
      req.path.startsWith("/admin");

    const filter = admin
      ? {}
      : { user: req.user._id };

    if (req.query.status) {
      if (
        !statuses.includes(
          req.query.status,
        )
      ) {
        bad("Invalid status filter.");
      }

      filter.status = req.query.status;
    }

    const raw = Number(
      req.query.page || 1,
    );

    const page =
      Number.isSafeInteger(raw) &&
      raw > 0
        ? raw
        : 1;

    const limit = 20;

    const [tickets, total] =
      await Promise.all([
        Ticket.find(filter)
          .sort({
            updatedAt: -1,
            _id: -1,
          })
          .skip((page - 1) * limit)
          .limit(limit)
          .select("-messages"),

        Ticket.countDocuments(filter),
      ]);

    res.json({
      success: true,
      tickets: tickets.map(serialize),
      page,
      pages: Math.max(
        1,
        Math.ceil(total / limit),
      ),
      total,
    });
  },
);

exports.getTicket = handle(
  async (req, res) => {
    const ticket = await Ticket.findOne(
      scope(req),
    );

    if (!ticket) {
      bad("Ticket not found.", 404);
    }

    res.json({
      success: true,
      ticket: serialize(ticket),
    });
  },
);

// Append replies without replacing
// messages added by another request.
exports.reply = handle(
  async (req, res) => {
    const filter = scope(req);

    const key = requestKey(
      req.body.requestId,
    );

    const text = field(
      req.body.message,
      "Reply",
      2,
      2000,
    );

    const ticket =
      await Ticket.findOneAndUpdate(
        {
          ...filter,
          "messages.requestId": {
            $ne: key,
          },
          "messages.199": {
            $exists: false,
          },
        },
        {
          $push: {
            messages: {
              requestId: key,
              by:
                req.user.role === "admin"
                  ? "store"
                  : "customer",
              text,
              createdAt: new Date(),
            },
          },
          $set: {
            status:
              req.user.role === "admin"
                ? "waiting"
                : "open",
          },
        },
        {
          new: true,
          runValidators: true,
        },
      );

    if (ticket) {
      return res.json({
        success: true,
        ticket: serialize(ticket),
      });
    }

    const existing =
      await Ticket.findOne(filter);

    if (!existing) {
      bad("Ticket not found.", 404);
    }

    if (
      existing.messages.some(
        (message) =>
          message.requestId === key,
      )
    ) {
      return res.json({
        success: true,
        ticket: serialize(existing),
      });
    }

    bad(
      "This conversation is full. Please create a new request referencing this ticket.",
      409,
    );
  },
);

exports.updateStatus = handle(
  async (req, res) => {
    if (
      !statuses.includes(
        req.body.status,
      )
    ) {
      bad("Choose a valid status.");
    }

    const ticket =
      await Ticket.findOneAndUpdate(
        scope(req),
        {
          $set: {
            status: req.body.status,
          },
        },
        {
          new: true,
          runValidators: true,
        },
      );

    if (!ticket) {
      bad("Ticket not found.", 404);
    }

    res.json({
      success: true,
      ticket: serialize(ticket),
    });
  },
);