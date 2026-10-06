const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { sendEmail } = require("../utils/sendEmail");

const RESET_MESSAGE =
  "If an active account exists for this email, a password-reset link will be sent.";

const cleanEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const cleanPhone = (value) => String(value ?? "").replace(/\D/g, "");

function validEmail(email) {
  return (
    email.length <= 150 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function passwordError(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must contain at least 8 characters.";
  }

  if (Buffer.byteLength(password, "utf8") > 72) {
    return "Password cannot exceed 72 UTF-8 bytes.";
  }

  return "";
}

function safeUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone || "",
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function generateToken(user) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing.");
  }

  return jwt.sign(
    {
      userId: String(user._id),
      authVersion: user.authVersion ?? 0,
    },
    process.env.JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    }
  );
}

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function handleError(res, error, message) {
  if (error.code === 11000) {
    return fail(res, 409, "This email is already registered.");
  }

  if (error.name === "ValidationError") {
    const first = Object.values(error.errors || {})[0];
    return fail(res, 400, first?.message || "Check your information.");
  }

  // Never log passwords, reset links, tokens or request bodies.
  console.error("Authentication operation failed:", error.name || "Error");
  return fail(res, 500, message);
}

function sendSession(res, user, message, status = 200) {
  return res.status(status).json({
    success: true,
    message,
    token: generateToken(user),
    user: safeUser(user),
  });
}

async function register(req, res) {
  try {
    const name =
      typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = cleanEmail(req.body?.email);
    const phone = cleanPhone(req.body?.phone);
    const password = req.body?.password;

    if (name.length < 2 || name.length > 60) {
      return fail(res, 400, "Name must contain 2–60 characters.");
    }

    if (!validEmail(email)) {
      return fail(res, 400, "Please enter a valid email address.");
    }

    const message = passwordError(password);
    if (message) return fail(res, 400, message);

    if (phone && !/^[6-9]\d{9}$/.test(phone)) {
      return fail(res, 400, "Please enter a valid 10-digit mobile number.");
    }

    if (await User.exists({ email })) {
      return fail(res, 409, "This email is already registered.");
    }

    const user = await User.create({ name, email, phone, password });
    return sendSession(res, user, "Account created successfully.", 201);
  } catch (error) {
    return handleError(res, error, "Registration could not be completed.");
  }
}

async function login(req, res) {
  try {
    const email = cleanEmail(req.body?.email);
    const password = req.body?.password;

    if (!validEmail(email) || typeof password !== "string" || !password) {
      return fail(res, 400, "Enter your email and password.");
    }

    const user = await User.findOne({ email }).select(
      "+password +authVersion"
    );

    if (!user || !(await user.comparePassword(password))) {
      return fail(res, 401, "Invalid email or password.");
    }

    if (user.isActive === false) {
      return fail(res, 403, "This account is disabled.");
    }

    return sendSession(res, user, "Signed in successfully.");
  } catch (error) {
    return handleError(res, error, "Login could not be completed.");
  }
}

async function getMe(req, res) {
  if (!req.user) {
    return fail(res, 401, "Authentication required.");
  }

  return res.json({ success: true, user: safeUser(req.user) });
}

async function updateProfile(req, res) {
  try {
    const body = req.body || {};
    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const hasPhone = Object.prototype.hasOwnProperty.call(body, "phone");

    if (!hasName && !hasPhone) {
      return fail(res, 400, "No profile changes were provided.");
    }

    const updates = {};

    if (hasName) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2 || name.length > 60) {
        return fail(res, 400, "Name must contain 2–60 characters.");
      }
      updates.name = name;
    }

    if (hasPhone) {
      const phone = cleanPhone(body.phone);
      if (phone && !/^[6-9]\d{9}$/.test(phone)) {
        return fail(res, 400, "Please enter a valid 10-digit mobile number.");
      }
      updates.phone = phone;
    }

    const user = await User.findOneAndUpdate(
      { _id: req.user._id, isActive: { $ne: false } },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!user) return fail(res, 403, "Account is unavailable.");

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      user: safeUser(user),
    });
  } catch (error) {
    return handleError(res, error, "Profile could not be updated.");
  }
}

async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const message = passwordError(newPassword);

    if (typeof currentPassword !== "string" || !currentPassword) {
      return fail(res, 400, "Current password is required.");
    }

    if (message) return fail(res, 400, message);

    const user = await User.findById(req.user._id).select(
      "+password +authVersion"
    );

    if (!user || user.isActive === false) {
      return fail(res, 403, "Account is unavailable.");
    }

    if (!(await user.comparePassword(currentPassword))) {
      return fail(res, 401, "Current password is incorrect.");
    }

    if (await user.comparePassword(newPassword)) {
      return fail(res, 400, "Choose a different new password.");
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Matching the current hash prevents concurrent password changes.
    const updated = await User.findOneAndUpdate(
      {
        _id: user._id,
        password: user.password,
        isActive: { $ne: false },
      },
      {
        $set: { password: passwordHash },
        $unset: {
          passwordResetToken: "",
          passwordResetExpires: "",
        },
        $inc: { authVersion: 1 },
      },
      { new: true }
    ).select("+authVersion");

    if (!updated) {
      return fail(res, 409, "Your account changed. Sign in and try again.");
    }

    return sendSession(
      res,
      updated,
      "Password changed successfully. Other login sessions have expired."
    );
  } catch (error) {
    return handleError(res, error, "Password could not be changed.");
  }
}

async function forgotPassword(req, res) {
  try {
    const email = cleanEmail(req.body?.email);

    if (!validEmail(email)) {
      return fail(res, 400, "Please enter a valid email address.");
    }

    let site;
    try {
      site = new URL(process.env.FRONTEND_URL);
      if (
        !["https:", "http:"].includes(site.protocol) ||
        site.username ||
        site.password
      ) {
        throw new Error("Invalid frontend URL.");
      }
    } catch {
      return fail(res, 503, "Password recovery is temporarily unavailable.");
    }

    const token = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const now = new Date();

    // Only one request per account per two minutes.
    const user = await User.findOneAndUpdate(
      {
        email,
        isActive: { $ne: false },
        $or: [
          { passwordResetRequestedAt: { $exists: false } },
          { passwordResetRequestedAt: null },
          {
            passwordResetRequestedAt: {
              $lte: new Date(now.getTime() - 120000),
            },
          },
        ],
      },
      {
        $set: {
          passwordResetToken: hash,
          passwordResetExpires: new Date(now.getTime() + 15 * 60000),
          passwordResetRequestedAt: now,
        },
      },
      { new: true }
    );

    if (user) {
      const link = new URL("/reset-password", site.origin);
      link.hash = `token=${token}`;

      try {
        await sendEmail({
          to: user.email,
          subject: "Reset your GymDrobe password",
          text: [
            "You requested a password reset for your GymDrobe account.",
            "",
            "Open this link to choose a new password:",
            link.href,
            "",
            "This link expires in 15 minutes and can be used once.",
            "If you did not request this, ignore this email.",
            "",
            "GymDrobe",
            "support@gymdrobe.com",
          ].join("\n"),
        });
      } catch (error) {
        // Remove only this request; do not erase a newer reset token.
        await User.updateOne(
          { _id: user._id, passwordResetToken: hash },
          {
            $unset: {
              passwordResetToken: "",
              passwordResetExpires: "",
            },
          }
        );

        console.error("Reset email failed:", error.code || "EMAIL_FAILED");
      }
    }

    // Same response for missing, disabled and existing accounts.
    return res.json({ success: true, message: RESET_MESSAGE });
  } catch (error) {
    return handleError(res, error, "Password recovery is unavailable.");
  }
}

async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body || {};

    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      return fail(res, 400, "This reset link is invalid or has expired.");
    }

    const message = passwordError(newPassword);
    if (message) return fail(res, 400, message);

    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Consume the token and update the password in one atomic operation.
    const user = await User.findOneAndUpdate(
      {
        passwordResetToken: hash,
        passwordResetExpires: { $gt: new Date() },
        isActive: { $ne: false },
      },
      {
        $set: { password: passwordHash },
        $unset: {
          passwordResetToken: "",
          passwordResetExpires: "",
        },
        $inc: { authVersion: 1 },
      },
      { new: true }
    );

    if (!user) {
      return fail(res, 400, "This reset link is invalid or has expired.");
    }

    return res.json({
      success: true,
      message: "Password reset successfully. Sign in with your new password.",
    });
  } catch (error) {
    return handleError(res, error, "Password could not be reset.");
  }
}

module.exports = {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
};