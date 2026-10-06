const mongoose =
  require("mongoose");

const bcrypt =
  require("bcryptjs");


// ======================================================
// USER SCHEMA
// ======================================================

const userSchema =
  new mongoose.Schema(
    {
      // ==================================================
      // NAME
      // ==================================================

      name: {
        type:
          String,

        required: [
          true,
          "Name is required",
        ],

        trim:
          true,

        minlength: [
          2,
          "Name must contain at least 2 characters",
        ],

        maxlength: [
          60,
          "Name cannot exceed 60 characters",
        ],
      },


      // ==================================================
      // EMAIL
      // ==================================================

      email: {
        type:
          String,

        required: [
          true,
          "Email is required",
        ],

        unique:
          true,

        lowercase:
          true,

        trim:
          true,

        maxlength:
          150,

        match: [
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
          "Please enter a valid email address",
        ],
      },


      // ==================================================
      // MOBILE NUMBER
      //
      // Optional.
      //
      // Current GymDrobe validation uses Indian
      // 10-digit mobile numbers beginning with 6–9.
      // ==================================================

      phone: {
        type:
          String,

        default:
          "",

        trim:
          true,

        maxlength:
          10,

        validate: {
          validator(
            value
          ) {
            /*
              Empty phone number is allowed.

              If supplied:
              - exactly 10 digits
              - starts with 6, 7, 8 or 9
            */

            if (
              !value
            ) {
              return true;
            }


            return /^[6-9]\d{9}$/.test(
              value
            );
          },

          message:
            "Please enter a valid 10-digit mobile number",
        },
      },


      // ==================================================
      // PASSWORD
      // ==================================================

      password: {
        type:
          String,

        required: [
          true,
          "Password is required",
        ],

        minlength: [
          8,
          "Password must contain at least 8 characters",
        ],

        /*
          Password hashes must never be returned through
          normal User queries.
        */

        select:
          false,
      },


      // ==================================================
      // USER ROLE
      // ==================================================

      role: {
        type:
          String,

        enum: [
          "customer",
          "admin",
        ],

        default:
          "customer",

        index:
          true,
      },


      // ==================================================
      // ACCOUNT STATUS
      // ==================================================

      isActive: {
        type:
          Boolean,

        default:
          true,

        index:
          true,
      },
    },

    {
      timestamps:
        true,

      /*
        We also remove the password if a query ever
        explicitly selected it and then converted the
        user to JSON.
      */

      toJSON: {
        transform(
          doc,
          ret
        ) {
          delete ret.password;
          delete ret.__v;

          return ret;
        },
      },

      toObject: {
        transform(
          doc,
          ret
        ) {
          delete ret.password;
          delete ret.__v;

          return ret;
        },
      },
    }
  );


// ======================================================
// NORMALIZE USER BEFORE VALIDATION
// ======================================================

userSchema.pre(
  "validate",

  function () {
    if (
      typeof this.name ===
      "string"
    ) {
      this.name =
        this.name.trim();
    }


    if (
      typeof this.email ===
      "string"
    ) {
      this.email =
        this.email
          .trim()
          .toLowerCase();
    }


    if (
      typeof this.phone ===
      "string"
    ) {
      /*
        Store phone number as digits only.

        Example:

        "98765 43210"
        becomes
        "9876543210"
      */

      this.phone =
        this.phone.replace(
          /\D/g,
          ""
        );
    }
  }
);


// ======================================================
// HASH PASSWORD BEFORE SAVING
// ======================================================

userSchema.pre(
  "save",

  async function () {
    /*
      Do not hash password again when only changing
      profile information such as name or phone.
    */

    if (
      !this.isModified(
        "password"
      )
    ) {
      return;
    }


    const salt =
      await bcrypt.genSalt(
        12
      );


    this.password =
      await bcrypt.hash(
        this.password,
        salt
      );
  }
);


// ======================================================
// COMPARE LOGIN PASSWORD
// ======================================================

userSchema.methods.comparePassword =
  async function (
    enteredPassword
  ) {
    /*
      Login queries must explicitly request:

      .select("+password")

      because password uses select: false.
    */

    if (
      !this.password
    ) {
      return false;
    }


    return bcrypt.compare(
      String(
        enteredPassword ||
          ""
      ),

      this.password
    );
  };


// ======================================================
// MODEL
// ======================================================

const User =
  mongoose.model(
    "User",
    userSchema
  );


module.exports =
  User;