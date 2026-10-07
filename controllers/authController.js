const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const User = require("../models/User");

const googleClient = new OAuth2Client();

function fail(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
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
      "An account changed during sign-in. Please try again."
    );
  }

  if (error.name === "ValidationError") {
    const first = Object.values(error.errors || {})[0];
    return fail(res, 400, first?.message || "Check your information.");
  }

  console.error(
    "Authentication operation failed:",
    error.name || "Error"
  );

  return fail(res, 500, message);
}

function validEmail(email) {
  return (
    typeof email === "string" &&
    email.length <= 150 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

// The frontend obtains this before opening Google sign-in.
// The nonce connects Google's response to this sign-in attempt.
async function googleChallenge(req, res) {
  if (!process.env.JWT_SECRET || !process.env.GOOGLE_CLIENT_ID) {
    return fail(res, 503, "Google sign-in is not configured yet.");
  }

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
    return handleError(res, error, "Google sign-in could not start.");
  }
}

async function googleLogin(req, res) {
  if (!process.env.JWT_SECRET || !process.env.GOOGLE_CLIENT_ID) {
    return fail(res, 503, "Google sign-in is not configured yet.");
  }

  const { credential, challenge, existingPassword } = req.body || {};

  if (
    typeof credential !== "string" ||
    credential.length > 12000 ||
    typeof challenge !== "string" ||
    challenge.length > 2000
  ) {
    return fail(res, 400, "Please start Google sign-in again.");
  }

  let attempt;
  let payload;

  try {
    attempt = jwt.verify(challenge, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      audience: "gymdrobe-google-login",
    });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID.trim(),
    });

    payload = ticket.getPayload();

    if (
      !payload ||
      typeof attempt.nonce !== "string" ||
      payload.nonce !== attempt.nonce ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 255 ||
      payload.email_verified !== true
    ) {
      return fail(res, 401, "Google sign-in could not be verified.");
    }
  } catch {
    return fail(
      res,
      401,
      "Google sign-in expired or could not be verified. Please try again."
    );
  }

  const email =
    typeof payload.email === "string"
      ? payload.email.trim().toLowerCase()
      : "";

  if (!validEmail(email)) {
    return fail(res, 400, "Google did not provide a valid email address.");
  }

  try {
    let user = await User.findOne({
      googleId: payload.sub,
    }).select("+googleId +authVersion");

    if (user) {
      if (user.isActive === false) {
        return fail(res, 403, "This account is disabled.");
      }

      return sendSession(res, user);
    }

    user = await User.findOne({ email }).select(
      "+googleId +password +authVersion"
    );

    if (user) {
      if (user.isActive === false) {
        return fail(res, 403, "This account is disabled.");
      }

      if (user.googleId && user.googleId !== payload.sub) {
        return fail(
          res,
          409,
          "This account is connected to another Google account."
        );
      }

      // Google controls Gmail and verified Workspace mailboxes.
      // Other email providers need proof of the existing account.
      // Existing admins always need that extra proof when linking.
      const googleControlsEmail =
        email.endsWith("@gmail.com") ||
        (typeof payload.hd === "string" && payload.hd.length > 0);

      if (user.role === "admin" || !googleControlsEmail) {
        if (!(await user.comparePassword(existingPassword))) {
          return res.status(409).json({
            success: false,
            code: "ACCOUNT_LINK_REQUIRED",
            message:
              "Enter your existing GymDrobe password once to connect this Google account.",
          });
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

      // Ensure the password did not change while verifying it.
      if (user.role === "admin" || !googleControlsEmail) {
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
          "Your account changed. Please start Google sign-in again."
        );
      }

      return sendSession(res, linked);
    }

    let name =
      typeof payload.name === "string"
        ? payload.name.trim().slice(0, 60)
        : "";

    if (name.length < 2) {
      name = "GymDrobe Customer";
    }

    // Role is set by the server. Google sign-in never grants admin access.
    const created = await User.create({
      name,
      email,
      googleId: payload.sub,
      role: "customer",
    });

    return sendSession(res, created);
  } catch (error) {
    return handleError(res, error, "Google sign-in could not be completed.");
  }
}

async function getMe(req, res) {
  if (!req.user) {
    return fail(res, 401, "Authentication required.");
  }

  return res.json({
    success: true,
    user: safeUser(req.user),
  });
}

async function updateProfile(req, res) {
  if (!req.user) {
    return fail(res, 401, "Authentication required.");
  }

  try {
    const body = req.body || {};
    const updates = {};

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const name =
        typeof body.name === "string" ? body.name.trim() : "";

      if (name.length < 2 || name.length > 60) {
        return fail(res, 400, "Name must contain 2–60 characters.");
      }

      updates.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(body, "phone")) {
      const phone = String(body.phone ?? "").replace(/\D/g, "");

      if (phone && !/^[6-9]\d{9}$/.test(phone)) {
        return fail(res, 400, "Please enter a valid 10-digit mobile number.");
      }

      updates.phone = phone;
    }

    if (!Object.keys(updates).length) {
      return fail(res, 400, "No profile changes were provided.");
    }

    const user = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        isActive: { $ne: false },
      },
      { $set: updates },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!user) {
      return fail(res, 403, "Account is unavailable.");
    }

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      user: safeUser(user),
    });
  } catch (error) {
    return handleError(res, error, "Profile could not be updated.");
  }
}

// Compatibility exports keep the existing router loading.
// Password-based endpoints are disabled.
function googleOnly(req, res) {
  return fail(
    res,
    410,
    "Please use Continue with Google to access your GymDrobe account."
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