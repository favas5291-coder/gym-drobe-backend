const express =
  require("express");

const {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
} = require(
  "../controllers/authController"
);

const {
  protect,
} = require(
  "../middleware/authMiddleware"
);


const router =
  express.Router();


// ======================================================
// REGISTER
// POST /api/auth/register
// ======================================================

router.post(
  "/register",
  register
);


// ======================================================
// LOGIN
// POST /api/auth/login
// ======================================================

router.post(
  "/login",
  login
);


// ======================================================
// CURRENT LOGGED-IN USER
// GET /api/auth/me
// ======================================================

router.get(
  "/me",
  protect,
  getMe
);


// ======================================================
// UPDATE PROFILE
// PUT /api/auth/profile
// ======================================================

router.put(
  "/profile",
  protect,
  updateProfile
);


// ======================================================
// CHANGE PASSWORD
// PUT /api/auth/password
// ======================================================

router.put(
  "/password",
  protect,
  changePassword
);


module.exports =
  router;