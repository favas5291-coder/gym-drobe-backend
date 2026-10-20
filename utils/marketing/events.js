"use strict";

const crypto = require("node:crypto");
const { isIP } = require("node:net");

const {
  Event,
  Consent,
} = require("../../models/MarketingStore");

const Order = require("../../models/Order");
const Product = require("../../models/Product");

const {
  customerFilter,
} = require("../customerAccess");

const {
  getConfig,
  ready,
  EVENT_NAMES,
  FINANCIAL_EVENTS,
} = require("./config");

const {
  objectId,
  toPaise,
  fromPaise,
  variantId,
  catalogVariants,
  productEligible,
  siteOrigin,
} = require("./rules");

const DAY = 86400000;
const MAX_EVENT_AGE = 6 * DAY;
const MAX_RECEIPT_AGE = DAY;

const SUBJECT =
  /^[a-f0-9]{64}$/;

const CONTENT_ID =
  /^gd_[a-f0-9]{24}(?:_[a-f0-9]{16})?$/;

const ACTIVE_STATUSES = [
  "confirmed",
  "processing",
  "packed",
  "shipped",
  "out-for-delivery",
  "delivered",
];

const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");

function milliseconds(value) {
  if (
    value == null ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  const result =
    new Date(value).getTime();

  return (
    Number.isFinite(result) &&
    result > 0
  )
    ? result
    : null;
}

function consentSubject(req) {
  const token =
    req.get?.("X-GymDrobe-Marketing") ||
    req.headers?.["x-gymdrobe-marketing"] ||
    "";

  return (
    typeof token === "string" &&
    /^mkt_[a-f0-9]{64}$/.test(token)
  )
    ? hash(token)
    : "";
}

async function readConsent(
  subject,
  version = null,
) {
  if (
    !SUBJECT.test(subject || "")
  ) {
    return null;
  }

  const filter = {
    _id: subject,
    granted: true,

    expiresAt: {
      $gt: new Date(),
    },
  };

  if (version != null) {
    filter.version = version;
  }

  return Consent.findOne(filter)
    .read("primary")
    .maxTimeMS(2000)
    .lean();
}

function cookieIdentifier(
  value,
  kind,
) {
  if (
    typeof value !== "string" ||
    value.length > 600
  ) {
    return "";
  }

  const match =
    /^fb\.[0-9]+\.(\d{13})\.([A-Za-z0-9_-]+)$/.exec(
      value,
    );

  if (
    !match ||
    Number(match[1]) >
      Date.now() + 300000
  ) {
    return "";
  }

  if (
    kind === "fbp" &&
    !/^\d{1,30}$/.test(match[2])
  ) {
    return "";
  }

  return value;
}

function buildUserData(
  consent,
  order = null,
) {
  if (
    !consent ||
    consent.granted !== true ||
    (
      milliseconds(
        consent.expiresAt,
      ) || 0
    ) <= Date.now()
  ) {
    return {};
  }

  const result = {};

  // IP, user agent and Meta cookie identifiers
  // must not be hashed.
  if (
    typeof consent.clientIP === "string" &&
    isIP(consent.clientIP)
  ) {
    result.client_ip_address =
      consent.clientIP;
  }

  if (
    typeof consent.agent === "string" &&
    consent.agent.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(
      consent.agent,
    )
  ) {
    result.client_user_agent =
      consent.agent;
  }

  for (const key of ["fbc", "fbp"]) {
    const value =
      cookieIdentifier(
        consent[key],
        key,
      );

    if (
      value &&
      (
        milliseconds(
          consent[
            `${key}ExpiresAt`
          ],
        ) || 0
      ) > Date.now()
    ) {
      result[key] = value;
    }
  }

  // Additional contact matching needs its own
  // recorded preference.
  if (
    consent.matching === true &&
    order?.shippingAddress
  ) {
    const address =
      order.shippingAddress;

    const email =
      typeof address.email === "string"
        ? address.email
            .trim()
            .toLowerCase()
        : "";

    if (
      email.length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email,
      )
    ) {
      result.em = [
        hash(email),
      ];
    }

    let phone =
      typeof address.phone === "string"
        ? address.phone.replace(
            /\D/g,
            "",
          )
        : "";

    // Existing checkout accepts Indian
    // delivery phone numbers.
    if (
      /^[6-9]\d{9}$/.test(phone)
    ) {
      phone = `91${phone}`;
    }

    if (
      /^91[6-9]\d{9}$/.test(phone)
    ) {
      result.ph = [
        hash(phone),
      ];
    }
  }

  return result;
}

function itemSignature(items) {
  return hash(
    JSON.stringify(
      items.map((item) => [
        objectId(item.product),
        item.selectedSize ?? null,
        item.selectedColor ?? null,
        item.quantity,
      ]),
    ),
  );
}

function eventId(
  eventName,
  key,
) {
  if (
    !EVENT_NAMES.includes(
      eventName,
    ) ||
    typeof key !== "string" ||
    !key
  ) {
    throw new Error(
      "Invalid marketing event identity.",
    );
  }

  return (
    "gd_e_" +
    hash(
      JSON.stringify([
        eventName,
        key,
      ]),
    )
  );
}

async function orderContext(
  req,
  items,
) {
  // Read-only optional enrichment.
  // A timeout cannot hold up order creation.
  let timer;

  const capture = async () => {
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > 50
    ) {
      return null;
    }

    const config =
      await getConfig();

    if (
      !ready(config, "pixel") &&
      !ready(config, "capi")
    ) {
      return null;
    }

    const consent =
      await readConsent(
        consentSubject(req),
      );

    if (!consent) {
      return null;
    }

    const ids = items.map(
      (item) =>
        objectId(item.product),
    );

    if (
      ids.some((id) => !id)
    ) {
      return null;
    }

    const products =
      await Product.find({
        _id: {
          $in: ids,
        },
        isActive: true,
      })
        .select("+metaMarketing")
        .maxTimeMS(1000)
        .lean();

    const byId = new Map(
      products.map(
        (product) => [
          objectId(product),
          product,
        ],
      ),
    );

    const contents = [];

    for (const item of items) {
      const product = byId.get(
        objectId(
          item.product,
        ),
      );

      if (
        !productEligible(product) ||
        !Number.isSafeInteger(
          item.quantity,
        ) ||
        item.quantity < 1 ||
        item.quantity > 1000000
      ) {
        return null;
      }

      const size =
        item.selectedSize ?? null;

      const color =
        item.selectedColor ?? null;

      const selected =
        catalogVariants(product).find(
          (row) =>
            row.size === size &&
            row.color === color,
        );

      if (!selected) {
        return null;
      }

      contents.push({
        id: variantId(
          product,
          size,
          color,
        ),

        quantity:
          item.quantity,
      });
    }

    return {
      version: 1,

      subject:
        consent._id,

      consentVersion:
        consent.version,

      datasetId:
        config.datasetId,

      epoch:
        config.epoch,

      testMode:
        config.testMode !== false,

      codModel:
        config.codModel,

      capturedAt:
        new Date(),

      signature:
        itemSignature(items),

      contents,

      attribution: {
        firstTouch:
          consent.firstTouch || null,

        lastTouch:
          consent.lastTouch || null,
      },
    };
  };

  try {
    return await Promise.race([
      capture(),

      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve(null),
          350,
        );
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function deliveredTime(
  order,
  advance,
  total,
) {
  const delivered =
    milliseconds(
      order.delivery?.deliveredAt,
    );

  if (
    order.status !== "delivered" ||
    !delivered
  ) {
    return null;
  }

  const shipments =
    order.shippingSnapshot?.shipments;

  const parcels =
    order.fulfillmentProgress?.parcels;

  if (
    !shipments &&
    !parcels
  ) {
    return delivered;
  }

  if (
    !Array.isArray(shipments) ||
    !shipments.length ||
    !Array.isArray(parcels) ||
    shipments.length !==
      parcels.length
  ) {
    return null;
  }

  const byKey = new Map(
    parcels.map((parcel) => [
      parcel.key,
      parcel,
    ]),
  );

  if (
    byKey.size !== parcels.length ||
    new Set(
      shipments.map(
        (row) => row.key,
      ),
    ).size !== shipments.length
  ) {
    return null;
  }

  let latest = delivered;
  let collected = 0;

  for (const shipment of shipments) {
    const parcel = byKey.get(
      shipment.key,
    );

    const time =
      milliseconds(
        parcel?.deliveredAt,
      );

    const due =
      shipment.amountDuePaise;

    if (
      !parcel ||
      parcel.status !== "delivered" ||
      !time ||
      !Number.isSafeInteger(due) ||
      due < 0 ||
      parcel.codCollectedPaise !== due
    ) {
      return null;
    }

    const collection =
      milliseconds(
        parcel.codCollectedAt,
      );

    if (
      due > 0 &&
      !collection
    ) {
      return null;
    }

    latest = Math.max(
      latest,
      time,
      collection || 0,
    );

    collected += due;
  }

  return (
    Number.isSafeInteger(collected) &&
    collected === total - advance
  )
    ? latest
    : null;
}

function financialMilestones(order) {
  const payment =
    order?.payment;

  const context =
    order?.marketing;

  if (
    !payment ||
    !context ||
    !ACTIVE_STATUSES.includes(
      order.status,
    ) ||
    order.cancellation?.status ===
      "cancelled" ||
    ![
      undefined,
      "not-requested",
    ].includes(
      order.refund?.status,
    ) ||
    [
      "requested",
      "approved",
      "completed",
    ].includes(
      order.returnRequest?.status,
    ) ||
    order.metadata?.inventoryReserved !==
      true ||
    payment.amountsReconciled !== true ||
    payment.gateway !== "razorpay" ||
    !/^order_[A-Za-z0-9]+$/.test(
      payment.razorpayOrderId || "",
    ) ||
    !/^pay_[A-Za-z0-9]+$/.test(
      payment.razorpayPaymentId ||
        payment.transactionId ||
        "",
    ) ||
    ![
      "paid",
      "partially-paid",
    ].includes(
      payment.status,
    ) ||
    order.pricing?.currency !== "INR"
  ) {
    return [];
  }

  const verified =
    milliseconds(
      payment.verifiedAt,
    );

  const total = toPaise(
    order.pricing.finalTotal,
  );

  const merchandise = toPaise(
    order.pricing.totalAfterCoupon,
  );

  const shipping = toPaise(
    order.pricing.shipping,
  );

  const paid = toPaise(
    payment.amountPaid,
  );

  const due = toPaise(
    payment.amountDue,
  );

  if (
    !verified ||
    [
      total,
      merchandise,
      shipping,
      paid,
      due,
    ].some(
      (value) => value == null,
    ) ||
    total < 100 ||
    merchandise + shipping !== total ||
    paid + due !== total ||
    toPaise(
      payment.totalAmount,
    ) !== total ||
    toPaise(
      payment.refundedAmount ?? 0,
    ) !== 0 ||
    (
      payment.grossCollected != null &&
      toPaise(
        payment.grossCollected,
      ) !== paid
    ) ||
    !Array.isArray(order.items) ||
    !order.items.length ||
    !Array.isArray(
      context.contents,
    ) ||
    context.contents.length !==
      order.items.length ||
    context.signature !==
      itemSignature(order.items) ||
    context.contents.some(
      (row, index) =>
        !CONTENT_ID.test(
          row.id || "",
        ) ||
        row.quantity !==
          order.items[index].quantity ||
        !Number.isSafeInteger(
          row.quantity,
        ) ||
        row.quantity < 1,
    )
  ) {
    return [];
  }

  const contents =
    context.contents.map(
      (row) => ({
        id: row.id,
        quantity: row.quantity,
      }),
    );

  const base = {
    currency: "INR",

    order_id: String(
      order.orderNumber ||
        objectId(order),
    ),

    content_type: "product",

    content_ids:
      contents.map(
        (row) => row.id,
      ),

    contents,

    num_items:
      contents.reduce(
        (sum, row) =>
          sum + row.quantity,
        0,
      ),

    order_value:
      fromPaise(total),

    shipping:
      fromPaise(shipping),
  };

  const milestone = (
    name,
    time,
    data,
    source = "website",
  ) => ({
    eventName: name,

    eventTime: Math.floor(
      time / 1000,
    ),

    actionSource: source,

    customData: {
      ...base,
      ...data,
    },
  });

  if (
    payment.method === "razorpay" &&
    payment.status === "paid" &&
    paid === total &&
    due === 0
  ) {
    return [
      milestone(
        "OrderPlaced",
        verified,
        {
          measurement_model:
            "prepaid-accepted",
        },
      ),

      milestone(
        "Purchase",
        verified,
        {
          value:
            fromPaise(total),

          completed_sale_revenue:
            fromPaise(total),

          advance_collected: 0,
          balance_due: 0,

          measurement_model:
            "prepaid-verified",
        },
      ),
    ];
  }

  if (
    payment.method !==
      "cod-partial" ||
    ![
      "delivered-collected",
      "order-acceptance",
    ].includes(
      context.codModel,
    )
  ) {
    return [];
  }

  const advance = toPaise(
    payment.advanceAmount,
  );

  const advanceTime =
    milliseconds(
      payment.advancePaidAt,
    );

  if (
    !advanceTime ||
    advance == null ||
    advance < 100 ||
    advance > total ||
    advance !==
      Math.round(
        merchandise / 10,
      ) ||
    paid < advance
  ) {
    return [];
  }

  const results = [
    milestone(
      "OrderPlaced",
      verified,
      {
        measurement_model:
          "cod-advance-accepted",
      },
    ),

    milestone(
      "CODAdvancePaid",
      advanceTime,
      {
        value:
          fromPaise(advance),

        advance_collected:
          fromPaise(advance),

        balance_due:
          fromPaise(
            total - advance,
          ),

        completed_sale_revenue: 0,

        measurement_model:
          "cod-advance-only",
      },
    ),
  ];

  if (
    context.codModel ===
    "order-acceptance"
  ) {
    results.push(
      milestone(
        "Purchase",
        verified,
        {
          value:
            fromPaise(total),

          advance_collected:
            fromPaise(advance),

          balance_due:
            fromPaise(
              total - advance,
            ),

          completed_sale_revenue: 0,

          measurement_model:
            "cod-accepted-booked-value",
        },
      ),
    );
  } else {
    const delivery =
      deliveredTime(
        order,
        advance,
        total,
      );

    const collection =
      milliseconds(
        payment.balanceCollectedAt,
      );

    if (
      payment.status === "paid" &&
      paid === total &&
      due === 0 &&
      payment.balanceStatus ===
        "collected" &&
      collection &&
      delivery
    ) {
      results.push(
        milestone(
          "Purchase",

          Math.max(
            delivery,
            collection,
          ),

          {
            value:
              fromPaise(total),

            advance_collected:
              fromPaise(advance),

            balance_due: 0,

            completed_sale_revenue:
              fromPaise(total),

            measurement_model:
              "cod-delivered-collected",
          },

          "system_generated",
        ),
      );
    }
  }

  return results;
}

function contextMatches(
  context,
  config,
) {
  return (
    context &&
    context.datasetId ===
      config.datasetId &&
    context.epoch ===
      config.epoch &&
    context.testMode ===
      (config.testMode !== false)
  );
}

function eventMatches(
  row,
  config,
) {
  return (
    row &&
    row.datasetId ===
      config.datasetId &&
    row.testMode ===
      (config.testMode !== false) &&
    row.payload?._gymdrobeEpoch ===
      config.epoch
  );
}

async function storeEvent(
  config,
  consent,
  details,
  identity,
  order = null,
) {
  if (
    !config.allowedEvents.includes(
      details.eventName,
    ) ||
    (
      !ready(config, "pixel") &&
      !ready(config, "capi")
    )
  ) {
    return null;
  }

  const current =
    await readConsent(
      consent._id,
      consent.version,
    );

  if (!current) {
    return null;
  }

  const id = eventId(
    details.eventName,
    identity,
  );

  const time =
    details.eventTime * 1000;

  const expired =
    !Number.isSafeInteger(
      details.eventTime,
    ) ||
    time > Date.now() + 300000 ||
    Date.now() - time >
      MAX_EVENT_AGE;

  const userData =
    buildUserData(
      current,
      order,
    );

  const queued =
    !expired &&
    ready(config, "capi") &&
    Object.keys(
      userData,
    ).length > 0;

  const state = expired
    ? "expired"
    : queued
      ? "queued"
      : "browser-only";

  const payload = expired
    ? null
    : {
        // Internal only. The delivery worker
        // removes this before calling Meta.
        _gymdrobeEpoch:
          config.epoch,

        event_name:
          details.eventName,

        event_id: id,

        event_time:
          details.eventTime,

        action_source:
          details.actionSource ||
          "website",

        custom_data:
          details.customData,

        ...(
          (
            details.actionSource ||
            "website"
          ) === "website"
            ? {
                event_source_url:
                  siteOrigin() +
                  (
                    details.sourcePath ||
                    "/order-success"
                  ),
              }
            : {}
        ),
      };

  const row = {
    _id: id,
    eventId: id,

    eventName:
      details.eventName,

    eventTime:
      details.eventTime,

    subject:
      current._id,

    consentVersion:
      current.version,

    order: order
      ? objectId(order)
      : undefined,

    payload,

    userData: expired
      ? null
      : userData,

    datasetId:
      config.datasetId,

    apiVersion:
      config.apiVersion,

    testMode:
      config.testMode !== false,

    testEventCode:
      config.testEventCode,

    state,
    attempts: 0,

    nextAttemptAt:
      new Date(),

    ...(
      !FINANCIAL_EVENTS.includes(
        details.eventName,
      )
        ? {
            expiresAt: new Date(
              Date.now() +
                45 * DAY,
            ),
          }
        : {}
    ),
  };

  try {
    await Event.updateOne(
      {
        _id: id,
      },
      {
        $setOnInsert: row,
      },
      {
        upsert: true,
      },
    );
  } catch (error) {
    if (
      error.code !== 11000
    ) {
      throw error;
    }
  }

  // Close the insert/withdrawal race.
  // The worker checks again before delivery.
  if (
    !(await readConsent(
      current._id,
      current.version,
    ))
  ) {
    await Event.updateOne(
      {
        _id: id,

        state: {
          $in: [
            "queued",
            "browser-only",
            "processing",
          ],
        },
      },
      {
        $set: {
          state: "suppressed",

          suppression:
            "consent-withdrawn",
        },

        $unset: {
          payload: 1,
          userData: 1,
        },
      },
    );

    return null;
  }

  return id;
}

async function queueOrderEvents(id) {
  try {
    const key = objectId(id);

    if (!key) {
      return {
        prepared: 0,
      };
    }

    const config =
      await getConfig();

    if (
      !ready(config, "pixel") &&
      !ready(config, "capi")
    ) {
      return {
        prepared: 0,
      };
    }

    const order =
      await Order.findById(key)
        .select("+marketing")
        .read("primary")
        .maxTimeMS(2000)
        .lean();

    if (
      !order ||
      !contextMatches(
        order.marketing,
        config,
      ) ||
      (
        !config.testMode &&
        order.metadata?.demo !==
          false
      ) ||
      (
        config.testMode &&
        order.metadata?.demo !==
          true
      )
    ) {
      return {
        prepared: 0,
      };
    }

    const consent =
      await readConsent(
        order.marketing.subject,
        order.marketing.consentVersion,
      );

    if (!consent) {
      return {
        prepared: 0,
      };
    }

    let prepared = 0;

    for (
      const details of
      financialMilestones(order)
    ) {
      if (
        await storeEvent(
          config,
          consent,
          details,
          `order:${key}`,
          order,
        )
      ) {
        prepared++;
      }
    }

    return {
      prepared,
    };
  } catch {
    // Callers may retry later.
    // Never log order/contact data
    // or block a payment.
    return {
      prepared: 0,
      unavailable: true,
    };
  }
}

async function financialReceipts(
  req,
  id,
) {
  try {
    const key = objectId(id);

    if (!key) {
      return [];
    }

    const config =
      await getConfig();

    if (
      !ready(config, "pixel")
    ) {
      return [];
    }

    const order =
      await Order.findOne({
        _id: key,
        ...customerFilter(req),
      })
        .select("+marketing")
        .read("primary")
        .maxTimeMS(2000)
        .lean();

    const subject =
      consentSubject(req);

    if (
      !order ||
      order.marketing?.subject !==
        subject ||
      !contextMatches(
        order.marketing,
        config,
      )
    ) {
      return [];
    }

    const consent =
      await readConsent(
        subject,
        order.marketing.consentVersion,
      );

    if (!consent) {
      return [];
    }

    await queueOrderEvents(key);

    const eligibleNames =
      new Set(
        financialMilestones(
          order,
        ).map(
          (row) =>
            row.eventName,
        ),
      );

    const rows =
      await Event.find({
        order: key,
        subject,

        consentVersion:
          consent.version,

        eventName: {
          $in:
            FINANCIAL_EVENTS,
        },

        state: {
          $in: [
            "queued",
            "processing",
            "accepted",
            "browser-only",
          ],
        },

        eventTime: {
          $gte: Math.floor(
            (
              Date.now() -
              MAX_RECEIPT_AGE
            ) / 1000,
          ),
        },

        datasetId:
          config.datasetId,

        testMode:
          config.testMode !== false,
      })
        .maxTimeMS(2000)
        .lean();

    return rows
      .filter(
        (row) =>
          eligibleNames.has(
            row.eventName,
          ) &&
          config.allowedEvents.includes(
            row.eventName,
          ) &&
          eventMatches(
            row,
            config,
          ),
      )
      .map((row) => ({
        eventName:
          row.eventName,

        eventId:
          row.eventId,

        eventTime:
          row.eventTime,

        data:
          row.payload.custom_data,
      }));
  } catch {
    return [];
  }
}

// Internal helper for the server-validated
// shopping-event handler.
// customData must come from server-loaded public
// records, never req.body wholesale.
async function queuePublicEvent(
  req,
  {
    eventName,
    actionId,
    sourcePath = "/",
    customData = {},
    consentVersion = null,
    expectedConfig = null,
  } = {},
) {
  try {
    if (
      !EVENT_NAMES.includes(
        eventName,
      ) ||
      FINANCIAL_EVENTS.includes(
        eventName,
      ) ||
      typeof actionId !== "string" ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(
        actionId,
      ) ||
      !/^(?:\/|\/(?:shop|offers|cart|wishlist|checkout|kits)|\/(?:product|kits)\/[a-f0-9]{24})$/.test(
        sourcePath,
      )
    ) {
      return null;
    }

    const config =
      await getConfig();

    if (
      !ready(config, "pixel") &&
      !ready(config, "capi")
    ) {
      return null;
    }

    if (
      expectedConfig &&
      !contextMatches(
        expectedConfig,
        config,
      )
    ) {
      return null;
    }

    const consent =
      await readConsent(
        consentSubject(req),
        consentVersion,
      );

    if (!consent) {
      return null;
    }

    const id =
      await storeEvent(
        config,
        consent,
        {
          eventName,

          eventTime:
            Math.floor(
              Date.now() / 1000,
            ),

          sourcePath,
          customData,
        },

        `browser:${consent._id}:${actionId}`,
      );

    if (!id) {
      return null;
    }

    const row =
      await Event.findOne({
        _id: id,

        subject:
          consent._id,

        consentVersion:
          consent.version,

        state: {
          $in: [
            "queued",
            "processing",
            "accepted",
            "browser-only",
          ],
        },
      })
        .maxTimeMS(2000)
        .lean();

    return (
      row?.payload &&
      eventMatches(
        row,
        config,
      )
    )
      ? {
          eventName:
            row.eventName,

          eventId:
            row.eventId,

          eventTime:
            row.eventTime,

          data:
            row.payload.custom_data,
        }
      : null;
  } catch {
    return null;
  }
}

module.exports = {
  MAX_EVENT_AGE,
  MAX_RECEIPT_AGE,

  consentSubject,
  readConsent,
  buildUserData,
  itemSignature,
  eventId,

  orderContext,
  financialMilestones,
  contextMatches,
  eventMatches,

  queueOrderEvents,
  financialReceipts,
  queuePublicEvent,
};