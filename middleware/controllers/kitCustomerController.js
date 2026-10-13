const mongoose = require("mongoose");

const KitTemplate = require("../../models/KitTemplate");
const Product = require("../../models/Product");

const {
  reference,
  SUPPLEMENT_NOTE,
} = require("../../utils/kitDefinitions");

const {
  normalizeSelections,
  calculateKitQuote,
} = require("../../utils/kitPricing");

function invalidId(value) {
  return (
    typeof value !== "string" ||
    !mongoose.isObjectIdOrHexString(value)
  );
}

function sendError(res, error) {
  if (!error.status) {
    console.error(
      "Customer kit request failed:",
      error.name || "Error",
    );
  }

  return res.status(error.status || 503).json({
    success: false,
    code: error.code || "KIT_SERVICE_UNAVAILABLE",
    message: error.status
      ? error.message
      : "Fitness Kits are temporarily unavailable. Please try again.",
  });
}

function summary(kit) {
  return {
    id: String(kit._id),
    kitCode: kit.kitCode || "",
    level: kit.level,
    name: kit.name,
    audience: kit.audience || "",
    explanation: kit.explanation || "",
    version: kit.__v ?? 0,
    supplementNote: SUPPLEMENT_NOTE,
    allowSkipCategories: true,
    purchaseEnabled: false,
  };
}

// Explicit public fields prevent supplier and cost details leaking.
function publicProduct(product) {
  return {
    id: String(product._id),
    name: product.name || "",
    brand: product.brand || "",
    category: product.category || "",
    subcategory: product.subcategory || "",

    image: typeof product.image === "string"
      ? product.image
      : "",

    images: Array.isArray(product.images)
      ? product.images.filter(
          (value) => typeof value === "string",
        )
      : [],

    price: product.price,
    discount: product.discount,

    sizes: Array.isArray(product.sizes)
      ? product.sizes
      : [],

    colors: Array.isArray(product.colors)
      ? product.colors
      : [],

    variants: product.variants || {},
    stock: product.stock,

    optionLabels: {
      size: product.optionLabels?.size || "Size",
      color: product.optionLabels?.color || "Colour",
    },

    deliveryAvailable:
      product.delivery?.available === true,
  };
}

async function publishedKit(req, res) {
  if (invalidId(req.params.id)) {
    res.status(400).json({
      success: false,
      message: "Kit ID is invalid.",
    });

    return null;
  }

  const kit = await KitTemplate.findOne({
    _id: req.params.id,
    status: "published",
  })
    .select("+fulfillment")
    .lean();

  if (!kit) {
    res.status(404).json({
      success: false,
      code: "KIT_NOT_AVAILABLE",
      message: "This Fitness Kit is not available.",
    });

    return null;
  }

  return kit;
}

async function getCustomerKits(req, res) {
  res.set("Cache-Control", "no-store");

  try {
    const kits = await KitTemplate.find({
      status: "published",
    })
      .sort({ level: 1 })
      .lean();

    const levelOrder = new Map([
      ["beginner", 0],
      ["intermediate", 1],
      ["advanced", 2],
    ]);

    kits.sort(
      (a, b) =>
        (levelOrder.get(a.level) ?? 3) -
        (levelOrder.get(b.level) ?? 3),
    );

    return res.json({
      success: true,
      kits: kits.map(summary),
      purchaseEnabled: false,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function getCustomerKit(req, res) {
  res.set("Cache-Control", "no-store");

  try {
    const kit = await publishedKit(req, res);

    if (!kit) return;

    const productIds = [
      ...new Set(
        kit.slots.flatMap((slot) =>
          slot.allowedProducts.map(reference),
        ),
      ),
    ].filter(Boolean);

    const products = productIds.length
      ? await Product.find({
          _id: { $in: productIds },
          isActive: true,
        }).lean()
      : [];

    const allowedRoles = new Map();

    for (const slot of kit.slots) {
      for (const productId of slot.allowedProducts) {
        const id = reference(productId);

        if (!allowedRoles.has(id)) {
          allowedRoles.set(id, new Set());
        }

        allowedRoles.get(id).add(slot.role);
      }
    }

    const eligible = products.filter(
      (product) =>
        product.kitSettings?.eligible === true &&
        product.kitSettings.roles?.some(
          (role) =>
            allowedRoles
              .get(reference(product._id))
              ?.has(role),
        ),
    );

    const safeKit = {
      ...summary(kit),

      slots: kit.slots.map((slot) => ({
        key: slot.key,
        role: slot.role,
        label: slot.label,
        whySelected: slot.whySelected || "",
        optional: slot.optional,
        suggestedEssential: slot.suggestedEssential,
        defaultIncluded: slot.defaultIncluded,
        defaultProduct:
          reference(slot.defaultProduct) || null,
        defaultSize: slot.defaultSize ?? null,
        defaultColor: slot.defaultColor ?? null,
        defaultQuantity: slot.defaultQuantity,
        maximumQuantity: slot.maximumQuantity,

        allowedProducts: slot.allowedProducts
          .map(reference)
          .filter((id) =>
            eligible.some(
              (product) =>
                reference(product._id) === id &&
                product.kitSettings.roles.includes(
                  slot.role,
                ),
            ),
          ),
      })),

      discount: {
        type: kit.discount.type,
        value: kit.discount.value,
        minimumSubtotal: kit.discount.minimumSubtotal,
        minimumCategories:
          kit.discount.minimumCategories,
        requiredRoles: kit.discount.requiredRoles,
        allowCouponStacking:
          kit.discount.allowCouponStacking,
      },

      fulfillment: {
        mode: kit.fulfillment?.mode || "unconfigured",
        customerNote:
          kit.fulfillment?.customerNote || "",
      },
    };

    return res.json({
      success: true,
      kit: safeKit,
      products: eligible.map(publicProduct),
      notice:
        "Build and estimate your kit. Kit checkout is not enabled yet.",
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function quoteCustomerKit(req, res) {
  res.set("Cache-Control", "no-store");

  try {
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
          "Reload the kit to obtain its current version.",
      });
    }

    const kit = await publishedKit(req, res);

    if (!kit) return;

    if ((kit.__v ?? 0) !== body.version) {
      return res.status(409).json({
        success: false,
        code: "KIT_VERSION_CHANGED",
        message:
          "This kit changed. Reload it before continuing.",
      });
    }

    const selections = normalizeSelections(
      body.selections,
    );

    const allowed = new Map(
      kit.slots.map((slot) => [
        slot.key,
        new Set(
          slot.allowedProducts.map(reference),
        ),
      ]),
    );

    if (
      selections.some(
        (row) =>
          !allowed
            .get(row.slotKey)
            ?.has(row.productId),
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "A selected product is not an allowed replacement for this kit section.",
      });
    }

    const productIds = [
      ...new Set(
        selections.map((row) => row.productId),
      ),
    ];

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

    quote.notice =
      "Kit estimate only. Checkout is not enabled for kits yet. Delivery coverage, fulfillment readiness, shipment charges, prices and stock must be checked again before payment.";

    return res.json({
      success: true,
      quote,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = {
  getCustomerKits,
  getCustomerKit,
  quoteCustomerKit,
};