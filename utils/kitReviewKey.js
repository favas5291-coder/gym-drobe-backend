"use strict";

const crypto = require("node:crypto");

const {
  snapshotPurchasedShipping,
} = require("./purchasedShipping");

// This compares reviewed checkout terms.
// Payment creation still reloads all records
// and validates the actual prices and stock.
function kitReviewKey(quote, pincode) {
  const shipping =
    snapshotPurchasedShipping(
      quote,
      pincode,
    );

  const {
    reviewedAt,
    validUntil,
    ...terms
  } = shipping;

  const value = {
    items: quote.items.map(
      (item) => [
        String(item.product),
        item.name,
        item.sku || "",
        item.selectedSize ?? null,
        item.selectedColor ?? null,
        item.quantity,
        item.price,
        item.kit?.groupId || null,
        item.kit?.slotKey || null,
        item.kit?.role || null,
        item.priceAllocation,
        item.returnPolicy || "",

        item.returnsEligible ||
          "unconfirmed",

        item.returnConditions || "",
        item.returnWindowDays,
        item.returnRequestTypes,
      ],
    ),

    kits: quote.kitSnapshots.map(
      (kit) => [
        kit.groupId,
        String(kit.template),
        kit.templateVersion,
        kit.name,
        kit.level,
        kit.fulfillmentMode,
        kit.subtotalPaise,
        kit.kitDiscountPaise,
        kit.couponDiscountPaise,
        kit.linePaidPaise,
      ],
    ),

    coupon: quote.coupon?.code || null,
    method: quote.method,
    pricing: quote.pricing,
    shipping: terms,
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

module.exports = {
  kitReviewKey,
};