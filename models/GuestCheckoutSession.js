const mongoose = require("mongoose");

// The browser holds the random credential.
// Only its digest is stored in MongoDB.
const guestCheckoutSessionSchema =
  new mongoose.Schema(
    {
      tokenHash: {
        type: String,
        required: true,
        unique: true,
        select: false,
      },

      expiresAt: {
        type: Date,
        required: true,
      },
    },
    {
      timestamps: true,
    },
  );

// Expired sessions are removed by MongoDB.
// Access checks also verify expiry immediately.
guestCheckoutSessionSchema.index(
  {
    expiresAt: 1,
  },
  {
    expireAfterSeconds: 0,
  },
);

module.exports =
  mongoose.models.GuestCheckoutSession ||
  mongoose.model(
    "GuestCheckoutSession",
    guestCheckoutSessionSchema,
  );