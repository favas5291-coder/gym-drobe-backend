"use strict";

const mongoose = require("mongoose");

const Product = require("../../models/Product");
const KitTemplate = require("../../models/KitTemplate");
const Supplier = require("../../models/Supplier");
const PackingLocation = require("../../models/PackingLocation");

const {
  inspectCheckoutFulfillment,
} = require("../../utils/kitFulfillment");

const {
  buildKitCheckoutPricing,
} = require("../../utils/kitCheckoutPricing");

const razorpay = require("./razorpayController");

function errorResponse(res, status, code, message) {
  return res.status(status).json({
    success: false,
    code,
    message,
  });
}

function invalid(message) {
  throw Object.assign(new Error(message), {
    status: 400,
    code: "INVALID_CHECKOUT",
    gymdrobe: true,
  });
}

function includesKit(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  const named = ["kits", "kitGroups", "kitSnapshots"].some(
    (key) => Object.prototype.hasOwnProperty.call(body, key),
  );

  return (
    named ||
    (
      Array.isArray(body.items) &&
      body.items.some(
        (row) =>
          row &&
          ["kitGroup", "kit"].some(
            (key) =>
              Object.prototype.hasOwnProperty.call(row, key),
          ),
      )
    )
  );
}

function createRazorpayOrder(req, res) {
  res.set("Cache-Control", "no-store");

  if (includesKit(req.body)) {
    return errorResponse(
      res,
      409,
      "KIT_CHECKOUT_NOT_READY",
      "Kit payment is not enabled yet. You can save and edit kits in your bag. Check My orders before retrying any previous payment.",
    );
  }

  return razorpay.createRazorpayOrder(req, res);
}

// Authenticated, read-only preview.
// Prices and fulfillment details come from server-loaded records.
async function getCheckoutQuote(req, res) {
  res.set("Cache-Control", "no-store");

  if (!req.user?._id) {
    return errorResponse(
      res,
      401,
      "AUTHENTICATION_REQUIRED",
      "Please sign in to review checkout.",
    );
  }

  try {
    const body = req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      invalid("Checkout information is missing.");
    }

    if (
      !Array.isArray(body.items) ||
      !body.items.length ||
      body.items.length > 50
    ) {
      invalid("Choose between 1 and 50 order components.");
    }

    const method = body.paymentMethod ?? "razorpay";
    const deliveryMethod = body.deliveryMethod ?? "standard";

    if (!["razorpay", "cod-partial"].includes(method)) {
      invalid("Choose online payment or COD with a 10% advance.");
    }

    if (!["standard", "express"].includes(deliveryMethod)) {
      invalid("Choose standard or express delivery.");
    }

    const coupon = body.coupon == null
      ? ""
      : typeof body.coupon === "string"
        ? body.coupon
        : body.coupon?.code;

    if (
      typeof coupon !== "string" ||
      coupon.length > 50 ||
      /[\u0000-\u001f\u007f]/.test(coupon)
    ) {
      invalid("Enter a valid coupon code.");
    }

    const ids = new Set();
    const legacyIds = new Set();
    const slugs = new Set();
    const kitIds = new Set();
    const checkedItems = [];

    for (const row of body.items) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row)
      ) {
        invalid("Check the selected products.");
      }

      const raw = row.id ?? row.productId ?? row.product;

      if (!["string", "number"].includes(typeof raw)) {
        invalid("Choose an existing product ID.");
      }

      const id = String(raw).trim();

      if (
        !id ||
        id.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(id)
      ) {
        invalid("Check the product IDs.");
      }

      if (mongoose.isObjectIdOrHexString(id)) {
        ids.add(id);
      }

      if (
        /^\d+$/.test(id) &&
        Number.isSafeInteger(Number(id))
      ) {
        legacyIds.add(Number(id));
      }

      slugs.add(id.toLowerCase());

      const normalizedId = mongoose.isObjectIdOrHexString(id)
        ? id.toLowerCase()
        : /^\d+$/.test(id) && Number.isSafeInteger(Number(id))
          ? String(Number(id))
          : id.toLowerCase();

      checkedItems.push({
        ...row,
        id: normalizedId,
      });

      if (
        Object.prototype.hasOwnProperty.call(row, "kitGroup")
      ) {
        const group = row.kitGroup;

        if (
          !group ||
          typeof group !== "object" ||
          Array.isArray(group) ||
          typeof group.kitId !== "string" ||
          !/^[a-f0-9]{24}$/i.test(group.kitId)
        ) {
          invalid("Check the kit template IDs.");
        }

        kitIds.add(group.kitId.toLowerCase());
      }
    }

    const clauses = [];

    if (ids.size) {
      clauses.push({ _id: { $in: [...ids] } });
    }

    if (legacyIds.size) {
      clauses.push({ legacyId: { $in: [...legacyIds] } });
    }

    if (slugs.size) {
      clauses.push({ slug: { $in: [...slugs] } });
    }

    const [products, kits] = await Promise.all([
      Product.find({ $or: clauses })
        .select("+kitSettings +supplier +fulfillment")
        .lean(),

      kitIds.size
        ? KitTemplate.find({
            _id: { $in: [...kitIds] },
            status: "published",
          })
            .select("+fulfillment")
            .lean()
        : Promise.resolve([]),
    ]);

    const quote = buildKitCheckoutPricing({
      items: checkedItems,
      products,
      kits,
      coupon,
      deliveryMethod,
      paymentMethod: method,
    });

    const supplierIds = [
      ...new Set(
        products
          .map((product) =>
            product.supplier ? String(product.supplier) : "",
          )
          .filter((id) => /^[a-f0-9]{24}$/i.test(id)),
      ),
    ];

    const locationIds = [
      ...new Set(
        kits
          .map((kit) =>
            kit.fulfillment?.packingLocation
              ? String(kit.fulfillment.packingLocation)
              : "",
          )
          .filter((id) => /^[a-f0-9]{24}$/i.test(id)),
      ),
    ];

    const [suppliers, locations] = await Promise.all([
      supplierIds.length
        ? Supplier.find({
            _id: { $in: supplierIds },
          })
            .select("+contact +verification +fulfillment")
            .lean()
        : Promise.resolve([]),

      locationIds.length
        ? PackingLocation.find({
            _id: { $in: locationIds },
          })
            .select(
              "+address +contact +verification +packing +delivery " +
              "+acceptsGymDrobeStock +supplierArrangements " +
              "+gymdrobeStockTransfer",
            )
            .lean()
        : Promise.resolve([]),
    ]);

    quote.fulfillment = inspectCheckoutFulfillment({
      items: quote.items,
      kitSnapshots: quote.kitSnapshots,
      products,
      kits,
      suppliers,
      locations,
    });

    return res.json({
      success: true,
      quote,
    });
  } catch (error) {
    if (error?.gymdrobe === true) {
      return errorResponse(
        res,
        error.status || 400,
        error.code || "INVALID_CHECKOUT",
        error.message,
      );
    }

    console.error(
      "Checkout preview failed:",
      error.name || "Error",
    );

    return errorResponse(
      res,
      503,
      "CHECKOUT_PREVIEW_UNAVAILABLE",
      "Checkout prices could not be checked. Please retry. No payment was started.",
    );
  }
}

module.exports = {
  getCheckoutQuote,
  createRazorpayOrder,
  verifyRazorpayPayment: razorpay.verifyRazorpayPayment,
  finalizeCapturedPayment: razorpay.finalizeCapturedPayment,
};