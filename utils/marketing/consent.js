"use strict";

const crypto = require("node:crypto");
const { isIP } = require("node:net");

const {
  Consent,
  Event,
} = require("../../models/MarketingStore");

const Order = require("../../models/Order");

const {
  consentSubject,
} = require("./events");

const {
  siteOrigin,
} = require("./rules");

const DAY = 86400000;

const CONSENT_RETENTION_DAYS = 180;
const ATTRIBUTION_RETENTION_DAYS = 30;
const IDENTIFIER_RETENTION_DAYS = 90;

const CAMPAIGN_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
];

const PRIVATE_FIELDS = [
  "firstTouch",
  "lastTouch",
  "fbc",
  "fbp",
  "fbcExpiresAt",
  "fbpExpiresAt",
  "agent",
  "clientIP",
];

function invalid(
  message,
  code = "INVALID_MARKETING_PREFERENCE",
  status = 400,
) {
  return Object.assign(
    new Error(message),
    {
      code,
      status,
      marketing: true,
    },
  );
}

function plain(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [
      Object.prototype,
      null,
    ].includes(
      Object.getPrototypeOf(value),
    )
  );
}

function assertFirstParty(
  req,
  readOnly = false,
) {
  const input =
    req.get?.("Origin") ||
    req.headers?.origin;

  // Same-origin GET requests may omit Origin.
  // Reading a saved choice still requires its
  // random preference bearer.
  // Writes always require an allowed Origin.
  if (!input && readOnly) {
    return;
  }

  const allowed = new Set([
    siteOrigin(),
  ]);

  const site = new URL(siteOrigin());

  if (
    site.hostname === "gymdrobe.com" ||
    site.hostname === "www.gymdrobe.com"
  ) {
    allowed.add(
      "https://gymdrobe.com",
    );

    allowed.add(
      "https://www.gymdrobe.com",
    );
  }

  const configuredOrigins = String(
    process.env.MARKETING_ALLOWED_ORIGINS || "",
  ).split(",");

  for (const candidate of configuredOrigins) {
    try {
      const url = new URL(
        candidate.trim(),
      );

      const local = [
        "localhost",
        "127.0.0.1",
        "[::1]",
      ].includes(url.hostname);

      if (
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        (
          url.protocol === "https:" ||
          (
            process.env.NODE_ENV !== "production" &&
            local &&
            url.protocol === "http:"
          )
        )
      ) {
        allowed.add(url.origin);
      }
    } catch {
      // Ignore invalid configuration.
    }
  }

  if (
    typeof input !== "string" ||
    !allowed.has(input)
  ) {
    throw invalid(
      "Save preferences from the GymDrobe website.",
      "MARKETING_ORIGIN_DENIED",
      403,
    );
  }
}

function subjectFor(req) {
  const value =
    req.get?.("X-GymDrobe-Marketing") ||
    req.headers?.["x-gymdrobe-marketing"] ||
    "";

  if (!value) {
    return "";
  }

  if (
    typeof value !== "string" ||
    !/^mkt_[a-f0-9]{64}$/.test(value)
  ) {
    throw invalid(
      "Your preference session is invalid. Reopen preferences.",
    );
  }

  return consentSubject(req);
}

function validatePreference(body) {
  if (
    !plain(body) ||
    Object.keys(body).some(
      (key) =>
        ![
          "advertising",
          "matching",
          "version",
          "attribution",
        ].includes(key),
    )
  ) {
    throw invalid(
      "Check the advertising preference fields.",
    );
  }

  if (
    typeof body.advertising !== "boolean" ||
    typeof body.matching !== "boolean" ||
    (
      !body.advertising &&
      body.matching
    )
  ) {
    throw invalid(
      "Choose advertising and optional contact matching separately.",
    );
  }

  if (
    body.version !== undefined &&
    (
      !Number.isSafeInteger(body.version) ||
      body.version < 1
    )
  ) {
    throw invalid(
      "Reload the current advertising preference before saving.",
    );
  }

  if (
    body.attribution !== undefined &&
    !plain(body.attribution)
  ) {
    throw invalid(
      "Campaign information must be an object.",
    );
  }

  return {
    advertising: body.advertising,
    matching: body.matching,
    version: body.version,
    attribution: body.attribution,
  };
}

function cleanAttribution(
  value,
  now = Date.now(),
) {
  const result = {
    campaign: {},
    identifiers: {},
  };

  if (!plain(value)) {
    return result;
  }

  for (const key of CAMPAIGN_FIELDS) {
    const raw = value[key];

    if (
      typeof raw !== "string" ||
      raw.length > 120
    ) {
      continue;
    }

    const text = raw.trim();

    // Accept campaign labels, never a URL,
    // email, HTML or complete query string.
    if (
      text &&
      /^[A-Za-z0-9][A-Za-z0-9 ._~:+-]*$/.test(
        text,
      ) &&
      !/https?:|www\.|\b(?:gco_|mkt_|rzp_(?:live|test)_|bearer\b)/i.test(
        text,
      )
    ) {
      result.campaign[key] = text;
    }
  }

  if (
    typeof value.fbclid === "string" &&
    /^[A-Za-z0-9_-]{10,500}$/.test(
      value.fbclid,
    )
  ) {
    result.campaign.fbclid =
      value.fbclid;
  }

  for (const key of ["fbc", "fbp"]) {
    const raw = value[key];

    if (
      typeof raw !== "string" ||
      raw.length > 600
    ) {
      continue;
    }

    const match =
      /^fb\.[0-9]+\.(\d{13})\.([A-Za-z0-9_-]+)$/.exec(
        raw,
      );

    if (!match) {
      continue;
    }

    const createdAt = Number(match[1]);

    const expiresAt =
      createdAt +
      IDENTIFIER_RETENTION_DAYS * DAY;

    if (
      createdAt > now + 300000 ||
      expiresAt <= now ||
      (
        key === "fbp" &&
        !/^\d{1,30}$/.test(match[2])
      ) ||
      (
        key === "fbc" &&
        result.campaign.fbclid &&
        match[2] !== result.campaign.fbclid
      )
    ) {
      continue;
    }

    // These identifiers come from actual
    // browser values. None are generated here.
    result.identifiers[key] = raw;

    result.identifiers[
      `${key}ExpiresAt`
    ] = new Date(expiresAt);
  }

  return result;
}

function metadata(
  row,
  input,
  req,
  expiresAt,
  now,
) {
  const result = {};

  const agent =
    req.get?.("User-Agent") ||
    req.headers?.["user-agent"];

  if (
    typeof agent === "string" &&
    agent.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(agent)
  ) {
    result.agent = agent;
  }

  // req.ip relies on Express's trusted-proxy
  // configuration. Never read an arbitrary
  // X-Forwarded-For header or accept a
  // browser-submitted IP address.
  const ip =
    typeof req.ip === "string"
      ? req.ip.replace(/^::ffff:/, "")
      : "";

  if (isIP(ip)) {
    result.clientIP = ip;
  }

  const cleaned = cleanAttribution(
    input,
    now,
  );

  for (const key of ["fbc", "fbp"]) {
    if (cleaned.identifiers[key]) {
      result[key] =
        cleaned.identifiers[key];

      result[
        `${key}ExpiresAt`
      ] = new Date(
        Math.min(
          +cleaned.identifiers[
            `${key}ExpiresAt`
          ],
          +expiresAt,
        ),
      );
    }
  }

  if (
    Object.keys(cleaned.campaign).length
  ) {
    const touch = {
      ...cleaned.campaign,
      capturedAt: new Date(now),

      expiresAt: new Date(
        Math.min(
          now +
            ATTRIBUTION_RETENTION_DAYS * DAY,
          +expiresAt,
        ),
      ),
    };

    const alive = (value) =>
      value &&
      new Date(
        value.expiresAt,
      ).getTime() > now;

    const signature = (value) =>
      JSON.stringify(
        [
          ...CAMPAIGN_FIELDS,
          "fbclid",
        ].map(
          (key) => value?.[key] || "",
        ),
      );

    if (!alive(row?.firstTouch)) {
      result.firstTouch = touch;
    }

    if (
      !alive(row?.lastTouch) ||
      signature(row.lastTouch) !==
        signature(touch)
    ) {
      result.lastTouch = touch;
    }
  }

  return result;
}

function preferenceView(row) {
  const active = Boolean(
    row &&
    new Date(
      row.expiresAt,
    ).getTime() > Date.now(),
  );

  return {
    choiceRecorded: active,

    advertising:
      active &&
      row.granted === true,

    matching:
      active &&
      row.granted === true &&
      row.matching === true,

    version:
      active ? row.version : 0,

    preferenceTime:
      active
        ? row.preferenceTime || null
        : null,

    expiresAt:
      active ? row.expiresAt : null,

    retentionDays: {
      preference:
        CONSENT_RETENTION_DAYS,

      attribution:
        ATTRIBUTION_RETENTION_DAYS,

      identifiersMaximum:
        IDENTIFIER_RETENTION_DAYS,
    },
  };
}

async function readPreference(subject) {
  if (Consent.db.readyState !== 1) {
    throw new Error(
      "PREFERENCE_DATABASE_UNAVAILABLE",
    );
  }

  return Consent.findOne({
    _id: subject,

    expiresAt: {
      $gt: new Date(),
    },
  })
    .read("primary")
    .maxTimeMS(2000)
    .lean();
}

async function purgeEarlierVersions(
  subject,
  version,
) {
  const filter = {
    subject,

    consentVersion: {
      $lt: version,
    },
  };

  // The saved consent version is the immediate
  // delivery gate. Cleanup may be retried; it
  // cannot grant permission or restore data.
  try {
    await Event.updateMany(
      {
        ...filter,

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
          state: "suppressed",
          suppression:
            "PREFERENCE_CHANGED",
        },

        $unset: {
          payload: 1,
          userData: 1,
          leaseUntil: 1,
        },
      },
      {
        maxTimeMS: 2000,
      },
    );

    await Event.updateMany(
      filter,
      {
        $unset: {
          payload: 1,
          userData: 1,
        },
      },
      {
        maxTimeMS: 2000,
      },
    );

    // Preserve financial records and their
    // timestamps; remove old attribution only.
    await Order.collection.updateMany(
      {
        "marketing.subject": subject,

        "marketing.consentVersion": {
          $lt: version,
        },
      },
      {
        $unset: {
          "marketing.attribution": 1,
        },
      },
      {
        maxTimeMS: 2000,
      },
    );

    return true;
  } catch {
    return false;
  }
}

function noStore(res) {
  res.set(
    "Cache-Control",
    "no-store",
  );

  res.set(
    "Pragma",
    "no-cache",
  );
}

function failure(res, error) {
  return res.status(
    error.marketing
      ? error.status
      : 503,
  ).json({
    success: false,

    code: error.marketing
      ? error.code
      : "MARKETING_PREFERENCE_UNAVAILABLE",

    message: error.marketing
      ? error.message
      : "Your preference could not be confirmed. Optional advertising stays off in this browser until you retry. Shopping is still available.",
  });
}

async function getPreference(req, res) {
  noStore(res);

  try {
    assertFirstParty(req, true);

    const subject = subjectFor(req);

    const row = subject
      ? await readPreference(subject)
      : null;

    const cleanupPending =
      row &&
      row.granted !== true
        ? !(await purgeEarlierVersions(
            subject,
            row.version,
          ))
        : false;

    return res.json({
      success: true,

      preference:
        preferenceView(row),

      cleanupPending:
        Boolean(cleanupPending),
    });
  } catch (error) {
    return failure(res, error);
  }
}

async function savePreference(req, res) {
  noStore(res);

  try {
    assertFirstParty(req);

    const input =
      validatePreference(req.body);

    const subject = subjectFor(req);

    const now = Date.now();

    const expiresAt = new Date(
      now +
        CONSENT_RETENTION_DAYS * DAY,
    );

    if (
      Consent.db.readyState !== 1
    ) {
      throw new Error(
        "PREFERENCE_DATABASE_UNAVAILABLE",
      );
    }

    if (!subject) {
      if (
        input.version !== undefined
      ) {
        throw invalid(
          "Reopen advertising preferences before saving.",
        );
      }

      const token =
        `mkt_${
          crypto
            .randomBytes(32)
            .toString("hex")
        }`;

      const id = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      const row = {
        _id: id,

        granted:
          input.advertising,

        matching:
          input.matching,

        version: 1,
        revision: 0,

        preferenceTime:
          new Date(now),

        expiresAt,

        ...(input.advertising
          ? metadata(
              null,
              input.attribution,
              req,
              expiresAt,
              now,
            )
          : {}),
      };

      const inserted =
        await Consent.updateOne(
          {
            _id: id,
          },
          {
            $setOnInsert: row,
          },
          {
            upsert: true,
            maxTimeMS: 2000,
          },
        );

      if (
        inserted.upsertedCount !== 1
      ) {
        throw new Error(
          "PREFERENCE_CREATION_UNCONFIRMED",
        );
      }

      // This random preference token is not a
      // Meta identifier or an order token.
      return res.status(201).json({
        success: true,
        token,

        preference:
          preferenceView(row),

        cleanupPending: false,
      });
    }

    for (
      let attempt = 0;
      attempt < 4;
      attempt++
    ) {
      const row =
        await readPreference(subject);

      if (!row) {
        throw invalid(
          "Your preference session expired. Reopen preferences to make a new choice.",
          "MARKETING_PREFERENCE_EXPIRED",
          409,
        );
      }

      // Withdrawals may use the latest version.
      // Grants must match the reviewed version,
      // so a delayed Allow cannot undo a newer
      // withdrawal.
      if (
        input.advertising &&
        input.version !== row.version
      ) {
        return res.status(409).json({
          success: false,

          code:
            "MARKETING_PREFERENCE_CHANGED",

          message:
            "Your preference changed in another tab. Review it before allowing advertising.",

          preference:
            preferenceView(row),
        });
      }

      const changed =
        !input.advertising ||
        row.granted !==
          input.advertising ||
        row.matching !==
          input.matching;

      const version =
        row.version +
        (changed ? 1 : 0);

      const revision =
        row.revision || 0;

      if (
        !Number.isSafeInteger(version) ||
        !Number.isSafeInteger(
          revision + 1,
        )
      ) {
        throw new Error(
          "PREFERENCE_VERSION_LIMIT",
        );
      }

      const values = {
        granted:
          input.advertising,

        matching:
          input.matching,

        version,
        revision: revision + 1,

        preferenceTime:
          new Date(now),

        expiresAt,

        ...(input.advertising
          ? metadata(
              row,
              input.attribution,
              req,
              expiresAt,
              now,
            )
          : {}),
      };

      const result =
        await Consent.updateOne(
          {
            _id: subject,
            version: row.version,
            revision,

            expiresAt: {
              $gt: new Date(),
            },
          },
          {
            $set: values,

            ...(!input.advertising
              ? {
                  $unset:
                    Object.fromEntries(
                      PRIVATE_FIELDS.map(
                        (key) => [
                          key,
                          1,
                        ],
                      ),
                    ),
                }
              : {}),
          },
          {
            maxTimeMS: 2000,
          },
        );

      if (
        result.matchedCount !== 1
      ) {
        continue;
      }

      const cleaned = changed
        ? await purgeEarlierVersions(
            subject,
            version,
          )
        : true;

      return res.json({
        success: true,

        preference:
          preferenceView({
            ...row,
            ...values,
          }),

        cleanupPending:
          !cleaned,
      });
    }

    throw invalid(
      "Your preference changed while saving. Please retry.",
      "MARKETING_PREFERENCE_CHANGED",
      409,
    );
  } catch (error) {
    return failure(res, error);
  }
}

async function captureAttribution(
  req,
  res,
) {
  noStore(res);

  try {
    assertFirstParty(req);

    if (
      !plain(req.body) ||
      Object.keys(
        req.body,
      ).some(
        (key) =>
          key !== "attribution",
      ) ||
      !plain(
        req.body.attribution,
      )
    ) {
      throw invalid(
        "Check the campaign information fields.",
      );
    }

    const subject = subjectFor(req);

    if (!subject) {
      return res.json({
        success: true,
        captured: false,
      });
    }

    let captureVersion = null;

    for (
      let attempt = 0;
      attempt < 3;
      attempt++
    ) {
      const row =
        await readPreference(subject);

      if (
        !row ||
        row.granted !== true
      ) {
        return res.json({
          success: true,
          captured: false,
        });
      }

      if (
        captureVersion !== null &&
        captureVersion !== row.version
      ) {
        return res.json({
          success: true,
          captured: false,
        });
      }

      captureVersion = row.version;

      const values = metadata(
        row,
        req.body.attribution,
        req,
        row.expiresAt,
        Date.now(),
      );

      const revision =
        row.revision || 0;

      if (
        !Number.isSafeInteger(
          revision + 1,
        )
      ) {
        throw new Error(
          "PREFERENCE_VERSION_LIMIT",
        );
      }

      const result =
        await Consent.updateOne(
          {
            _id: subject,
            granted: true,
            version: row.version,
            revision,

            expiresAt: {
              $gt: new Date(),
            },
          },
          {
            $set: values,

            $inc: {
              revision: 1,
            },
          },
          {
            maxTimeMS: 2000,
          },
        );

      if (
        result.matchedCount === 1
      ) {
        return res.json({
          success: true,
          captured: true,
        });
      }
    }

    return res.json({
      success: true,
      captured: false,
    });
  } catch (error) {
    return failure(res, error);
  }
}

module.exports = {
  CONSENT_RETENTION_DAYS,
  ATTRIBUTION_RETENTION_DAYS,
  IDENTIFIER_RETENTION_DAYS,

  validatePreference,
  cleanAttribution,
  preferenceView,

  getPreference,
  savePreference,
  captureAttribution,
};