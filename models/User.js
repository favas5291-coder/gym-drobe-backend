const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

function removePrivateFields(doc, ret) {
  delete ret.password;
  delete ret.googleId;
  delete ret.passwordResetToken;
  delete ret.passwordResetExpires;
  delete ret.passwordResetRequestedAt;
  delete ret.authVersion;
  delete ret.__v;
  return ret;
}

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 60,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 150,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "Please enter a valid email address.",
      ],
    },

    phone: {
      type: String,
      default: "",
      trim: true,
      maxlength: 10,
      validate: {
        validator(value) {
          return !value || /^[6-9]\d{9}$/.test(value);
        },
        message: "Please enter a valid 10-digit mobile number.",
      },
    },

    // Existing password hashes remain stored.
    // New Google accounts do not need a password.
    password: {
      type: String,
      minlength: 8,
      select: false,
    },

    // Google's permanent account identifier.
    googleId: {
      type: String,
      select: false,
      maxlength: 255,
    },

    role: {
      type: String,
      enum: ["customer", "admin"],
      default: "customer",
      index: true,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    authVersion: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },

    // Retained for compatibility with existing records.
    passwordResetToken: {
      type: String,
      select: false,
    },

    passwordResetExpires: {
      type: Date,
      select: false,
    },

    passwordResetRequestedAt: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: { transform: removePrivateFields },
    toObject: { transform: removePrivateFields },
  }
);

userSchema.index(
  { googleId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      googleId: { $type: "string" },
    },
  }
);

userSchema.pre("validate", function () {
  if (typeof this.name === "string") {
    this.name = this.name.trim();
  }

  if (typeof this.email === "string") {
    this.email = this.email.trim().toLowerCase();
  }

  if (typeof this.phone === "string") {
    this.phone = this.phone.replace(/\D/g, "");
  }

  if (this.isNew && !this.password && !this.googleId) {
    this.invalidate("googleId", "A sign-in method is required.");
  }
});

userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) {
    return;
  }

  if (
    typeof this.password !== "string" ||
    Buffer.byteLength(this.password, "utf8") > 72
  ) {
    throw new Error("Password cannot exceed 72 UTF-8 bytes.");
  }

  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = async function (enteredPassword) {
  if (
    !this.password ||
    typeof enteredPassword !== "string" ||
    !enteredPassword ||
    Buffer.byteLength(enteredPassword, "utf8") > 72
  ) {
    return false;
  }

  return bcrypt.compare(enteredPassword, this.password);
};

module.exports =
  mongoose.models.User || mongoose.model("User", userSchema);