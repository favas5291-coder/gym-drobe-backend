const jwt = require("jsonwebtoken");

const User = require("../models/User");


// ======================================================
// PROTECT PRIVATE ROUTES
// ======================================================

const protect = async (
  req,
  res,
  next
) => {
  try {
    let token;

    const authorization =
      req.headers.authorization;


    // Expected:
    // Authorization: Bearer TOKEN

    if (
      authorization &&
      authorization.startsWith(
        "Bearer "
      )
    ) {
      token =
        authorization.split(
          " "
        )[1];
    }


    if (!token) {
      return res
        .status(401)
        .json({
          success: false,

          message:
            "Authentication required.",
        });
    }


    if (
      !process.env.JWT_SECRET
    ) {
      throw new Error(
        "JWT_SECRET is missing."
      );
    }


    const decoded =
      jwt.verify(
        token,
        process.env.JWT_SECRET
      );


    const user =
      await User.findById(
        decoded.userId
      );


    if (!user) {
      return res
        .status(401)
        .json({
          success: false,

          message:
            "User account no longer exists.",
        });
    }


    if (
      user.isActive ===
      false
    ) {
      return res
        .status(403)
        .json({
          success: false,

          message:
            "This account is disabled.",
        });
    }


    req.user =
      user;


    next();

  } catch (error) {
    console.error(
      "Authentication error:",
      error.message
    );


    if (
      error.name ===
        "JsonWebTokenError" ||
      error.name ===
        "TokenExpiredError"
    ) {
      return res
        .status(401)
        .json({
          success: false,

          message:
            "Invalid or expired login session.",
        });
    }


    return res
      .status(401)
      .json({
        success: false,

        message:
          "Authentication failed.",
      });
  }
};


// ======================================================
// ADMIN ONLY
//
// Must be used AFTER protect.
//
// Example:
//
// router.get(
//   "/admin/orders",
//   protect,
//   adminOnly,
//   controller
// );
// ======================================================

const adminOnly = (
  req,
  res,
  next
) => {
  if (
    !req.user
  ) {
    return res
      .status(401)
      .json({
        success: false,

        message:
          "Authentication required.",
      });
  }


  if (
    req.user.role !==
    "admin"
  ) {
    return res
      .status(403)
      .json({
        success: false,

        message:
          "Admin access required.",
      });
  }


  next();
};


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  protect,
  adminOnly,
};