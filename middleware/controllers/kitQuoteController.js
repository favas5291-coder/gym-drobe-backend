const mongoose = require("mongoose");

const KitTemplate = require("../../models/KitTemplate");
const Product = require("../../models/Product");

const {
  reference,
} = require("../../utils/kitDefinitions");

const {
  normalizeSelections,
  calculateKitQuote,
} = require("../../utils/kitPricing");

async function previewKitQuote(req, res) {
  res.set("Cache-Control", "no-store");

  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Admin sign-in is required.",
    });
  }

  if (
    req.user.role !== "admin" ||
    req.user.isActive === false
  ) {
    return res.status(403).json({
      success: false,
      message: "An active admin account is required.",
    });
  }

  try {
    if (
      !mongoose.isObjectIdOrHexString(req.params.id)
    ) {
      return res.status(400).json({
        success: false,
        message: "Kit ID is invalid.",
      });
    }

    const body = req.body;

    const allowedFields = [
      "version",
      "selections",
      "coupon",
      "deliveryMethod",
      "paymentMethod",
    ];

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !allowedFields.includes(key),
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Provide only version, selections, coupon, deliveryMethod and paymentMethod.",
      });
    }

    if (
      !Number.isSafeInteger(body.version) ||
      body.version < 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Include the kit version returned when loading it.",
      });
    }

    const kit = await KitTemplate.findById(
      req.params.id,
    )
      .select("+fulfillment")
      .lean();

    if (!kit) {
      return res.status(404).json({
        success: false,
        message: "Kit not found.",
      });
    }

    if ((kit.__v ?? 0) !== body.version) {
      return res.status(409).json({
        success: false,
        code: "KIT_VERSION_CHANGED",
        message:
          "This kit changed. Reload it before requesting another preview.",
      });
    }

    const defaultSelections = kit.slots
      .filter(
        (slot) =>
          slot.defaultIncluded &&
          slot.defaultProduct,
      )
      .map((slot) => ({
        slotKey: slot.key,
        productId: reference(slot.defaultProduct),
        selectedSize: slot.defaultSize,
        selectedColor: slot.defaultColor,
        quantity: slot.defaultQuantity,
      }));

    const selections = normalizeSelections(
      body.selections === undefined
        ? defaultSelections
        : body.selections,
    );

    const productIds = [
      ...new Set(
        selections.map((row) => row.productId),
      ),
    ];

    // Products are read from MongoDB.
    // The request cannot submit prices or discounts.
    const products = await Product.find({
      _id: { $in: productIds },
    }).lean();

    const quote = calculateKitQuote({
      kit,
      products,
      selections,
      coupon: body.coupon ?? null,
      deliveryMethod:
        body.deliveryMethod ?? "standard",
      paymentMethod:
        body.paymentMethod ?? "razorpay",
    });

    return res.json({
      success: true,
      quote,
    });
  } catch (error) {
    if (!error.status) {
      console.error(
        "Kit quote failed:",
        error.name || "Error",
      );
    }

    return res.status(error.status || 503).json({
      success: false,
      code: error.code || "KIT_QUOTE_UNAVAILABLE",
      message: error.status
        ? error.message
        : "Kit pricing is temporarily unavailable.",
    });
  }
}

module.exports = {
  previewKitQuote,
};