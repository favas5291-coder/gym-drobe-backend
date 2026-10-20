"use strict";

const crypto = require("node:crypto");
const { isIP } = require("node:net");
const {
  isDeepStrictEqual,
} = require("node:util");

const {
  Config,
  Event,
  Checkpoint,
  Consent,
} = require("../../models/MarketingStore");

const Order = require("../../models/Order");
const Product = require("../../models/Product");

const {
  getConfig,
  getAccessToken,
  graphEventsUrl,
  ready,
  FINANCIAL_EVENTS,
} = require("./config");

const {
  MAX_EVENT_AGE,
  readConsent,
  eventMatches,
  contextMatches,
  financialMilestones,
  queueOrderEvents,
  buildUserData,
} = require("./events");

const {
  objectId,
  toPaise,
  siteOrigin,
  productEligible,
  FAMILIES,
} = require("./rules");

const {
  refreshFeed,
} = require("./feed");

const DAY = 86400000;
const MAX_ATTEMPTS = 8;
const RETRY_WINDOW = DAY;
const LEASE_MS = 120000;
const LOCK = "meta-delivery-worker";

const CID =
  /^gd_[a-f0-9]{24}(?:_[a-f0-9]{16})?$/;

function problem(code) {
  return Object.assign(
    new Error(code),
    { code },
  );
}

function retryDelay(
  attempt,
  header = "",
) {
  const parsed = /^\d+$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();

  const base = Math.min(
    3600000,
    30000 *
      2 ** Math.max(0, attempt - 1),
  );

  return (
    Math.min(
      3600000,
      Math.max(
        base,
        Number.isFinite(parsed)
          ? parsed
          : 0,
      ),
    ) + crypto.randomInt(0, 1001)
  );
}

function outgoingEvent(
  row,
  consent,
) {
  if (
    !consent ||
    consent.granted !== true ||
    consent.version !==
      row.consentVersion ||
    !(
      new Date(
        consent.expiresAt,
      ).getTime() > Date.now()
    )
  ) {
    throw problem(
      "CONSENT_WITHDRAWN",
    );
  }

  const payload = row.payload;

  if (
    !payload ||
    payload.event_id !== row.eventId ||
    payload.event_name !== row.eventName ||
    payload.event_time !== row.eventTime ||
    ![
      "website",
      "system_generated",
    ].includes(
      payload.action_source,
    )
  ) {
    throw problem(
      "EVENT_PAYLOAD_INVALID",
    );
  }

  const data =
    payload.custom_data || {};

  const custom = {};

  for (const key of [
    "value",
    "order_value",
    "shipping",
    "advance_collected",
    "balance_due",
    "completed_sale_revenue",
  ]) {
    if (
      data[key] !== undefined
    ) {
      if (
        toPaise(data[key]) == null ||
        typeof data[key] !== "number"
      ) {
        throw problem(
          "EVENT_AMOUNT_INVALID",
        );
      }

      custom[key] = data[key];
    }
  }

  if (
    data.currency !== undefined
  ) {
    if (
      data.currency !== "INR"
    ) {
      throw problem(
        "EVENT_CURRENCY_INVALID",
      );
    }

    custom.currency = "INR";
  }

  if (
    data.content_type !== undefined
  ) {
    if (
      ![
        "product",
        "product_group",
      ].includes(
        data.content_type,
      )
    ) {
      throw problem(
        "EVENT_CONTENT_INVALID",
      );
    }

    custom.content_type =
      data.content_type;
  }

  if (
    data.content_ids !== undefined
  ) {
    if (
      !Array.isArray(
        data.content_ids,
      ) ||
      data.content_ids.length > 50 ||
      data.content_ids.some(
        (id) =>
          typeof id !== "string" ||
          !CID.test(id),
      )
    ) {
      throw problem(
        "EVENT_CONTENT_INVALID",
      );
    }

    custom.content_ids = [
      ...new Set(
        data.content_ids,
      ),
    ];
  }

  if (
    data.contents !== undefined
  ) {
    if (
      !Array.isArray(
        data.contents,
      ) ||
      data.contents.length > 50
    ) {
      throw problem(
        "EVENT_CONTENT_INVALID",
      );
    }

    custom.contents =
      data.contents.map((item) => {
        if (
          !item ||
          !CID.test(item.id || "") ||
          !Number.isSafeInteger(
            item.quantity,
          ) ||
          item.quantity < 1 ||
          item.quantity > 1000000
        ) {
          throw problem(
            "EVENT_CONTENT_INVALID",
          );
        }

        const result = {
          id: item.id,
          quantity: item.quantity,
        };

        if (
          item.item_price !== undefined
        ) {
          if (
            typeof item.item_price !==
              "number" ||
            toPaise(
              item.item_price,
            ) == null
          ) {
            throw problem(
              "EVENT_AMOUNT_INVALID",
            );
          }

          result.item_price =
            item.item_price;
        }

        return result;
      });
  }

  if (
    data.num_items !== undefined
  ) {
    if (
      !Number.isSafeInteger(
        data.num_items,
      ) ||
      data.num_items < 0
    ) {
      throw problem(
        "EVENT_CONTENT_INVALID",
      );
    }

    custom.num_items =
      data.num_items;
  }

  if (
    data.order_id !== undefined
  ) {
    if (
      typeof data.order_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(
        data.order_id,
      )
    ) {
      throw problem(
        "EVENT_ORDER_INVALID",
      );
    }

    custom.order_id =
      data.order_id;
  }

  if (
    data.measurement_model !== undefined
  ) {
    if (
      !/^[a-z-]{1,80}$/.test(
        data.measurement_model,
      )
    ) {
      throw problem(
        "EVENT_MODEL_INVALID",
      );
    }

    custom.measurement_model =
      data.measurement_model;
  }

  const source =
    row.userData || {};

  const user = {};

  if (
    typeof source.client_ip_address ===
      "string" &&
    isIP(
      source.client_ip_address,
    )
  ) {
    user.client_ip_address =
      source.client_ip_address;
  }

  if (
    typeof source.client_user_agent ===
      "string" &&
    source.client_user_agent.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(
      source.client_user_agent,
    )
  ) {
    user.client_user_agent =
      source.client_user_agent;
  }

  const current =
    buildUserData(consent);

  for (const key of [
    "fbc",
    "fbp",
  ]) {
    // Do not replace an old event's attribution
    // with a newer campaign identifier.
    if (
      source[key] &&
      source[key] === current[key]
    ) {
      user[key] = source[key];
    }
  }

  if (
    consent.matching === true
  ) {
    for (const key of [
      "em",
      "ph",
    ]) {
      if (
        Array.isArray(source[key])
      ) {
        const hashes =
          source[key].filter(
            (value) =>
              typeof value === "string" &&
              /^[a-f0-9]{64}$/.test(
                value,
              ),
          );

        if (
          hashes.length
        ) {
          user[key] =
            hashes.slice(0, 2);
        }
      }
    }
  }

  if (
    !Object.keys(user).length
  ) {
    throw problem(
      "EVENT_MATCHING_UNAVAILABLE",
    );
  }

  const result = {
    event_name: row.eventName,
    event_id: row.eventId,
    event_time: row.eventTime,

    action_source:
      payload.action_source,

    user_data: user,
    custom_data: custom,
  };

  if (
    payload.action_source ===
    "website"
  ) {
    const url = new URL(
      payload.event_source_url,
    );

    if (
      url.origin !== siteOrigin() ||
      url.search ||
      url.hash ||
      !/^(?:\/|\/(?:shop|offers|cart|wishlist|checkout|order-success|kits)|\/(?:product|kits)\/[a-f0-9]{24})$/.test(
        url.pathname,
      )
    ) {
      throw problem(
        "EVENT_SOURCE_INVALID",
      );
    }

    result.event_source_url =
      url.href;
  }

  return result;
}

function createMarketingWorker({
  fetchImpl = globalThis.fetch,
} = {}) {
  let timer = null;
  let running = false;
  let feedRunning = false;
  let lastCleanup = 0;
  let lastFeedCheck = 0;
  let stopped = false;
  let activeRequest = null;

  async function acquire(owner) {
    try {
      await Checkpoint.updateOne(
        {
          _id: LOCK,
        },
        {
          $setOnInsert: {
            owner: "",
            leaseUntil:
              new Date(0),
          },
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

    return Checkpoint
      .findOneAndUpdate(
        {
          _id: LOCK,

          $or: [
            {
              leaseUntil: {
                $lte: new Date(),
              },
            },
            {
              leaseUntil: null,
            },
          ],
        },
        {
          $set: {
            owner,

            leaseUntil:
              new Date(
                Date.now() +
                  LEASE_MS,
              ),
          },
        },
        {
          new: true,
        },
      )
      .lean();
  }

  async function renew(owner) {
    const result =
      await Checkpoint.updateOne(
        {
          _id: LOCK,
          owner,

          leaseUntil: {
            $gt: new Date(),
          },
        },
        {
          $set: {
            leaseUntil:
              new Date(
                Date.now() +
                  LEASE_MS,
              ),
          },
        },
      );

    if (
      result.matchedCount !== 1
    ) {
      throw problem(
        "WORKER_LEASE_LOST",
      );
    }
  }

  async function scanOrders(
    owner,
    checkpointId,
    deadline,
    recover = false,
  ) {
    await Checkpoint.updateOne(
      {
        _id: checkpointId,
      },
      {
        $setOnInsert: {
          time: new Date(
            Date.now() -
              MAX_EVENT_AGE,
          ),

          cursor: "",
        },
      },
      {
        upsert: true,
      },
    );

    await Checkpoint.updateOne(
      {
        _id: checkpointId,
      },
      {
        $set: {
          owner,
        },
      },
    );

    const point =
      await Checkpoint
        .findById(checkpointId)
        .read("primary")
        .maxTimeMS(2000)
        .lean();

    const cutoff =
      new Date(
        Date.now() - 5000,
      );

    const after =
      point.cursor
        ? {
            $or: [
              {
                updatedAt: {
                  $gt: point.time,
                },
              },
              {
                updatedAt:
                  point.time,

                _id: {
                  $gt:
                    point.cursor,
                },
              },
            ],
          }
        : {
            updatedAt: {
              $gte: point.time,
            },
          };

    const orders =
      await Order.find({
        $and: [
          after,
          {
            updatedAt: {
              $lte: cutoff,
            },
          },
        ],

        "marketing.subject": {
          $type: "string",
        },
      })
        .select("_id updatedAt")
        .sort({
          updatedAt: 1,
          _id: 1,
        })
        .limit(50)
        .read("primary")
        .maxTimeMS(3000)
        .lean();

    let checked = 0;

    for (const order of orders) {
      if (
        stopped ||
        Date.now() >= deadline
      ) {
        return checked;
      }

      await renew(owner);

      const result =
        await queueOrderEvents(
          order._id,
        );

      if (
        result.unavailable
      ) {
        throw problem(
          "ORDER_EVENT_QUEUE_UNAVAILABLE",
        );
      }

      const saved =
        await Checkpoint.updateOne(
          {
            _id: checkpointId,
            owner,
          },
          {
            $set: {
              time:
                order.updatedAt,

              cursor:
                objectId(order),
            },
          },
        );

      if (
        saved.matchedCount !== 1
      ) {
        throw problem(
          "WORKER_LEASE_LOST",
        );
      }

      checked++;
    }

    if (
      !orders.length
    ) {
      await Checkpoint.updateOne(
        {
          _id: checkpointId,
          owner,
        },
        {
          $set: {
            time: recover
              ? new Date(
                  Date.now() -
                    MAX_EVENT_AGE,
                )
              : cutoff,

            cursor: "",
          },
        },
      );

      if (recover) {
        await Checkpoint.updateOne(
          {
            _id:
              "meta-recovery-finished",
          },
          {
            $set: {
              time:
                new Date(),
            },
          },
          {
            upsert: true,
          },
        );
      }
    }

    return checked;
  }

  const claimFilter = (row) => ({
    _id: row._id,
    state: "processing",
    leaseUntil: row.leaseUntil,
    attempts: row.attempts,
  });

  async function settle(
    row,
    state,
    code = "",
    erase = false,
    delay = 0,
  ) {
    return Event.updateOne(
      claimFilter(row),
      {
        $set: {
          state,
          errorCode: code,

          ...(state === "accepted"
            ? {
                acceptedAt:
                  new Date(),
              }
            : {}),

          ...(state === "queued"
            ? {
                nextAttemptAt:
                  new Date(
                    Date.now() +
                      delay,
                  ),
              }
            : {}),

          ...(state === "suppressed"
            ? {
                suppression:
                  code,
              }
            : {}),
        },

        $unset: {
          leaseUntil: 1,

          ...(erase
            ? {
                payload: 1,
                userData: 1,
              }
            : {}),
        },
      },
    );
  }

  async function policyAllows(
    row,
    config,
  ) {
    if (
      FINANCIAL_EVENTS.includes(
        row.eventName,
      )
    ) {
      const order =
        await Order
          .findById(row.order)
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
        order.marketing.subject !==
          row.subject ||
        order.marketing.consentVersion !==
          row.consentVersion ||
        order.metadata?.demo !==
          (config.testMode !== false)
      ) {
        return false;
      }

      const milestone =
        financialMilestones(
          order,
        ).find(
          (item) =>
            item.eventName ===
            row.eventName,
        );

      if (
        !milestone ||
        milestone.eventTime !==
          row.eventTime ||
        milestone.actionSource !==
          row.payload.action_source ||
        !isDeepStrictEqual(
          milestone.customData,
          row.payload.custom_data,
        )
      ) {
        return false;
      }

      const ids =
        order.items.map(
          (item) =>
            objectId(
              item.product,
            ),
        );

      const products =
        await Product.find({
          _id: {
            $in: ids,
          },
        })
          .select(
            "_id +metaMarketing",
          )
          .maxTimeMS(2000)
          .lean();

      // Deleted products retain their original,
      // server-approved order snapshot.
      return products.every(
        (product) =>
          product.metaMarketing?.status ===
            "approved" &&
          FAMILIES.includes(
            product.metaMarketing.family,
          ),
      );
    }

    const ids = [
      ...new Set(
        (
          row.payload.custom_data
            ?.content_ids || []
        ).map(
          (id) =>
            typeof id === "string" &&
            CID.test(id)
              ? id.slice(3, 27)
              : "",
        ),
      ),
    ];

    if (
      !ids.length
    ) {
      return (
        row.eventName ===
        "PageView"
      );
    }

    if (
      ids.some((id) => !id)
    ) {
      return false;
    }

    const products =
      await Product.find({
        _id: {
          $in: ids,
        },
      })
        .select("+metaMarketing")
        .maxTimeMS(2000)
        .lean();

    return (
      products.length ===
        ids.length &&
      products.every(
        (product) =>
          productEligible(
            product,
          ),
      )
    );
  }

  async function deliver(
    row,
    owner,
  ) {
    let config =
      await getConfig();

    if (
      !eventMatches(row, config) ||
      config.enabled !== true ||
      config.policiesReviewed !== true ||
      !config.allowedEvents.includes(
        row.eventName,
      )
    ) {
      await settle(
        row,
        "suppressed",
        "CONFIGURATION_CHANGED",
        true,
      );

      return "suppressed";
    }

    if (
      !ready(config, "capi")
    ) {
      await settle(
        row,

        config.capiEnabled
          ? "queued"
          : "browser-only",

        "CAPI_NOT_READY",
        false,
        60000,
      );

      return "paused";
    }

    const age =
      Date.now() -
      row.eventTime * 1000;

    const first =
      row.payload
        ?._gymdrobeFirstAttemptAt;

    if (
      !Number.isSafeInteger(
        row.eventTime,
      ) ||
      age < -300000 ||
      age > MAX_EVENT_AGE ||
      (
        row.attempts > 0 &&
        Date.now() -
          (
            first ||
            new Date(
              row.createdAt,
            ).getTime()
          ) >
          RETRY_WINDOW
      )
    ) {
      await settle(
        row,
        "expired",
        "EVENT_DELIVERY_WINDOW_CLOSED",
        true,
      );

      return "expired";
    }

    if (
      row.attempts >=
      MAX_ATTEMPTS
    ) {
      await settle(
        row,
        "failed",
        "RETRY_LIMIT_REACHED",
      );

      return "failed";
    }

    let consent =
      await readConsent(
        row.subject,
        row.consentVersion,
      );

    if (!consent) {
      await settle(
        row,
        "suppressed",
        "CONSENT_WITHDRAWN",
        true,
      );

      return "suppressed";
    }

    let outgoing;

    try {
      outgoing =
        outgoingEvent(
          row,
          consent,
        );
    } catch (error) {
      await settle(
        row,

        error.code ===
          "EVENT_MATCHING_UNAVAILABLE"
          ? "browser-only"
          : "failed",

        error.code ||
          "EVENT_PAYLOAD_INVALID",
      );

      return "failed";
    }

    if (
      !(await policyAllows(
        row,
        config,
      ))
    ) {
      await settle(
        row,
        "suppressed",
        "ORDER_OR_PRODUCT_POLICY_CHANGED",
        true,
      );

      return "suppressed";
    }

    await renew(owner);

    config =
      await getConfig();

    consent =
      await readConsent(
        row.subject,
        row.consentVersion,
      );

    if (
      !consent ||
      !eventMatches(row, config) ||
      !ready(config, "capi") ||
      !config.allowedEvents.includes(
        row.eventName,
      )
    ) {
      await settle(
        row,
        "suppressed",
        "PREFERENCE_OR_CONFIGURATION_CHANGED",
        true,
      );

      return "suppressed";
    }

    // Persist the attempt before any network
    // operation, including its retry deadline.
    const attempt =
      await Event.updateOne(
        claimFilter(row),
        {
          $inc: {
            attempts: 1,
          },

          ...(!first
            ? {
                $set: {
                  "payload._gymdrobeFirstAttemptAt":
                    Date.now(),
                },
              }
            : {}),
        },
      );

    if (
      attempt.matchedCount !== 1
    ) {
      return "suppressed";
    }

    row.attempts++;

    // Recheck after persisting the attempt.
    config =
      await getConfig();

    consent =
      await readConsent(
        row.subject,
        row.consentVersion,
      );

    if (
      !consent ||
      !eventMatches(row, config) ||
      !ready(config, "capi") ||
      !config.allowedEvents.includes(
        row.eventName,
      ) ||
      !(await Event.exists(
        claimFilter(row),
      ))
    ) {
      await settle(
        row,
        "suppressed",
        "PREFERENCE_OR_CONFIGURATION_CHANGED",
        true,
      );

      return "suppressed";
    }

    try {
      outgoing =
        outgoingEvent(
          row,
          consent,
        );
    } catch (error) {
      await settle(
        row,
        "suppressed",
        error.code ||
          "EVENT_PAYLOAD_INVALID",
        true,
      );

      return "suppressed";
    }

    if (stopped) {
      await settle(
        row,
        "queued",
        "WORKER_STOPPED",
        false,
        60000,
      );

      return "paused";
    }

    const controller =
      new AbortController();

    activeRequest =
      controller;

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        8000,
      );

    let code =
      "META_CONNECTION_FAILED";

    let retryAfter = "";
    let retry = true;

    try {
      const response =
        await fetchImpl(
          graphEventsUrl(
            config,
          ),
          {
            method: "POST",
            redirect: "error",

            signal:
              controller.signal,

            headers: {
              Accept:
                "application/json",

              "Content-Type":
                "application/json",

              Authorization:
                `Bearer ${getAccessToken()}`,
            },

            body:
              JSON.stringify({
                data: [
                  outgoing,
                ],

                ...(config.testMode
                  ? {
                      test_event_code:
                        config.testEventCode,
                    }
                  : {}),
              }),
          },
        );

      const body =
        await response
          .json()
          .catch(() => null);

      if (
        response.ok &&
        !body?.error &&
        body?.events_received === 1
      ) {
        const result =
          await settle(
            row,
            "accepted",
          );

        if (
          result.matchedCount !== 1
        ) {
          // An accepted in-flight request cannot
          // be recalled after withdrawal.
          // Record acceptance without restoring
          // erased data or changing suppression.
          await Event.updateOne(
            {
              _id:
                row._id,

              attempts:
                row.attempts,

              acceptedAt:
                null,
            },
            {
              $set: {
                acceptedAt:
                  new Date(),
              },
            },
          );
        }

        return "accepted";
      }

      const providerCode =
        Number.isSafeInteger(
          body?.error?.code,
        )
          ? body.error.code
          : null;

      code =
        providerCode != null
          ? `META_${providerCode}`
          : `META_HTTP_${
              Number(
                response.status,
              ) || 0
            }`;

      retryAfter =
        response.headers?.get(
          "retry-after",
        ) || "";

      retry =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500 ||
        response.ok ||
        body?.error?.is_transient ===
          true ||
        [
          1,
          2,
          4,
          17,
          32,
          613,
        ].includes(
          providerCode,
        );
    } catch {
      code =
        controller.signal.aborted
          ? "META_REQUEST_TIMEOUT"
          : "META_CONNECTION_FAILED";
    } finally {
      clearTimeout(timeout);
      activeRequest = null;
    }

    const state =
      retry &&
      row.attempts <
        MAX_ATTEMPTS
        ? "queued"
        : "failed";

    await settle(
      row,
      state,
      code,
      false,

      retryDelay(
        row.attempts,
        retryAfter,
      ),
    );

    return state === "queued"
      ? "retry"
      : "failed";
  }

  async function cleanup() {
    if (
      Date.now() -
        lastCleanup <
      15 * 60000
    ) {
      return;
    }

    const now =
      new Date();

    await Event.updateMany(
      {
        eventTime: {
          $lt:
            Math.floor(
              (
                Date.now() -
                MAX_EVENT_AGE
              ) / 1000,
            ),
        },

        state: {
          $in: [
            "queued",
            "processing",
            "browser-only",
          ],
        },
      },
      {
        $set: {
          state:
            "expired",

          errorCode:
            "EVENT_DELIVERY_WINDOW_CLOSED",
        },

        $unset: {
          payload: 1,
          userData: 1,
          leaseUntil: 1,
        },
      },
    );

    await Event.updateMany(
      {
        createdAt: {
          $lt:
            new Date(
              Date.now() -
                45 * DAY,
            ),
        },

        $or: [
          {
            payload: {
              $exists: true,
            },
          },
          {
            userData: {
              $exists: true,
            },
          },
        ],
      },
      {
        $unset: {
          payload: 1,
          userData: 1,
        },
      },
    );

    for (const key of [
      "firstTouch",
      "lastTouch",
    ]) {
      await Consent.updateMany(
        {
          [`${key}.expiresAt`]: {
            $lte: now,
          },
        },
        {
          $unset: {
            [key]: 1,
          },
        },
      );

      // Native update leaves order/payment
      // timestamps untouched.
      await Order.collection.updateMany(
        {
          [
            `marketing.attribution.${key}.expiresAt`
          ]: {
            $lte: now,
          },
        },
        {
          $unset: {
            [
              `marketing.attribution.${key}`
            ]: 1,
          },
        },
      );
    }

    for (const key of [
      "fbc",
      "fbp",
    ]) {
      await Consent.updateMany(
        {
          [`${key}ExpiresAt`]: {
            $lte: now,
          },
        },
        {
          $unset: {
            [key]: 1,

            [`${key}ExpiresAt`]:
              1,
          },
        },
      );
    }

    lastCleanup =
      Date.now();
  }

  function checkFeed() {
    if (
      feedRunning ||
      stopped ||
      Date.now() -
        lastFeedCheck <
        30000
    ) {
      return;
    }

    lastFeedCheck =
      Date.now();

    feedRunning = true;

    Promise.resolve()
      .then(
        () => refreshFeed(),
      )
      .catch(() => {})
      .finally(() => {
        feedRunning = false;
      });
  }

  async function runOnce() {
    if (
      running ||
      stopped
    ) {
      return {
        ok: true,
        skipped: true,
      };
    }

    if (
      Config.db.readyState !== 1
    ) {
      return {
        ok: false,

        code:
          "DATABASE_UNAVAILABLE",
      };
    }

    running = true;

    const owner =
      crypto.randomUUID();

    let locked = false;

    const counts = {
      accepted: 0,
      retry: 0,
      failed: 0,
      suppressed: 0,
      expired: 0,
      paused: 0,
    };

    try {
      checkFeed();

      locked = Boolean(
        await acquire(owner),
      );

      if (!locked) {
        return {
          ok: true,
          skipped: true,
        };
      }

      const config =
        await getConfig();

      const deadline =
        Date.now() + 25000;

      let ordersChecked = 0;

      if (
        ready(config, "pixel") ||
        ready(config, "capi")
      ) {
        ordersChecked =
          await scanOrders(
            owner,
            "meta-order-scan",
            Date.now() + 7000,
          );

        const recovered =
          await Checkpoint
            .findById(
              "meta-recovery-finished",
            )
            .read("primary")
            .maxTimeMS(2000)
            .lean();

        if (
          !recovered ||
          Date.now() -
            new Date(
              recovered.time,
            ).getTime() >
            6 * 3600000
        ) {
          ordersChecked +=
            await scanOrders(
              owner,
              "meta-order-recovery",

              Math.min(
                deadline,
                Date.now() +
                  3000,
              ),

              true,
            );
        }
      }

      for (
        let i = 0;
        i < 10 &&
        !stopped &&
        Date.now() <
          deadline;
        i++
      ) {
        await renew(owner);

        const now =
          new Date();

        const row =
          await Event
            .findOneAndUpdate(
              {
                $or: [
                  {
                    state:
                      "queued",

                    nextAttemptAt: {
                      $lte: now,
                    },
                  },
                  {
                    state:
                      "processing",

                    leaseUntil: {
                      $lte: now,
                    },
                  },
                ],
              },
              {
                $set: {
                  state:
                    "processing",

                  leaseUntil:
                    new Date(
                      Date.now() +
                        LEASE_MS,
                    ),
                },
              },
              {
                new: true,

                sort: {
                  nextAttemptAt: 1,
                  createdAt: 1,
                },
              },
            )
            .maxTimeMS(2000)
            .lean();

        if (!row) {
          break;
        }

        const result =
          await deliver(
            row,
            owner,
          );

        counts[result]++;
      }

      await cleanup();

      await Config.updateOne(
        {
          _id: "meta",
        },
        {
          $set: {
            lastWorkerAt:
              new Date(),

            ...(
              counts.failed ||
              counts.retry
                ? {
                    lastWorkerError:
                      "EVENT_DELIVERY_NEEDS_REVIEW",
                  }
                : counts.accepted
                  ? {
                      lastWorkerError:
                        "",
                    }
                  : {}
            ),
          },
        },
      );

      return {
        ok: true,
        ordersChecked,
        ...counts,
      };
    } catch (error) {
      const known = [
        "WORKER_LEASE_LOST",
        "ORDER_EVENT_QUEUE_UNAVAILABLE",
      ];

      const code =
        known.includes(
          error.code,
        )
          ? error.code
          : "MARKETING_WORKER_UNAVAILABLE";

      await Config.updateOne(
        {
          _id: "meta",
        },
        {
          $set: {
            lastWorkerAt:
              new Date(),

            lastWorkerError:
              code,
          },
        },
      ).catch(() => {});

      return {
        ok: false,
        code,
        ...counts,
      };
    } finally {
      if (locked) {
        await Checkpoint.updateOne(
          {
            _id: LOCK,
            owner,
          },
          {
            $set: {
              owner: "",

              leaseUntil:
                new Date(0),
            },
          },
        ).catch(() => {});
      }

      running = false;
    }
  }

  function start() {
    if (timer) {
      return;
    }

    stopped = false;

    timer =
      setInterval(() => {
        void runOnce();
      }, 5000);

    timer.unref?.();

    void runOnce();
  }

  function stop() {
    stopped = true;

    activeRequest?.abort();

    if (timer) {
      clearInterval(timer);
    }

    timer = null;
  }

  return {
    start,
    stop,
    runOnce,
  };
}

const worker =
  createMarketingWorker();

module.exports = {
  MAX_ATTEMPTS,
  RETRY_WINDOW,
  retryDelay,
  outgoingEvent,
  createMarketingWorker,

  startMarketingWorker:
    worker.start,

  stopMarketingWorker:
    worker.stop,

  runMarketingCycle:
    worker.runOnce,
};