const mongoose = require("mongoose");


const addressSchema =
  new mongoose.Schema(
    {
      user: {
        type:
          mongoose.Schema.Types.ObjectId,

        ref: "User",

        required: true,

        index: true,
      },


      fullName: {
        type: String,

        required: [
          true,
          "Full name is required.",
        ],

        trim: true,

        minlength: 2,

        maxlength: 100,
      },


      email: {
        type: String,

        required: [
          true,
          "Email is required.",
        ],

        trim: true,

        lowercase: true,

        maxlength: 150,
      },


      phone: {
        type: String,

        required: [
          true,
          "Phone number is required.",
        ],

        trim: true,

        match: [
          /^[6-9]\d{9}$/,

          "Enter a valid Indian mobile number.",
        ],
      },


      addressLine: {
        type: String,

        required: [
          true,
          "Address is required.",
        ],

        trim: true,

        minlength: 5,

        maxlength: 200,
      },


      landmark: {
        type: String,

        default: "",

        trim: true,

        maxlength: 150,
      },


      city: {
        type: String,

        required: [
          true,
          "City is required.",
        ],

        trim: true,

        maxlength: 100,
      },


      state: {
        type: String,

        required: [
          true,
          "State is required.",
        ],

        trim: true,

        maxlength: 100,
      },


      pincode: {
        type: String,

        required: [
          true,
          "Pincode is required.",
        ],

        trim: true,

        match: [
          /^[1-9]\d{5}$/,

          "Enter a valid 6-digit pincode.",
        ],
      },


      label: {
        type: String,

        trim: true,

        maxlength: 30,

        default: "Home",
      },


      isDefault: {
        type: Boolean,

        default: false,
      },
    },

    {
      timestamps: true,
    }
  );


addressSchema.index({
  user: 1,
  isDefault: -1,
  createdAt: -1,
});


const Address =
  mongoose.model(
    "Address",
    addressSchema
  );


module.exports =
  Address;