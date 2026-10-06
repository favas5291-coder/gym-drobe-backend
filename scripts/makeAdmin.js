const mongoose =
  require("mongoose");

const dotenv =
  require("dotenv");


dotenv.config();


const connectDB =
  require("../config/db");

const User =
  require("../models/User");


// ======================================================
// MAKE EXISTING USER AN ADMIN
//
// Usage:
//
// node scripts/makeAdmin.js email@example.com
//
// This does NOT create a new account.
// The user must already be registered.
// ======================================================

async function makeAdmin() {
  const email =
    String(
      process.argv[2] ||
        ""
    )
      .trim()
      .toLowerCase();


  // ====================================================
  // REQUIRE EMAIL
  // ====================================================

  if (!email) {
    console.error(
      "❌ Please provide the registered user's email."
    );


    console.log(
      "\nExample:"
    );


    console.log(
      "node scripts/makeAdmin.js admin@example.com"
    );


    process.exitCode =
      1;


    return;
  }


  // ====================================================
  // BASIC EMAIL VALIDATION
  // ====================================================

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      email
    )
  ) {
    console.error(
      "❌ Please provide a valid email address."
    );


    process.exitCode =
      1;


    return;
  }


  try {
    console.log(
      "Connecting to MongoDB..."
    );


    await connectDB();


    // ==================================================
    // FIND EXISTING USER
    // ==================================================

    const user =
      await User.findOne({
        email,
      });


    if (!user) {
      console.error(
        "❌ No registered user was found with that email."
      );


      console.log(
        "Register the account on GymDrobe first, then run this script again."
      );


      process.exitCode =
        1;


      return;
    }


    // ==================================================
    // ALREADY ADMIN
    // ==================================================

    if (
      user.role ===
      "admin"
    ) {
      console.log(
        "✅ This user is already an admin."
      );


      console.log(
        `Email: ${user.email}`
      );


      return;
    }


    // ==================================================
    // PROMOTE USER
    // ==================================================

    user.role =
      "admin";


    await user.save();


    console.log(
      "\n✅ Admin access granted successfully."
    );


    console.log(
      `Name: ${user.name}`
    );


    console.log(
      `Email: ${user.email}`
    );


    console.log(
      `Role: ${user.role}`
    );


    console.log(
      "\nSign out and sign back in, or refresh the authenticated session, before opening the admin dashboard."
    );

  } catch (
    error
  ) {
    console.error(
      "\n❌ Unable to grant admin access:"
    );


    console.error(
      error.message
    );


    process.exitCode =
      1;

  } finally {
    if (
      mongoose.connection
        .readyState !==
      0
    ) {
      await mongoose.disconnect();
    }
  }
}


makeAdmin();