"use strict";

const {
  progressStage,
} = require("./kitFulfillmentProgress");

const pick = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => value?.[key] !== undefined)
      .map((key) => [key, value[key]]),
  );

const allocationFields = [
  "quantity",
  "lineSubtotalPaise",
  "kitDiscountPaise",
  "couponDiscountPaise",
  "linePaidPaise",
  "unitBasePaise",
  "extraPaiseUnits",
];

const range = (value) =>
  pick(value, ["minimum", "maximum"]);

function publicKitItemFields(item) {
  return {
    ...(item.kit
      ? {
          kit: pick(item.kit, [
            "groupId",
            "slotKey",
            "role",
          ]),
        }
      : {}),

    ...(item.priceAllocation
      ? {
          priceAllocation: pick(
            item.priceAllocation,
            allocationFields,
          ),
        }
      : {}),
  };
}

function publicKitOrderFields(order) {
  const result = {};

  if (order.kitSnapshots?.length) {
    result.kitSnapshots = order.kitSnapshots.map((kit) => {
      const row = pick(kit, [
        "groupId",
        "templateVersion",
        "kitCode",
        "name",
        "level",
        "audience",
        "explanation",
        "supplementNote",
        "fulfillmentMode",
        "customerNote",
        "subtotalPaise",
        "kitDiscountPaise",
        "couponDiscountPaise",
        "linePaidPaise",
      ]);

      if (kit.template) {
        row.template = String(kit.template);
      }

      return row;
    });
  }

  const snapshot = order.shippingSnapshot;

  if (snapshot) {
    result.shippingSnapshot = {
      ...pick(snapshot, [
        "version",
        "destinationPincode",
        "paymentMethod",
        "reviewedAt",
        "validUntil",
        "packageCount",
        "shippingPaise",
        "merchandisePaise",
        "totalPaise",
        "payNowPaise",
        "amountDuePaise",
      ]),

      shipments: (snapshot.shipments || []).map((parcel) => ({
        ...pick(parcel, [
          "key",
          "groupId",
          "label",
          "carrier",
          "service",
          "merchandisePaise",
          "shippingPaise",
          "amountDuePaise",
        ]),

        contents: (parcel.contents || []).map((row) =>
          pick(row, [
            "itemIndex",
            "productId",
            "name",
            "quantity",
            "selectedSize",
            "selectedColor",
          ]),
        ),

        preparationDays: range(parcel.preparationDays),
        transitDays: range(parcel.transitDays),
        estimatedDays: range(parcel.estimatedDays),
      })),
    };
  }

  if (order.fulfillmentProgress) {
    result.fulfillmentProgress =
      publicKitFulfillmentFields(order);
  }

  return result;
}

function publicKitFulfillmentFields(order) {
  const progress = order.fulfillmentProgress;

  if (!progress) {
    return null;
  }

  return {
    revision: progress.revision,
    updatedAt: progress.updatedAt,

    stage:
      order.status === "cancelled"
        ? "cancelled"
        : progressStage(order),

    components: (progress.components || []).map((row) =>
      pick(row, [
        "itemIndex",
        "receivedQuantity",
      ]),
    ),

    parcels: (progress.parcels || []).map((row) =>
      pick(row, [
        "key",
        "status",
        "carrier",
        "trackingNumber",
        "estimatedDelivery",
        "packedAt",
        "shippedAt",
        "deliveredAt",
        "codCollectedPaise",
        "codCollectedAt",
      ]),
    ),
  };
}

function adminKitFulfillmentFields(order) {
  const progress = order.fulfillmentProgress;

  if (!progress) {
    return null;
  }

  return {
    ...pick(progress, [
      "revision",
      "updatedAt",
    ]),

    components: (progress.components || []).map((row) =>
      pick(row, [
        "itemIndex",
        "receivedQuantity",
        "procurementStatus",
        "supplierReference",
        "notes",
        "updatedAt",
      ]),
    ),

    parcels: (progress.parcels || []).map((row) =>
      pick(row, [
        "key",
        "status",
        "carrier",
        "trackingNumber",
        "estimatedDelivery",
        "packedAt",
        "shippedAt",
        "deliveredAt",
        "codCollectedPaise",
        "codCollectedAt",
        "collectionReference",
        "updatedAt",
      ]),
    ),
  };
}

module.exports = {
  publicKitItemFields,
  publicKitOrderFields,
  publicKitFulfillmentFields,
  adminKitFulfillmentFields,
};