"use strict";

// Backend-only loader.
// Raw product records must never be returned to customers.

const mongoose = require("mongoose");

const Product = require("../models/Product");
const KitTemplate = require("../models/KitTemplate");
const Supplier = require("../models/Supplier");
const PackingLocation = require("../models/PackingLocation");
const PackagePlan = require("../models/PackagePlan");
const ShippingProfile = require("../models/ShippingProfile");

const {
  checkoutDelivery,
} = require("./checkoutDelivery");

const {
  kitReviewKey,
} = require("./kitReviewKey");

const {
  buildKitShippingQuote,
} = require("./kitShipping");

const {
  loadShippingSettings,
  priceCheckoutShipping,
} = require("./checkoutShipping");

const {
  inspectCheckoutFulfillment,
} = require("./kitFulfillment");

const {
  buildKitCheckoutPricing,
} = require("./kitCheckoutPricing");

function invalid(message) {
  throw Object.assign(new Error(message), {
    status: 400,
    code: "INVALID_CHECKOUT",
    gymdrobe: true,
  });
}

async function loadCheckoutReview(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    invalid(
      "Checkout information is missing.",
    );
  }

  if (
    !Array.isArray(body.items) ||
    !body.items.length ||
    body.items.length > 50
  ) {
    invalid(
      "Choose between 1 and 50 order components.",
    );
  }

  const method =
    body.paymentMethod ?? "razorpay";

  const deliveryMethod =
    body.deliveryMethod ?? "standard";

  if (
    !["razorpay", "cod-partial"].includes(method)
  ) {
    invalid(
      "Choose online payment or COD with a 10% advance.",
    );
  }

  if (
    !["standard", "express"].includes(
      deliveryMethod,
    )
  ) {
    invalid(
      "Choose standard or express delivery.",
    );
  }

  const coupon =
    body.coupon == null
      ? ""
      : typeof body.coupon === "string"
        ? body.coupon
        : body.coupon?.code;

  if (
    typeof coupon !== "string" ||
    coupon.length > 50 ||
    /[\u0000-\u001f\u007f]/.test(coupon)
  ) {
    invalid(
      "Enter a valid coupon code.",
    );
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
      invalid(
        "Check the selected products.",
      );
    }

    const raw =
      row.id ??
      row.productId ??
      row.product;

    if (
      !["string", "number"].includes(
        typeof raw,
      )
    ) {
      invalid(
        "Choose an existing product ID.",
      );
    }

    const id = String(raw).trim();

    if (
      !id ||
      id.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(id)
    ) {
      invalid(
        "Check the product IDs.",
      );
    }

    const objectId =
      mongoose.isObjectIdOrHexString(id);

    const legacyId =
      /^\d+$/.test(id) &&
      Number.isSafeInteger(Number(id));

    if (objectId) {
      ids.add(id);
    }

    if (legacyId) {
      legacyIds.add(Number(id));
    }

    slugs.add(id.toLowerCase());

    const normalizedId = objectId
      ? id.toLowerCase()
      : legacyId
        ? String(Number(id))
        : id.toLowerCase();

    checkedItems.push({
      ...row,
      id: normalizedId,
    });

    if (
      Object.prototype.hasOwnProperty.call(
        row,
        "kitGroup",
      )
    ) {
      const group = row.kitGroup;

      if (
        !group ||
        typeof group !== "object" ||
        Array.isArray(group) ||
        typeof group.kitId !== "string" ||
        !/^[a-f0-9]{24}$/i.test(group.kitId)
      ) {
        invalid(
          "Check the kit template IDs.",
        );
      }

      kitIds.add(
        group.kitId.toLowerCase(),
      );
    }
  }

  const clauses = [];

  if (ids.size) {
    clauses.push({
      _id: {
        $in: [...ids],
      },
    });
  }

  if (legacyIds.size) {
    clauses.push({
      legacyId: {
        $in: [...legacyIds],
      },
    });
  }

  if (slugs.size) {
    clauses.push({
      slug: {
        $in: [...slugs],
      },
    });
  }

  const [
    products,
    kits,
    shippingSettings,
  ] = await Promise.all([
    Product.find({
      $or: clauses,
    })
      .select(
        "+kitSettings +supplier " +
          "+fulfillment +meeshoProductLink",
      )
      .lean(),

    kitIds.size
      ? KitTemplate.find({
          _id: {
            $in: [...kitIds],
          },

          status: "published",
        })
          .select("+fulfillment")
          .lean()
      : Promise.resolve([]),

    kitIds.size
      ? Promise.resolve(null)
      : loadShippingSettings(),
  ]);

  const quote =
    buildKitCheckoutPricing({
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
          product.supplier
            ? String(product.supplier)
            : "",
        )
        .filter(
          (id) =>
            /^[a-f0-9]{24}$/i.test(id),
        ),
    ),
  ];

  const locationIds = [
    ...new Set(
      kits
        .map((kit) =>
          kit.fulfillment?.packingLocation
            ? String(
                kit.fulfillment.packingLocation,
              )
            : "",
        )
        .filter(
          (id) =>
            /^[a-f0-9]{24}$/i.test(id),
        ),
    ),
  ];

  const [
    suppliers,
    locations,
  ] = await Promise.all([
    supplierIds.length
      ? Supplier.find({
          _id: {
            $in: supplierIds,
          },
        })
          .select(
            "+contact +verification +fulfillment",
          )
          .lean()
      : Promise.resolve([]),

    locationIds.length
      ? PackingLocation.find({
          _id: {
            $in: locationIds,
          },
        })
          .select(
            "+address +contact +verification " +
              "+packing +delivery " +
              "+acceptsGymDrobeStock " +
              "+supplierArrangements " +
              "+gymdrobeStockTransfer",
          )
          .lean()
      : Promise.resolve([]),
  ]);

  quote.fulfillment =
    inspectCheckoutFulfillment({
      items: quote.items,
      kitSnapshots: quote.kitSnapshots,
      products,
      kits,
      suppliers,
      locations,
    });

  // Kit shipping uses measured packages, verified origins,
  // destination coverage and configured courier charges.
  if (quote.kitSnapshots.length) {
    const productIds =
      quote.items.map(
        (item) => item.product,
      );

    const pincode =
      typeof body.pincode === "string"
        ? body.pincode.trim()
        : "";

    const [
      plans,
      profiles,
    ] =
      /^[1-9]\d{5}$/.test(pincode) &&
      quote.fulfillment.configurationReady
        ? await Promise.all([
            PackagePlan.find({
              status: "active",

              "components.product": {
                $in: productIds,
              },
            })
              .select(
                PackagePlan.adminFields,
              )
              .limit(201)
              .lean()
              .maxTimeMS(10000),

            ShippingProfile.find({
              status: "active",
              destinationPincodes:
                pincode,

              "service.deliveryMethod":
                deliveryMethod,
            })
              .select(
                ShippingProfile.adminFields,
              )
              .limit(201)
              .lean()
              .maxTimeMS(10000),
          ])
        : [[], []];

    quote.shippingReview =
      plans.length > 200 ||
      profiles.length > 200
        ? {
            ready: false,

            issues: [
              "Too many shipping configurations match. Ask support to review the package arrangements.",
            ],

            packageCount: null,
            shipments: [],
            shippingPaise: null,
            validUntil: null,
          }
        : buildKitShippingQuote({
            quote,
            products,
            kits,
            plans,
            profiles,
            pincode,
          });

    if (quote.shippingReview.ready) {
      const shipping =
        quote.shippingReview.shippingPaise;

      const merchandise =
        Math.round(
          quote.pricing.totalAfterCoupon *
            100,
        );

      const total =
        merchandise + shipping;

      const now =
        method === "cod-partial"
          ? Math.round(merchandise / 10)
          : total;

      quote.pricing.shipping =
        shipping / 100;

      quote.pricing.finalTotal =
        total / 100;

      quote.payment.amountToPayNow =
        now / 100;

      quote.payment.amountDue =
        (total - now) / 100;

      quote.shippingIsEstimate = false;

      quote.fulfillment
        .deliveryCoverageConfirmed = true;

      quote.fulfillment
        .finalShippingConfirmed = true;

      quote.fulfillment
        .packageCountConfirmed = true;

      quote.fulfillment.packageCount =
        quote.shippingReview.packageCount;

      quote.fulfillment.issues = [];

      quote.reviewKey =
        kitReviewKey(
          quote,
          pincode,
        );

      quote.purchaseEnabled = true;

      quote.notice =
        "Prices, package contents and shipping are confirmed for this selection and pincode until the review expires. Stock is checked again when payment is confirmed. No payment or inventory reservation was started by this review.";
    }
  }

  // Ordinary products use their recorded delivery settings.
  // This does not claim live courier pincode coverage.
  if (!quote.kitSnapshots.length) {
    const shipping =
      priceCheckoutShipping({
        settings: shippingSettings,
        pricing: quote.pricing,
        items: quote.items,
        products,
        deliveryMethod,
        paymentMethod: method,
        pincode: body.pincode,
      });

    quote.pricing =
      shipping.pricing;

    quote.payment =
      shipping.payment;

    quote.freeShipping =
      shipping.freeShipping;

    quote.deliveryReview =
      checkoutDelivery(
        products,
        quote.items,
        body.pincode,
      );

    if (
      !quote.deliveryReview.available
    ) {
      throw Object.assign(
        new Error(
          quote.deliveryReview.notice,
        ),
        {
          status: 409,
          code: "DELIVERY_UNAVAILABLE",
          gymdrobe: true,
        },
      );
    }
  }

  // Internal result: API controllers must return only the
  // customer-safe quote, never these raw product records.
  return {
    quote,
    products,
  };
}

module.exports = {
  loadCheckoutReview,
};