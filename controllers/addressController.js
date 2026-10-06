const Address =
  require("../models/Address");


const ADDRESS_FIELDS = [
  "fullName",
  "email",
  "phone",
  "addressLine",
  "landmark",
  "city",
  "state",
  "pincode",
  "label",
];


// ======================================================
// CLEAN INPUT
// ======================================================

function cleanAddressInput(
  input = {},
  partial = false
) {
  const result = {};


  ADDRESS_FIELDS.forEach(
    (field) => {
      if (
        !partial ||
        Object.prototype.hasOwnProperty.call(
          input,
          field
        )
      ) {
        result[field] =
          String(
            input[field] ?? ""
          ).trim();
      }
    }
  );


  if (
    !partial ||
    Object.prototype.hasOwnProperty.call(
      input,
      "isDefault"
    )
  ) {
    result.isDefault =
      Boolean(
        input.isDefault
      );
  }


  return result;
}


// ======================================================
// VALIDATE ADDRESS
// ======================================================

function validateAddress(
  address
) {
  const errors = {};


  const text = (
    field
  ) =>
    String(
      address[field] ?? ""
    ).trim();


  if (
    text("fullName")
      .length < 2
  ) {
    errors.fullName =
      "Enter your full name.";
  }


  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      text("email")
    )
  ) {
    errors.email =
      "Enter a valid email.";
  }


  if (
    !/^[6-9]\d{9}$/.test(
      text("phone")
    )
  ) {
    errors.phone =
      "Enter a valid 10-digit Indian mobile number.";
  }


  if (
    text("addressLine")
      .length < 5
  ) {
    errors.addressLine =
      "Enter your house number and street.";
  }


  if (
    !text("city")
  ) {
    errors.city =
      "Enter your city.";
  }


  if (
    !text("state")
  ) {
    errors.state =
      "Enter your state.";
  }


  if (
    !/^[1-9]\d{5}$/.test(
      text("pincode")
    )
  ) {
    errors.pincode =
      "Enter a valid 6-digit pincode.";
  }


  return errors;
}


// ======================================================
// FRONTEND-SAFE ADDRESS
// ======================================================

function safeAddress(
  address
) {
  const value =
    typeof address.toObject ===
    "function"
      ? address.toObject()
      : address;


  return {
    id:
      String(
        value._id
      ),

    fullName:
      value.fullName,

    email:
      value.email,

    phone:
      value.phone,

    addressLine:
      value.addressLine,

    landmark:
      value.landmark || "",

    city:
      value.city,

    state:
      value.state,

    pincode:
      value.pincode,

    label:
      value.label || "Home",

    isDefault:
      Boolean(
        value.isDefault
      ),

    createdAt:
      value.createdAt,

    updatedAt:
      value.updatedAt,
  };
}


// ======================================================
// GET ALL ADDRESSES
// ======================================================

const getAddresses =
  async (
    req,
    res
  ) => {
    try {
      const addresses =
        await Address.find({
          user:
            req.user._id,
        }).sort({
          isDefault: -1,
          createdAt: -1,
        });


      return res
        .status(200)
        .json({
          success: true,

          count:
            addresses.length,

          addresses:
            addresses.map(
              safeAddress
            ),
        });

    } catch (error) {
      console.error(
        "Get addresses error:",
        error
      );


      return res
        .status(500)
        .json({
          success: false,

          message:
            "Unable to load addresses.",
        });
    }
  };


// ======================================================
// CREATE ADDRESS
// ======================================================

const createAddress =
  async (
    req,
    res
  ) => {
    try {
      const payload =
        cleanAddressInput(
          req.body
        );


      const errors =
        validateAddress(
          payload
        );


      if (
        Object.keys(errors)
          .length
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              Object.values(
                errors
              )[0],

            errors,
          });
      }


      const existingCount =
        await Address.countDocuments({
          user:
            req.user._id,
        });


      // First address automatically
      // becomes default.

      payload.isDefault =
        Boolean(
          payload.isDefault
        ) ||
        existingCount === 0;


      const address =
        await Address.create({
          user:
            req.user._id,

          ...payload,
        });


      // Only one default address
      // per customer.

      if (
        address.isDefault
      ) {
        await Address.updateMany(
          {
            user:
              req.user._id,

            _id: {
              $ne:
                address._id,
            },
          },

          {
            $set: {
              isDefault:
                false,
            },
          }
        );
      }


      return res
        .status(201)
        .json({
          success: true,

          message:
            "Address saved.",

          address:
            safeAddress(
              address
            ),
        });

    } catch (error) {
      console.error(
        "Create address error:",
        error
      );


      if (
        error.name ===
        "ValidationError"
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              Object.values(
                error.errors
              )[0]?.message ||
              "Invalid address.",
          });
      }


      return res
        .status(500)
        .json({
          success: false,

          message:
            "Unable to save address.",
        });
    }
  };


// ======================================================
// UPDATE ADDRESS
// ======================================================

const updateAddress =
  async (
    req,
    res
  ) => {
    try {
      const address =
        await Address.findOne({
          _id:
            req.params.id,

          user:
            req.user._id,
        });


      if (!address) {
        return res
          .status(404)
          .json({
            success: false,

            message:
              "Address not found.",
          });
      }


      const wasDefault =
        Boolean(
          address.isDefault
        );


      const updates =
        cleanAddressInput(
          req.body,
          true
        );


      const candidate = {
        ...address.toObject(),

        ...updates,
      };


      const errors =
        validateAddress(
          candidate
        );


      if (
        Object.keys(errors)
          .length
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              Object.values(
                errors
              )[0],

            errors,
          });
      }


      Object.assign(
        address,
        updates
      );


      await address.save();


      // If this was selected as
      // default, unset every other
      // address.

      if (
        address.isDefault
      ) {
        await Address.updateMany(
          {
            user:
              req.user._id,

            _id: {
              $ne:
                address._id,
            },
          },

          {
            $set: {
              isDefault:
                false,
            },
          }
        );
      }


      // If customer unchecked their
      // current default, make sure
      // another default still exists.

      if (
        wasDefault &&
        !address.isDefault
      ) {
        const existingDefault =
          await Address.exists({
            user:
              req.user._id,

            isDefault:
              true,
          });


        if (
          !existingDefault
        ) {
          const fallback =
            await Address.findOne({
              user:
                req.user._id,

              _id: {
                $ne:
                  address._id,
              },
            }).sort({
              createdAt: 1,
            });


          if (fallback) {
            fallback.isDefault =
              true;

            await fallback.save();
          } else {
            address.isDefault =
              true;

            await address.save();
          }
        }
      }


      return res
        .status(200)
        .json({
          success: true,

          message:
            "Address updated.",

          address:
            safeAddress(
              address
            ),
        });

    } catch (error) {
      console.error(
        "Update address error:",
        error
      );


      if (
        error.name ===
        "CastError"
      ) {
        return res
          .status(404)
          .json({
            success: false,

            message:
              "Address not found.",
          });
      }


      if (
        error.name ===
        "ValidationError"
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              Object.values(
                error.errors
              )[0]?.message ||
              "Invalid address.",
          });
      }


      return res
        .status(500)
        .json({
          success: false,

          message:
            "Unable to update address.",
        });
    }
  };


// ======================================================
// DELETE ADDRESS
// ======================================================

const deleteAddress =
  async (
    req,
    res
  ) => {
    try {
      const address =
        await Address.findOne({
          _id:
            req.params.id,

          user:
            req.user._id,
        });


      if (!address) {
        return res
          .status(404)
          .json({
            success: false,

            message:
              "Address not found.",
          });
      }


      const wasDefault =
        Boolean(
          address.isDefault
        );


      await address.deleteOne();


      // If default was removed,
      // promote another address.

      if (wasDefault) {
        const fallback =
          await Address.findOne({
            user:
              req.user._id,
          }).sort({
            createdAt: 1,
          });


        if (fallback) {
          fallback.isDefault =
            true;

          await fallback.save();
        }
      }


      return res
        .status(200)
        .json({
          success: true,

          message:
            "Address removed.",
        });

    } catch (error) {
      console.error(
        "Delete address error:",
        error
      );


      if (
        error.name ===
        "CastError"
      ) {
        return res
          .status(404)
          .json({
            success: false,

            message:
              "Address not found.",
          });
      }


      return res
        .status(500)
        .json({
          success: false,

          message:
            "Unable to remove address.",
        });
    }
  };


module.exports = {
  getAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
};