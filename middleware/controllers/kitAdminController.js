const mongoose = require("mongoose");
const KitTemplate = require("../../models/KitTemplate");
const Product = require("../../models/Product");
const { KIT_LEVELS } = require("../../utils/kitDefinitions");

const PRIVATE_FIELDS = "+fulfillment +createdBy +updatedBy";

function fail(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

function serialize(document) {
  const value = document.toObject({
    transform: false,
  });

  value.id = String(value._id);
  value.version = value.__v ?? 0;

  delete value.__v;

  return value;
}

function handleError(res, error) {
  if (error.name === "ValidationError") {
    return fail(
      res,
      400,
      Object.values(error.errors)
        .map((row) => row.message)
        .join(" "),
    );
  }

  if (error.name === "VersionError" || error.code === 11000) {
    return fail(
      res,
      409,
      "This kit changed. Reload it before saving again.",
    );
  }

  if (error.status) {
    return fail(res, error.status, error.message);
  }

  console.error(
    "Kit administration failed:",
    error.name || "Error",
  );

  return fail(
    res,
    503,
    "Kit administration is temporarily unavailable.",
  );
}

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function validateObject(value, allowedKeys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    invalid(`${label} must be an object.`);
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      invalid(`Unsupported ${label} field: ${key}.`);
    }
  }
}

function validateTypes(
  value,
  strings,
  numbers,
  booleans,
  label,
) {
  for (const key of strings) {
    if (
      value[key] !== undefined &&
      typeof value[key] !== "string"
    ) {
      invalid(`${label}.${key} must be text.`);
    }
  }

  for (const key of numbers) {
    if (
      value[key] !== undefined &&
      (
        typeof value[key] !== "number" ||
        !Number.isFinite(value[key])
      )
    ) {
      invalid(`${label}.${key} must be a finite number.`);
    }
  }

  for (const key of booleans) {
    if (
      value[key] !== undefined &&
      typeof value[key] !== "boolean"
    ) {
      invalid(`${label}.${key} must be true or false.`);
    }
  }
}

function validateId(value, label, nullable = false) {
  if (nullable && value === null) {
    return;
  }

  if (
    typeof value !== "string" ||
    !mongoose.isObjectIdOrHexString(value)
  ) {
    invalid(`${label} must be a valid ID.`);
  }
}

function validateInput(body) {
  validateObject(
    body,
    [
      "version",
      "name",
      "audience",
      "explanation",
      "status",
      "slots",
      "discount",
      "fulfillment",
    ],
    "kit",
  );

  validateTypes(
    body,
    ["name", "audience", "explanation", "status"],
    ["version"],
    [],
    "kit",
  );

  if (
    !Number.isSafeInteger(body.version) ||
    body.version < 0
  ) {
    invalid(
      "Include the kit version returned when you loaded it.",
    );
  }

  if (body.slots !== undefined) {
    if (
      !Array.isArray(body.slots) ||
      body.slots.length > 20
    ) {
      invalid("Use an array of at most 20 kit slots.");
    }

    for (const row of body.slots) {
      validateObject(
        row,
        [
          "key",
          "role",
          "label",
          "whySelected",
          "optional",
          "suggestedEssential",
          "defaultIncluded",
          "defaultProduct",
          "defaultSize",
          "defaultColor",
          "defaultQuantity",
          "maximumQuantity",
          "allowedProducts",
        ],
        "slot",
      );

      validateTypes(
        row,
        ["key", "role", "label", "whySelected"],
        ["defaultQuantity", "maximumQuantity"],
        [
          "optional",
          "suggestedEssential",
          "defaultIncluded",
        ],
        "slot",
      );

      for (const key of ["defaultSize", "defaultColor"]) {
        if (
          row[key] != null &&
          typeof row[key] !== "string"
        ) {
          invalid(`${key} must be text or null.`);
        }
      }

      if (row.defaultProduct !== undefined) {
        validateId(
          row.defaultProduct,
          "Default product",
          true,
        );
      }

      if (row.allowedProducts !== undefined) {
        if (
          !Array.isArray(row.allowedProducts) ||
          row.allowedProducts.length > 50
        ) {
          invalid(
            "Use at most 50 allowed products per slot.",
          );
        }

        row.allowedProducts.forEach((value) => {
          validateId(value, "Allowed product");
        });
      }
    }
  }

  if (body.discount !== undefined) {
    validateObject(
      body.discount,
      [
        "type",
        "value",
        "minimumSubtotal",
        "minimumCategories",
        "requiredRoles",
        "allowCouponStacking",
      ],
      "discount",
    );

    validateTypes(
      body.discount,
      ["type"],
      ["value", "minimumSubtotal", "minimumCategories"],
      ["allowCouponStacking"],
      "discount",
    );

    if (
      body.discount.requiredRoles !== undefined &&
      (
        !Array.isArray(body.discount.requiredRoles) ||
        body.discount.requiredRoles.some(
          (value) => typeof value !== "string",
        )
      )
    ) {
      invalid(
        "Required roles must be an array of category names.",
      );
    }
  }

  if (body.fulfillment !== undefined) {
    validateObject(
      body.fulfillment,
      ["mode", "packingLocation", "customerNote"],
      "fulfillment",
    );

    validateTypes(
      body.fulfillment,
      ["mode", "customerNote"],
      [],
      [],
      "fulfillment",
    );

    if (body.fulfillment.packingLocation !== undefined) {
      validateId(
        body.fulfillment.packingLocation,
        "Packing location",
        true,
      );
    }
  }
}

async function getAdminKits(req, res) {
  try {
    const kits = await KitTemplate.find()
      .select(PRIVATE_FIELDS)
      .sort({ level: 1 });

    return res.json({
      success: true,
      kits: kits.map(serialize),
    });
  } catch (error) {
    return handleError(res, error);
  }
}

async function createKitDrafts(req, res) {
  try {
    const kits = [];

    for (const level of KIT_LEVELS) {
      let kit = await KitTemplate.findOne({ level })
        .select(PRIVATE_FIELDS);

      if (!kit) {
        kit = KitTemplate.makeDraft(level);
        kit.createdBy = req.user._id;
        kit.updatedBy = req.user._id;

        try {
          await kit.save();
        } catch (error) {
          if (error.code !== 11000) {
            throw error;
          }

          // Another admin may have created this level first.
          kit = await KitTemplate.findOne({ level })
            .select(PRIVATE_FIELDS);

          if (!kit) {
            throw error;
          }
        }
      }

      kits.push(serialize(kit));
    }

    return res.json({
      success: true,
      kits,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

async function getAdminKit(req, res) {
  try {
    validateId(req.params.id, "Kit ID");

    const kit = await KitTemplate.findById(req.params.id)
      .select(PRIVATE_FIELDS);

    if (!kit) {
      return fail(res, 404, "Kit not found.");
    }

    return res.json({
      success: true,
      kit: serialize(kit),
    });
  } catch (error) {
    return handleError(res, error);
  }
}

async function updateAdminKit(req, res) {
  try {
    validateId(req.params.id, "Kit ID");
    validateInput(req.body);

    const kit = await KitTemplate.findById(req.params.id)
      .select(PRIVATE_FIELDS);

    if (!kit) {
      return fail(res, 404, "Kit not found.");
    }

    if ((kit.__v ?? 0) !== req.body.version) {
      return fail(
        res,
        409,
        "This kit changed. Reload it before saving again.",
      );
    }

    const editableFields = [
      "name",
      "audience",
      "explanation",
      "status",
      "slots",
      "discount",
      "fulfillment",
    ];

    for (const key of editableFields) {
      if (
        Object.prototype.hasOwnProperty.call(
          req.body,
          key,
        )
      ) {
        kit.set(key, req.body[key]);
      }
    }

    const productIds = [
      ...new Set(
        kit.slots.flatMap((row) =>
          row.allowedProducts.map(String),
        ),
      ),
    ];

    const products = productIds.length
      ? await Product.find({
          _id: { $in: productIds },
        })
          .select("kitSettings")
          .lean()
      : [];

    const productsById = new Map(
      products.map((product) => [
        String(product._id),
        product,
      ]),
    );

    for (const slot of kit.slots) {
      for (const productId of slot.allowedProducts) {
        const product = productsById.get(
          String(productId),
        );

        if (
          !product ||
          product.kitSettings?.eligible !== true ||
          !product.kitSettings.roles?.includes(slot.role)
        ) {
          return fail(
            res,
            400,
            `An allowed product in ${
              slot.label || slot.role
            } is missing or is not eligible for that category.`,
          );
        }
      }
    }

    kit.updatedBy = req.user._id;

    // Runs schema validation, publication checks,
    // and optimistic concurrency protection.
    await kit.save();

    return res.json({
      success: true,
      message: "Kit template saved.",
      kit: serialize(kit),
    });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  getAdminKits,
  createKitDrafts,
  getAdminKit,
  updateAdminKit,
};