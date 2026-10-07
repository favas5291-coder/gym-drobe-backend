const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const User = require("../models/User");

const googleClient = new OAuth2Client();

function fail(res, status, code, message) {
  return res.status(status).json({
    success: false,
    code,
    message,
  });
}

function configured() {
  return Boolean(
    process.env.JWT_SECRET?.trim() &&
    process.env.GOOGLE_CLIENT_ID?.trim()
  );
}

function unavailable(res) {
  return fail(
    res,
    503,
    "LOGIN_UNAVAILABLE",
    "Google sign-in is temporarily unavailable. Please try again later or contact GymDrobe support."
  );
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

function sendSession(res, user) {
  const token = jwt.sign(
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

  res.set("Cache-Control", "no-store");

  return res.json({
    success: true,
    message: "Signed in successfully.",
    token,
    user: safeUser(user),
  });
}

function handleError(res, error, message) {
  if (error.code === 11000) {
    return fail(
      res,
      409,
      "ACCOUNT_CHANGED",
      "Your account was updated during sign-in. Please start Google sign-in again."
    );
  }

  if (error.name === "ValidationError") {
    return fail(
      res,
      400,
      "ACCOUNT_DATA_INVALID",
      "Your account information could not be saved. Please contact GymDrobe support."
    );
  }

  // Do not log credentials, tokens, passwords or full provider responses.
  console.error(
    "Authentication operation failed:",
    error.name || "Error"
  );

  return fail(res, 503, "SERVICE_UNAVAILABLE", message);
}

function validEmail(email) {
  return (
    typeof email === "string" &&
    email.length <= 150 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function accountDisabled(res) {
  return fail(
    res,
    403,
    "ACCOUNT_DISABLED",
    "This GymDrobe account is disabled. Contact support for help."
  );
}

function providerUnavailable(error) {
  const status = Number(error.response?.status);

  return (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ].includes(error.code) ||
    status === 429 ||
    status >= 500
  );
}

async function googleChallenge(req, res) {
  if (!configured()) return unavailable(res);

  try {
    const nonce = crypto.randomBytes(32).toString("hex");

    const challenge = jwt.sign(
      { nonce },
      process.env.JWT_SECRET,
      {
        algorithm: "HS256",
        audience: "gymdrobe-google-login",
        expiresIn: "10m",
      }
    );

    res.set("Cache-Control", "no-store");

    return res.json({
      success: true,
      nonce,
      challenge,
    });
  } catch (error) {
    return handleError(
      res,
      error,
      "Google sign-in could not start. Please try again later."
    );
  }
}

async function googleLogin(req, res) {
  if (!configured()) return unavailable(res);

  const { credential, challenge, existingPassword } = req.body || {};

  if (
    typeof credential !== "string" ||
    !credential ||
    credential.length > 12000 ||
    typeof challenge !== "string" ||
    !challenge ||
    challenge.length > 2000
  ) {
    return fail(
      res,
      400,
      "SIGNIN_RESTART_REQUIRED",
      "The sign-in request is incomplete. Please start Google sign-in again."
    );
  }

  let attempt;

  try {
    attempt = jwt.verify(challenge, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      audience: "gymdrobe-google-login",
    });

    if (
      !attempt ||
      typeof attempt !== "object" ||
      typeof attempt.nonce !== "string"
    ) {
      return fail(
        res,
        401,
        "SIGNIN_RESTART_REQUIRED",
        "This sign-in attempt is invalid. Please start again."
      );
    }
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return fail(
        res,
        401,
        "SIGNIN_EXPIRED",
        "This Google sign-in attempt has expired. Please start again."
      );
    }

    return fail(
      res,
      401,
      "SIGNIN_RESTART_REQUIRED",
      "This sign-in attempt could not be verified. Please start again."
    );
  }

  let payload;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID.trim(),
    });

    payload = ticket.getPayload();
  } catch (error) {
    if (providerUnavailable(error)) {
      return fail(
        res,
        503,
        "GOOGLE_UNAVAILABLE",
        "GymDrobe could not contact Google's verification service. Please try again later."
      );
    }

    return fail(
      res,
      401,
      "GOOGLE_VERIFICATION_FAILED",
      "Google sign-in could not be verified. Please start again and select your account."
    );
  }

  if (
    !payload ||
    payload.nonce !== attempt.nonce ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.sub.length > 255
  ) {
    return fail(
      res,
      401,
      "GOOGLE_VERIFICATION_FAILED",
      "Google sign-in could not be verified. Please start again."
    );
  }

  if (payload.email_verified !== true) {
    return fail(
      res,
      400,
      "GOOGLE_EMAIL_UNVERIFIED",
      "Google has not verified this email address. Use a verified Google account."
    );
  }

  const email =
    typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : "";

  if (!validEmail(email)) {
    return fail(
      res,
      400,
      "GOOGLE_EMAIL_INVALID",
      "Google did not provide a usable email address. Please choose another Google account."
    );
  }

  try {
    let user = await User.findOne({
      googleId: payload.sub,
    }).select("+googleId +authVersion");

    if (user) {
      if (user.isActive === false) return accountDisabled(res);
      return sendSession(res, user);
    }

    user = await User.findOne({ email }).select(
      "+googleId +password +authVersion"
    );

    if (user) {
      if (user.isActive === false) return accountDisabled(res);

      if (user.googleId) {
        if (user.googleId === payload.sub) {
          return sendSession(res, user);
        }

        return fail(
          res,
          409,
          "GOOGLE_ACCOUNT_CONFLICT",
          "This GymDrobe account is linked to a different Google account. Use the linked account or contact support."
        );
      }

      const googleControlsEmail =
        email.endsWith("@gmail.com") ||
        (typeof payload.hd === "string" && payload.hd.length > 0);

      // Preserve the existing account-linking protection.
      const needsPassword =
        user.role === "admin" || !googleControlsEmail;

      if (needsPassword) {
        const supplied =
          typeof existingPassword === "string" &&
          existingPassword.length > 0;

        if (!supplied || !(await user.comparePassword(existingPassword))) {
          return fail(
            res,
            409,
            "ACCOUNT_LINK_REQUIRED",
            supplied
              ? "The existing GymDrobe password is incorrect. Try again or contact support."
              : "Enter your existing GymDrobe password once to connect your Google account."
          );
        }
      }

      const conditions = {
        _id: user._id,
        isActive: { $ne: false },
        $or: [
          { googleId: { $exists: false } },
          { googleId: null },
        ],
      };

      if (needsPassword) {
        conditions.password = user.password;
      }

      const linked = await User.findOneAndUpdate(
        conditions,
        { $set: { googleId: payload.sub } },
        { new: true, runValidators: true }
      ).select("+authVersion");

      if (!linked) {
        return fail(
          res,
          409,
          "ACCOUNT_CHANGED",
          "Your account changed during sign-in. Please start again."
        );
      }

      return sendSession(res, linked);
    }

    let name =
      typeof payload.name === "string"
        ? payload.name.trim().slice(0, 60)
        : "";

    if (name.length < 2) name = "GymDrobe Customer";

    const created = await User.create({
      name,
      email,
      googleId: payload.sub,
      role: "customer",
    });

    return sendSession(res, created);
  } catch (error) {
    return handleError(
      res,
      error,
      "GymDrobe could not complete sign-in. Please try again later."
    );
  }
}

async function getMe(req, res) {
  if (!req.user) {
    return fail(
      res,
      401,
      "SESSION_EXPIRED",
      "Your session has expired. Please sign in again."
    );
  }

  return res.json({
    success: true,
    user: safeUser(req.user),
  });
}

async function updateProfile(req, res) {
  if (!req.user) {
    return fail(
      res,
      401,
      "SESSION_EXPIRED",
      "Your session has expired. Please sign in again."
    );
  }

  try {
    const body = req.body || {};
    const updates = {};

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const name =
        typeof body.name === "string" ? body.name.trim() : "";

      if (name.length < 2 || name.length > 60) {
        return fail(
          res,
          400,
          "INVALID_PROFILE",
          "Name must contain 2–60 characters."
        );
      }

      updates.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(body, "phone")) {
      const phone = String(body.phone ?? "").replace(/\D/g, "");

      if (phone && !/^[6-9]\d{9}$/.test(phone)) {
        return fail(
          res,
          400,
          "INVALID_PROFILE",
          "Enter a valid 10-digit Indian mobile number."
        );
      }

      updates.phone = phone;
    }

    if (!Object.keys(updates).length) {
      return fail(
        res,
        400,
        "INVALID_PROFILE",
        "No profile changes were provided."
      );
    }

    const user = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        isActive: { $ne: false },
      },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!user) return accountDisabled(res);

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      user: safeUser(user),
    });
  } catch (error) {
    return handleError(
      res,
      error,
      "Your profile could not be updated. Please try again later."
    );
  }
}

function googleOnly(req, res) {
  return fail(
    res,
    410,
    "GOOGLE_ONLY",
    "Use Continue with Google to access your GymDrobe account."
  );
}

module.exports = {
  googleChallenge,
  googleLogin,
  getMe,
  updateProfile,
  register: googleOnly,
  login: googleOnly,
  changePassword: googleOnly,
  forgotPassword: googleOnly,
  resetPassword: googleOnly,
};