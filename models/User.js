const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

function removePrivateFields(doc, ret) {
  delete ret.password;
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
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must contain at least 2 characters"],
      maxlength: [60, "Name cannot exceed 60 characters"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 150,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "Please enter a valid email address",
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
        message: "Please enter a valid 10-digit mobile number",
      },
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must contain at least 8 characters"],
      select: false,
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

    // Incremented when passwords change to invalidate old tokens.
    authVersion: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },

    // Stores only the SHA-256 hash of the reset token.
    passwordResetToken: {
      type: String,
      select: false,
    },

    passwordResetExpires: {
      type: Date,
      select: false,
    },

    // Used to limit repeated reset-email requests.
    passwordResetRequestedAt: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: removePrivateFields,
    },
    toObject: {
      transform: removePrivateFields,
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
});

userSchema.pre("save", async function () {
  if (!this.isModified("password")) {
    return;
  }

  // bcrypt processes a maximum of 72 UTF-8 bytes.
  // Check plaintext before hashing to prevent silent truncation.
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
    !enteredPassword
  ) {
    return false;
  }

  return bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.models.User || mongoose.model("User", userSchema);

module.exports = User;