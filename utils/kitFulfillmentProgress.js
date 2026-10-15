"use strict";

const {
  validatePurchasedShipping,
} = require("./purchasedShipping");

const PARCEL_STAGES = [
  "collecting",
  "packed",
  "shipped",
  "out-for-delivery",
  "delivered",
];

const PROCUREMENT_STAGES = [
  "awaiting",
  "ordered",
  "partially-received",
  "received",
];

const bad = (
  message,
  code = "KIT_FULFILLMENT_INVALID",
  status = 409,
) =>
  Object.assign(new Error(message), {
    status,
    code,
    gymdrobe: true,
  });

const whole = (value, min = 0) =>
  Number.isSafeInteger(value) && value >= min;

function amount(value) {
  const result = Math.round(Number(value) * 100);

  if (
    !["number", "string"].includes(typeof value) ||
    !String(value).trim() ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0 ||
    !whole(result) ||
    Math.abs(Number(value) * 100 - result) > 0.000001
  ) {
    throw bad(
      "The payment ledger needs reconciliation.",
    );
  }

  return result;
}

function text(
  value,
  label,
  max,
  required = false,
) {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (required && !value.trim()) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw bad(
      `Check ${label}.`,
      "INVALID_FULFILLMENT_INPUT",
      400,
    );
  }

  return value.trim();
}

function date(value) {
  return (
    value &&
    Number.isFinite(new Date(value).getTime()) &&
    new Date(value).getTime() <= Date.now()
  );
}

const clone = (value) =>
  JSON.parse(JSON.stringify(value));

function collectedKitCodPaise(order) {
  const values =
    order.fulfillmentProgress?.parcels || [];

  if (
    !values.every(
      (row) => whole(row.codCollectedPaise),
    )
  ) {
    throw bad(
      "Parcel COD collection records need review.",
    );
  }

  const total = values.reduce(
    (sum, row) => sum + row.codCollectedPaise,
    0,
  );

  if (!whole(total)) {
    throw bad(
      "Parcel COD collection totals need review.",
    );
  }

  return total;
}

function initializeKitFulfillment(
  order,
  now = new Date(),
) {
  if (
    !order.kitSnapshots?.length ||
    !order.shippingSnapshot
  ) {
    throw bad(
      "This kit needs its purchased package snapshot before fulfillment.",
    );
  }

  validatePurchasedShipping(order);

  return {
    revision: 0,
    updatedAt: now,
    updatedBy: null,

    components: order.items.map(
      (item, itemIndex) => ({
        itemIndex,
        receivedQuantity: 0,
        procurementStatus: "awaiting",
        supplierReference: "",
        notes: "",
        updatedAt: null,
        updatedBy: null,
      }),
    ),

    parcels: order.shippingSnapshot.shipments.map(
      (parcel) => ({
        key: parcel.key,
        status: "collecting",
        carrier: parcel.carrier,
        trackingNumber: "",
        estimatedDelivery: null,
        packedAt: null,
        shippedAt: null,
        deliveredAt: null,
        codCollectedPaise: 0,
        codCollectedAt: null,
        collectionReference: "",
        updatedAt: null,
        updatedBy: null,
      }),
    ),
  };
}

function progressStage(
  order,
  progress = order.fulfillmentProgress,
) {
  if (!progress) {
    return "awaiting-setup";
  }

  const parcels = progress.parcels;

  if (
    parcels.every(
      (row) => row.status === "delivered",
    )
  ) {
    return "delivered";
  }

  if (
    parcels.every(
      (row) =>
        PARCEL_STAGES.indexOf(row.status) >= 3,
    )
  ) {
    return "out-for-delivery";
  }

  if (
    parcels.some(
      (row) =>
        PARCEL_STAGES.indexOf(row.status) >= 2,
    )
  ) {
    return "shipped";
  }

  if (
    parcels.every(
      (row) =>
        PARCEL_STAGES.indexOf(row.status) >= 1,
    )
  ) {
    return "packing";
  }

  return "collecting";
}

function reservedUnits(order, progress) {
  const totals = new Map();

  const packedParcels = progress.parcels.filter(
    (row) =>
      PARCEL_STAGES.indexOf(row.status) >= 1,
  );

  for (const parcel of packedParcels) {
    const snapshot =
      order.shippingSnapshot.shipments.find(
        (row) => row.key === parcel.key,
      );

    for (const content of snapshot.contents) {
      totals.set(
        content.itemIndex,

        (totals.get(content.itemIndex) || 0) +
          content.quantity,
      );
    }
  }

  return totals;
}

function validateKitProgress(order) {
  const progress = order.fulfillmentProgress;

  if (!progress) {
    return;
  }

  if (
    !order.kitSnapshots?.length ||
    !order.shippingSnapshot ||
    !whole(progress.revision) ||
    !Array.isArray(progress.components) ||
    !Array.isArray(progress.parcels) ||
    progress.components.length !==
      order.items.length ||
    progress.parcels.length !==
      order.shippingSnapshot.shipments.length
  ) {
    throw bad(
      "Kit fulfillment must match the purchased components and parcels.",
    );
  }

  validatePurchasedShipping(order);

  const componentIndexes = new Set();
  const parcelKeys = new Set();

  for (const component of progress.components) {
    const item = order.items[component.itemIndex];

    if (
      !whole(component.itemIndex) ||
      !item ||
      componentIndexes.has(component.itemIndex) ||
      !whole(component.receivedQuantity) ||
      component.receivedQuantity > item.quantity ||
      !PROCUREMENT_STAGES.includes(
        component.procurementStatus,
      )
    ) {
      throw bad(
        "Component receipts do not match the purchased quantities.",
      );
    }

    componentIndexes.add(component.itemIndex);

    const expected =
      component.receivedQuantity === item.quantity
        ? "received"
        : component.receivedQuantity > 0
          ? "partially-received"
          : null;

    if (
      expected
        ? component.procurementStatus !== expected
        : !["awaiting", "ordered"].includes(
            component.procurementStatus,
          )
    ) {
      throw bad(
        "Component receipt quantities and procurement statuses do not agree.",
      );
    }
  }

  const cashMethod =
    order.shippingSnapshot.paymentMethod ===
    "cod-partial";

  for (const parcel of progress.parcels) {
    const snapshot =
      order.shippingSnapshot.shipments.find(
        (row) => row.key === parcel.key,
      );

    const stage = PARCEL_STAGES.indexOf(
      parcel.status,
    );

    if (
      !snapshot ||
      parcelKeys.has(parcel.key) ||
      stage < 0 ||
      !whole(parcel.codCollectedPaise) ||
      parcel.codCollectedPaise >
        snapshot.amountDuePaise ||
      (
        parcel.codCollectedPaise !== 0 &&
        parcel.codCollectedPaise !==
          snapshot.amountDuePaise
      )
    ) {
      throw bad(
        "Parcel progress or COD amounts do not match the purchased shipment.",
      );
    }

    parcelKeys.add(parcel.key);

    if (stage >= 1 && !date(parcel.packedAt)) {
      throw bad(
        "Confirm the parcel was checked and packed before dispatch.",
      );
    }

    if (
      stage >= 2 &&
      (
        !date(parcel.shippedAt) ||
        !String(parcel.carrier || "").trim() ||
        !String(parcel.trackingNumber || "").trim()
      )
    ) {
      throw bad(
        "Record a courier, tracking number and dispatch time for each shipped parcel.",
      );
    }

    if (
      stage === 4 &&
      (
        !date(parcel.deliveredAt) ||
        parcel.codCollectedPaise !==
          snapshot.amountDuePaise
      )
    ) {
      throw bad(
        "Confirm parcel delivery and its recorded COD balance before marking it delivered.",
      );
    }

    if (
      parcel.codCollectedPaise &&
      (
        !cashMethod ||
        stage < 3 ||
        !date(parcel.codCollectedAt) ||
        !String(
          parcel.collectionReference || "",
        ).trim()
      )
    ) {
      throw bad(
        "COD collection requires a delivery-stage parcel and an actual collection reference.",
      );
    }
  }

  const held = reservedUnits(order, progress);

  if (
    progress.components.some(
      (row) =>
        row.receivedQuantity <
        (held.get(row.itemIndex) || 0),
    )
  ) {
    throw bad(
      "Packed and dispatched parcels must be backed by received component quantities.",
    );
  }

  const collected = collectedKitCodPaise(order);

  if (order.status !== "cancelled") {
    const expectedGross =
      order.shippingSnapshot.payNowPaise +
      collected;

    const gross = amount(
      order.payment.grossCollected,
    );

    const refunded = amount(
      order.payment.refundedAmount,
    );

    if (
      gross !== expectedGross ||
      amount(order.payment.amountPaid) +
        refunded !==
        gross ||
      amount(order.payment.amountDue) !==
        order.shippingSnapshot.totalPaise - gross
    ) {
      throw bad(
        "Parcel collections, money received and the remaining balance do not reconcile.",
      );
    }

    if (
      order.status === "delivered" &&
      progressStage(order) !== "delivered"
    ) {
      throw bad(
        "Every parcel must be delivered before the complete order is delivered.",
      );
    }
  }
}

function readyOrder(order) {
  if (
    !order.kitSnapshots?.length ||
    !order.shippingSnapshot ||
    ![
      "confirmed",
      "processing",
      "shipped",
      "out-for-delivery",
      "delivered",
    ].includes(order.status) ||
    order.metadata?.inventoryReserved !== true ||
    !order.payment?.verifiedAt ||
    !(
      order.payment.razorpayPaymentId ||
      order.payment.transactionId
    ) ||
    !["paid", "partially-paid"].includes(
      order.payment.status,
    )
  ) {
    throw bad(
      "Kit fulfillment requires verified payment and confirmed inventory deduction.",
      "KIT_ORDER_NOT_READY",
    );
  }

  if (
    ![
      "not-requested",
      "not-applicable",
      "rejected",
      undefined,
      null,
    ].includes(order.refund?.status) ||
    ![
      "not-requested",
      "rejected",
      undefined,
      null,
    ].includes(order.returnRequest?.status)
  ) {
    throw bad(
      "Manage the active return or refund before changing kit fulfillment.",
    );
  }
}

// Prepare one atomic change.
// This function does not mutate its input, collect money,
// contact suppliers or deduct product inventory.
function applyKitFulfillmentAction(
  order,
  input,
  adminId,
  now = new Date(),
) {
  if (typeof order?.toObject === "function") {
    order = order.toObject({
      transform: false,
    });
  }

  readyOrder(order);

  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !whole(input.revision) ||
    !/^[a-f0-9]{24}$/i.test(String(adminId))
  ) {
    throw bad(
      "Include the current fulfillment revision and an authenticated admin.",
      "INVALID_FULFILLMENT_INPUT",
      400,
    );
  }

  const allowed = {
    initialize: [
      "action",
      "revision",
    ],

    component: [
      "action",
      "revision",
      "itemIndex",
      "receivedQuantity",
      "procurementStatus",
      "supplierReference",
      "notes",
    ],

    parcel: [
      "action",
      "revision",
      "key",
      "status",
      "carrier",
      "trackingNumber",
      "estimatedDelivery",
      "packingChecked",
    ],

    cod: [
      "action",
      "revision",
      "key",
      "collectionReference",
      "collectionConfirmed",
    ],
  };

  if (
    !allowed[input.action] ||
    Object.keys(input).some(
      (key) =>
        !allowed[input.action].includes(key),
    )
  ) {
    throw bad(
      "Send only the fields required for this fulfillment action.",
      "INVALID_FULFILLMENT_INPUT",
      400,
    );
  }

  if (
    input.revision !==
    (order.fulfillmentProgress?.revision ?? 0)
  ) {
    throw bad(
      "This kit changed. Reload before saving again.",
      "KIT_FULFILLMENT_CHANGED",
    );
  }

  if (
    !order.fulfillmentProgress &&
    input.action !== "initialize"
  ) {
    throw bad(
      "Initialize this kit's fulfillment before recording progress.",
    );
  }

  if (
    order.fulfillmentProgress &&
    input.action === "initialize"
  ) {
    throw bad(
      "Fulfillment is already initialized. Reload the saved progress.",
      "KIT_FULFILLMENT_CHANGED",
    );
  }

  if (order.fulfillmentProgress) {
    validateKitProgress(order);
  }

  const progress = order.fulfillmentProgress
    ? clone(order.fulfillmentProgress)
    : initializeKitFulfillment(order, now);

  const payment = clone(order.payment);
  const delivery = clone(order.delivery || {});

  let description =
    "Kit fulfillment initialized. Collecting components.";

  if (input.action === "component") {
    const row = progress.components.find(
      (row) => row.itemIndex === input.itemIndex,
    );

    const item = order.items[input.itemIndex];

    if (
      !row ||
      !item ||
      !whole(input.receivedQuantity) ||
      input.receivedQuantity > item.quantity
    ) {
      throw bad(
        "Enter a received quantity within the purchased quantity.",
        "INVALID_FULFILLMENT_INPUT",
        400,
      );
    }

    row.receivedQuantity = input.receivedQuantity;

    row.procurementStatus =
      row.receivedQuantity === item.quantity
        ? "received"
        : row.receivedQuantity
          ? "partially-received"
          : input.procurementStatus;

    if (
      !PROCUREMENT_STAGES.includes(
        row.procurementStatus,
      )
    ) {
      throw bad(
        "Choose awaiting or ordered when no units have been received.",
        "INVALID_FULFILLMENT_INPUT",
        400,
      );
    }

    row.supplierReference = text(
      input.supplierReference ?? row.supplierReference,
      "supplier purchase reference",
      200,
    );

    row.notes = text(
      input.notes ?? row.notes,
      "internal procurement notes",
      500,
    );

    row.updatedBy = String(adminId);
    row.updatedAt = now;

    description =
      `Component ${Number(input.itemIndex) + 1}: ` +
      `${row.receivedQuantity} of ${item.quantity} units received.`;
  } else if (
    ["parcel", "cod"].includes(input.action)
  ) {
    const row = progress.parcels.find(
      (row) => row.key === input.key,
    );

    const snapshot =
      order.shippingSnapshot.shipments.find(
        (row) => row.key === input.key,
      );

    if (!row || !snapshot) {
      throw bad(
        "Choose a purchased parcel.",
        "INVALID_FULFILLMENT_INPUT",
        400,
      );
    }

    if (input.action === "parcel") {
      const before = PARCEL_STAGES.indexOf(
        row.status,
      );

      const after = PARCEL_STAGES.indexOf(
        input.status,
      );

      if (
        after < before ||
        after > before + 1 ||
        after < 0
      ) {
        throw bad(
          "Move each parcel through packing, shipping and delivery in order.",
        );
      }

      if (after === 1 && before === 0) {
        if (input.packingChecked !== true) {
          throw bad(
            "Confirm the parcel contents and packaging were checked.",
          );
        }

        row.packedAt = now;
      }

      if (input.carrier !== undefined) {
        row.carrier = text(
          input.carrier,
          "courier name",
          100,
          after >= 2,
        );
      }

      if (input.trackingNumber !== undefined) {
        row.trackingNumber = text(
          input.trackingNumber,
          "tracking number",
          150,
          after >= 2,
        );
      }

      if (input.estimatedDelivery !== undefined) {
        const value = input.estimatedDelivery;

        if (
          value !== "" &&
          (
            typeof value !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            !Number.isFinite(
              Date.parse(`${value}T00:00:00Z`),
            ) ||
            new Date(`${value}T00:00:00Z`)
              .toISOString()
              .slice(0, 10) !== value
          )
        ) {
          throw bad(
            "Choose a valid estimated delivery date.",
            "INVALID_FULFILLMENT_INPUT",
            400,
          );
        }

        row.estimatedDelivery = value
          ? new Date(`${value}T00:00:00Z`)
          : null;
      }

      row.status = input.status;

      if (after >= 2 && !row.shippedAt) {
        row.shippedAt = now;
      }

      if (after === 4 && !row.deliveredAt) {
        row.deliveredAt = now;
      }

      description =
        `${snapshot.label}: ` +
        `${row.status.replaceAll("-", " ")}.`;
    } else {
      if (
        order.shippingSnapshot.paymentMethod !==
          "cod-partial" ||
        snapshot.amountDuePaise <= 0 ||
        ![
          "out-for-delivery",
          "delivered",
        ].includes(row.status) ||
        input.collectionConfirmed !== true ||
        row.codCollectedPaise > 0
      ) {
        throw bad(
          "Record each actual COD collection once, when its parcel is out for delivery.",
          "COD_COLLECTION_INVALID",
        );
      }

      row.collectionReference = text(
        input.collectionReference,
        "actual COD collection reference",
        200,
        true,
      );

      row.codCollectedPaise =
        snapshot.amountDuePaise;

      row.codCollectedAt = now;

      const gross =
        order.shippingSnapshot.payNowPaise +
        progress.parcels.reduce(
          (sum, parcel) =>
            sum + parcel.codCollectedPaise,
          0,
        );

      payment.grossCollected = gross / 100;
      payment.refundedAmount = 0;
      payment.amountPaid = gross / 100;

      payment.amountDue =
        (
          order.shippingSnapshot.totalPaise -
          gross
        ) / 100;

      payment.amountsReconciled = true;

      payment.status =
        payment.amountDue === 0
          ? "paid"
          : "partially-paid";

      payment.balanceStatus =
        payment.amountDue === 0
          ? "collected"
          : "pending";

      if (payment.amountDue === 0) {
        payment.balanceCollectedAt = now;
        payment.paidAt = now;
      }

      description =
        `${snapshot.label}: COD balance of ₹` +
        `${(row.codCollectedPaise / 100).toFixed(2)} ` +
        "recorded as collected.";
    }

    row.updatedBy = String(adminId);
    row.updatedAt = now;
  }

  progress.revision += 1;
  progress.updatedBy = String(adminId);
  progress.updatedAt = now;

  const stage = progressStage(order, progress);

  const status =
    stage === "delivered"
      ? "delivered"
      : stage === "out-for-delivery"
        ? "out-for-delivery"
        : stage === "shipped"
          ? "shipped"
          : input.action === "initialize" &&
              order.status === "confirmed"
            ? "confirmed"
            : "processing";

  delivery.status =
    status === "confirmed"
      ? "pending"
      : status;

  if (status === "delivered") {
    delivery.deliveredAt ||= now;
  }

  const candidate = {
    ...order,
    items: order.items,
    kitSnapshots: order.kitSnapshots,
    shippingSnapshot: order.shippingSnapshot,
    fulfillmentProgress: progress,
    payment,
    delivery,
    status,
  };

  validateKitProgress(candidate);

  return {
    progress,
    payment,
    delivery,
    status,
    description,
  };
}

module.exports = {
  PARCEL_STAGES,
  PROCUREMENT_STAGES,
  collectedKitCodPaise,
  initializeKitFulfillment,
  progressStage,
  validateKitProgress,
  applyKitFulfillmentAction,
};