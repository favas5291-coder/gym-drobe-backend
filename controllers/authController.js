const jwt =
  require("jsonwebtoken");

const User =
  require("../models/User");


// ======================================================
// CREATE JWT
// ======================================================

function generateToken(
  userId
) {
  if (
    !process.env.JWT_SECRET
  ) {
    throw new Error(
      "JWT_SECRET is missing from backend/.env"
    );
  }


  return jwt.sign(
    {
      userId,
    },

    process.env.JWT_SECRET,

    {
      expiresIn:
        process.env.JWT_EXPIRES_IN ||
        "7d",
    }
  );
}


// ======================================================
// SAFE USER RESPONSE
// ======================================================

function safeUser(
  user
) {
  return {
    id:
      user._id,

    name:
      user.name,

    email:
      user.email,

    phone:
      user.phone ||
      "",

    role:
      user.role,

    isActive:
      user.isActive,

    createdAt:
      user.createdAt,

    updatedAt:
      user.updatedAt,
  };
}


// ======================================================
// CLEAN PHONE
// ======================================================

function cleanPhone(
  value
) {
  return String(
    value ?? ""
  ).replace(
    /\D/g,
    ""
  );
}


// ======================================================
// ERROR HELPER
// ======================================================

function sendUserError(
  res,
  error,
  fallbackMessage
) {
  if (
    error?.code ===
    11000
  ) {
    return res
      .status(409)
      .json({
        success:
          false,

        message:
          "An account with this email already exists.",
      });
  }


  if (
    error?.name ===
    "ValidationError"
  ) {
    const message =
      Object.values(
        error.errors ||
          {}
      )[0]?.message ||
      "Invalid user information.";


    return res
      .status(400)
      .json({
        success:
          false,

        message,
      });
  }


  return res
    .status(500)
    .json({
      success:
        false,

      message:
        fallbackMessage,
    });
}


// ======================================================
// REGISTER
// POST /api/auth/register
// ======================================================

const register =
  async (
    req,
    res
  ) => {
    try {
      const {
        name,
        email,
        password,
        phone,
      } =
        req.body || {};


      if (
        !name ||
        !email ||
        !password
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Name, email and password are required.",
          });
      }


      const cleanEmail =
        String(
          email
        )
          .trim()
          .toLowerCase();


      const cleanName =
        String(
          name
        ).trim();


      const cleanMobile =
        cleanPhone(
          phone
        );


      if (
        cleanName.length <
        2
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Name must contain at least 2 characters.",
          });
      }


      if (
        cleanMobile &&
        !/^[6-9]\d{9}$/.test(
          cleanMobile
        )
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Please enter a valid 10-digit mobile number.",
          });
      }


      const existingUser =
        await User.findOne({
          email:
            cleanEmail,
        });


      if (
        existingUser
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            message:
              "An account with this email already exists.",
          });
      }


      const user =
        await User.create({
          name:
            cleanName,

          email:
            cleanEmail,

          phone:
            cleanMobile,

          password,
        });


      const token =
        generateToken(
          user._id
        );


      return res
        .status(201)
        .json({
          success:
            true,

          message:
            "Account created successfully.",

          token,

          user:
            safeUser(
              user
            ),
        });

    } catch (
      error
    ) {
      console.error(
        "Register error:",
        error
      );


      return sendUserError(
        res,
        error,
        "Unable to create account."
      );
    }
  };


// ======================================================
// LOGIN
// POST /api/auth/login
// ======================================================

const login =
  async (
    req,
    res
  ) => {
    try {
      const {
        email,
        password,
      } =
        req.body || {};


      if (
        !email ||
        !password
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Email and password are required.",
          });
      }


      const cleanEmail =
        String(
          email
        )
          .trim()
          .toLowerCase();


      const user =
        await User.findOne({
          email:
            cleanEmail,
        }).select(
          "+password"
        );


      if (
        !user
      ) {
        return res
          .status(401)
          .json({
            success:
              false,

            message:
              "Invalid email or password.",
          });
      }


      if (
        user.isActive ===
        false
      ) {
        return res
          .status(403)
          .json({
            success:
              false,

            message:
              "This account is currently disabled.",
          });
      }


      const passwordMatches =
        await user.comparePassword(
          password
        );


      if (
        !passwordMatches
      ) {
        return res
          .status(401)
          .json({
            success:
              false,

            message:
              "Invalid email or password.",
          });
      }


      const token =
        generateToken(
          user._id
        );


      return res
        .status(200)
        .json({
          success:
            true,

          message:
            "Login successful.",

          token,

          user:
            safeUser(
              user
            ),
        });

    } catch (
      error
    ) {
      console.error(
        "Login error:",
        error
      );


      return res
        .status(500)
        .json({
          success:
            false,

          message:
            "Unable to login.",
        });
    }
  };


// ======================================================
// CURRENT USER
// GET /api/auth/me
// ======================================================

const getMe =
  async (
    req,
    res
  ) => {
    if (
      !req.user
    ) {
      return res
        .status(401)
        .json({
          success:
            false,

          message:
            "Authentication required.",
        });
    }


    return res
      .status(200)
      .json({
        success:
          true,

        user:
          safeUser(
            req.user
          ),
      });
  };


// ======================================================
// UPDATE PROFILE
// PUT /api/auth/profile
// ======================================================

const updateProfile =
  async (
    req,
    res
  ) => {
    try {
      if (
        !req.user
      ) {
        return res
          .status(401)
          .json({
            success:
              false,

            message:
              "Authentication required.",
          });
      }


      const body =
        req.body || {};


      const hasName =
        Object.prototype.hasOwnProperty.call(
          body,
          "name"
        );


      const hasPhone =
        Object.prototype.hasOwnProperty.call(
          body,
          "phone"
        );


      if (
        !hasName &&
        !hasPhone
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Provide a name or mobile number to update.",
          });
      }


      const user =
        await User.findById(
          req.user._id
        );


      if (
        !user
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            message:
              "User account not found.",
          });
      }


      if (
        user.isActive ===
        false
      ) {
        return res
          .status(403)
          .json({
            success:
              false,

            message:
              "This account is currently disabled.",
          });
      }


      if (
        hasName
      ) {
        const cleanName =
          String(
            body.name ??
              ""
          ).trim();


        if (
          cleanName.length <
          2
        ) {
          return res
            .status(400)
            .json({
              success:
                false,

              message:
                "Name must contain at least 2 characters.",
            });
        }


        if (
          cleanName.length >
          60
        ) {
          return res
            .status(400)
            .json({
              success:
                false,

              message:
                "Name cannot exceed 60 characters.",
            });
        }


        user.name =
          cleanName;
      }


      if (
        hasPhone
      ) {
        const phone =
          cleanPhone(
            body.phone
          );


        if (
          phone &&
          !/^[6-9]\d{9}$/.test(
            phone
          )
        ) {
          return res
            .status(400)
            .json({
              success:
                false,

              message:
                "Please enter a valid 10-digit mobile number.",
            });
        }


        user.phone =
          phone;
      }


      await user.save();


      return res
        .status(200)
        .json({
          success:
            true,

          message:
            "Profile updated successfully.",

          user:
            safeUser(
              user
            ),
        });

    } catch (
      error
    ) {
      console.error(
        "Update profile error:",
        error
      );


      return sendUserError(
        res,
        error,
        "Unable to update profile."
      );
    }
  };


// ======================================================
// CHANGE PASSWORD
// PUT /api/auth/password
//
// Requires:
// - currentPassword
// - newPassword
//
// Password itself is never returned.
// ======================================================

const changePassword =
  async (
    req,
    res
  ) => {
    try {
      if (
        !req.user
      ) {
        return res
          .status(401)
          .json({
            success:
              false,

            message:
              "Authentication required.",
          });
      }


      const {
        currentPassword,
        newPassword,
      } =
        req.body || {};


      if (
        !currentPassword ||
        !newPassword
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Current password and new password are required.",
          });
      }


      const cleanCurrent =
        String(
          currentPassword
        );


      const cleanNew =
        String(
          newPassword
        );


      if (
        cleanNew.length <
        8
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "New password must contain at least 8 characters.",
          });
      }


      if (
        cleanNew.length >
        128
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "New password cannot exceed 128 characters.",
          });
      }


      if (
        cleanCurrent ===
        cleanNew
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Choose a new password that is different from your current password.",
          });
      }


      /*
        password uses select:false,
        therefore we must explicitly request it.
      */

      const user =
        await User.findById(
          req.user._id
        ).select(
          "+password"
        );


      if (
        !user
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            message:
              "User account not found.",
          });
      }


      if (
        user.isActive ===
        false
      ) {
        return res
          .status(403)
          .json({
            success:
              false,

            message:
              "This account is currently disabled.",
          });
      }


      const matches =
        await user.comparePassword(
          cleanCurrent
        );


      if (
        !matches
      ) {
        return res
          .status(401)
          .json({
            success:
              false,

            message:
              "Current password is incorrect.",
          });
      }


      /*
        Assigning the plain new password here is correct.

        User.js has a pre-save hook that hashes it before
        MongoDB stores it.
      */

      user.password =
        cleanNew;


      await user.save();


      return res
        .status(200)
        .json({
          success:
            true,

          message:
            "Password changed successfully.",
        });

    } catch (
      error
    ) {
      console.error(
        "Change password error:",
        error
      );


      return sendUserError(
        res,
        error,
        "Unable to change password."
      );
    }
  };


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
};