"use strict";

const crypto = require("node:crypto");

const Product = require("../../models/Product");

const {
  Config,
  Checkpoint,
  FeedChunk,
} = require("../../models/MarketingStore");

const {
  getConfig,
  ready,
} = require("./config");

const {
  text,
  objectId,
  fromPaise,
  catalogVariants,
  productAdvertisingIssues,
  publicHttpsUrl,
} = require("./rules");

const REFRESH_INTERVAL = 15 * 60000;
const MAX_FEED_AGE = 60 * 60000;

const MAX_ROWS = 50000;
const MAX_PRODUCTS = 25000;

const MAX_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;

const LOCK_ID = "meta-catalog-refresh";

const FEED_FIELDS = Object.freeze([
  "id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "link",
  "image_link",
  "brand",
  "item_group_id",
  "size",
  "color",
  "material",
  "gtin",
  "mpn",
]);

// No supplier, sourcing URL, purchase cost
// or customer information is selected.
const PRODUCT_FIELDS = [
  "_id",
  "name",
  "description",
  "category",
  "subcategory",
  "brand",
  "price",
  "discount",
  "sizes",
  "colors",
  "optionLabels",
  "variants",
  "stock",
  "image",
  "images",
  "colorImages",
  "material",
  "tags",
  "highlights",
  "whatsIncluded",
  "isActive",
  "+metaMarketing",
].join(" ");

function failure(code) {
  return Object.assign(
    new Error(code),
    { code },
  );
}

function csvLine(values) {
  return (
    values
      .map(
        (value) =>
          `"${String(value ?? "").replace(
            /"/g,
            '""',
          )}"`,
      )
      .join(",") + "\r\n"
  );
}

function validGtin(value) {
  if (
    typeof value !== "string" ||
    !/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(
      value,
    )
  ) {
    return false;
  }

  let sum = 0;

  for (
    let i = value.length - 2,
      weight = 3;
    i >= 0;
    i--,
      weight = weight === 3 ? 1 : 3
  ) {
    sum += Number(value[i]) * weight;
  }

  return (
    (10 - (sum % 10)) % 10 ===
    Number(value.at(-1))
  );
}

function catalogRows(product) {
  const issues =
    productAdvertisingIssues(product);

  if (issues.length) {
    return {
      rows: [],
      issues,
    };
  }

  const variants =
    catalogVariants(product);

  const policy =
    product.metaMarketing;

  const sizeLabel =
    text(
      product.optionLabels?.size,
      30,
    ) || "Size";

  const colorLabel =
    text(
      product.optionLabels?.color,
      30,
    ) || "Colour";

  const identifiers = Array.isArray(
    policy.variantIdentifiers,
  )
    ? policy.variantIdentifiers
    : [];

  const rows = variants.map(
    (variant) => {
      // Never reuse a parent barcode across
      // several distinct product variants.
      const identifier =
        variant.size == null &&
        variant.color == null
          ? policy
          : identifiers.find(
              (row) =>
                row &&
                (row.size ?? null) ===
                  variant.size &&
                (row.color ?? null) ===
                  variant.color,
            ) || {};

      const gtin =
        typeof identifier.gtin ===
        "string"
          ? identifier.gtin.trim()
          : "";

      const mpn =
        typeof identifier.mpn ===
        "string"
          ? identifier.mpn.trim()
          : "";

      if (
        gtin &&
        !validGtin(gtin)
      ) {
        issues.push(
          "An invalid optional GTIN was omitted.",
        );
      }

      if (
        mpn &&
        (
          mpn.length > 100 ||
          /[\u0000-\u001f\u007f]/.test(
            mpn,
          )
        )
      ) {
        issues.push(
          "An invalid optional manufacturer part number was omitted.",
        );
      }

      const labels = [
        variant.color == null
          ? ""
          : `${colorLabel}: ${variant.color}`,

        variant.size == null
          ? ""
          : `${sizeLabel}: ${variant.size}`,
      ].filter(Boolean);

      return {
        id: variant.id,

        title: text(
          [
            product.name,
            ...labels,
          ].join(" · "),
          200,
        ),

        description: text(
          product.description,
          5000,
        ),

        availability:
          variant.availability,

        condition:
          policy.condition,

        price:
          `${fromPaise(
            variant.pricePaise,
          ).toFixed(2)} INR`,

        link: variant.link,

        image_link:
          variant.image_link,

        brand: text(
          product.brand,
          100,
        ),

        item_group_id:
          variant.item_group_id,

        size:
          sizeLabel === "Size"
            ? variant.size || ""
            : "",

        color:
          colorLabel === "Colour"
            ? variant.color || ""
            : "",

        material:
          colorLabel === "Material"
            ? variant.color || ""
            : text(
                product.material,
                200,
              ),

        gtin: validGtin(gtin)
          ? gtin
          : "",

        mpn:
          mpn.length <= 100 &&
          !/[\u0000-\u001f\u007f]/.test(
            mpn,
          )
            ? mpn
            : "",
      };
    },
  );

  return {
    rows,
    issues: [...new Set(issues)],
  };
}

function sameScope(first, second) {
  return (
    first.datasetId ===
      second.datasetId &&
    first.epoch === second.epoch &&
    (first.testMode !== false) ===
      (second.testMode !== false)
  );
}

async function acquireLease(owner) {
  try {
    await Checkpoint.updateOne(
      {
        _id: LOCK_ID,
      },
      {
        $setOnInsert: {
          owner: "",
          leaseUntil: new Date(0),
        },
      },
      {
        upsert: true,
      },
    );
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
  }

  return Checkpoint.findOneAndUpdate(
    {
      _id: LOCK_ID,

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

        leaseUntil: new Date(
          Date.now() + 60000,
        ),
      },
    },
    {
      new: true,
    },
  ).lean();
}

async function renewLease(owner) {
  const result =
    await Checkpoint.updateOne(
      {
        _id: LOCK_ID,
        owner,

        leaseUntil: {
          $gt: new Date(),
        },
      },
      {
        $set: {
          leaseUntil: new Date(
            Date.now() + 60000,
          ),
        },
      },
    );

  if (result.matchedCount !== 1) {
    throw failure(
      "CATALOG_LEASE_LOST",
    );
  }
}

async function refreshFeed(
  { force = false } = {},
) {
  const version =
    crypto.randomUUID();

  const owner =
    crypto.randomUUID();

  let locked = false;
  let config;
  let published = false;
  let publicationAttempted = false;

  try {
    config = await getConfig();

    if (!ready(config, "feed")) {
      return {
        ok: false,
        code: "CATALOG_DISABLED",
      };
    }

    if (
      !force &&
      new Date(
        config.feed?.refreshAfter || 0,
      ).getTime() > Date.now()
    ) {
      return {
        ok: true,
        skipped: true,
      };
    }

    locked = Boolean(
      await acquireLease(owner),
    );

    if (!locked) {
      return {
        ok: true,
        skipped: true,

        code:
          "CATALOG_REFRESH_BUSY",
      };
    }

    config = await getConfig();

    if (!ready(config, "feed")) {
      return {
        ok: false,
        code: "CATALOG_DISABLED",
      };
    }

    if (
      !force &&
      new Date(
        config.feed?.refreshAfter || 0,
      ).getTime() > Date.now()
    ) {
      return {
        ok: true,
        skipped: true,
      };
    }

    const startedAt = new Date();

    const expiresAt = new Date(
      Date.now() + 2 * 86400000,
    );

    const digest =
      crypto.createHash("sha256");

    const seen = new Set();

    const validationIssues = [];

    let issueCount = 0;
    let scanned = 0;
    let included = 0;
    let rowCount = 0;
    let bytes = 0;
    let ordinal = 0;
    let lastId = null;
    let pending = "";
    let pendingBytes = 0;

    async function flush() {
      if (!pending) {
        return;
      }

      await FeedChunk.create({
        version,
        ordinal,
        data: pending,
        expiresAt,
      });

      ordinal++;
      pending = "";
      pendingBytes = 0;
    }

    async function append(line) {
      const size =
        Buffer.byteLength(
          line,
          "utf8",
        );

      if (
        size > CHUNK_BYTES ||
        bytes + size > MAX_BYTES
      ) {
        throw failure(
          "CATALOG_SIZE_LIMIT",
        );
      }

      if (
        pendingBytes + size >
        CHUNK_BYTES
      ) {
        await flush();
      }

      pending += line;
      pendingBytes += size;
      bytes += size;

      digest.update(line, "utf8");
    }

    await append(
      csvLine(FEED_FIELDS),
    );

    while (true) {
      if (
        Date.now() -
          startedAt.getTime() >
        5 * 60000
      ) {
        throw failure(
          "CATALOG_BUILD_TIMEOUT",
        );
      }

      await renewLease(owner);

      const current =
        await getConfig();

      if (
        !ready(current, "feed") ||
        !sameScope(
          config,
          current,
        ) ||
        current.revision !==
          config.revision
      ) {
        throw failure(
          "CATALOG_CONFIGURATION_CHANGED",
        );
      }

      const products =
        await Product.find({
          isActive: true,

          ...(lastId
            ? {
                _id: {
                  $gt: lastId,
                },
              }
            : {}),
        })
          .select(PRODUCT_FIELDS)
          .sort({
            _id: 1,
          })
          .limit(100)
          .read("primary")
          .maxTimeMS(5000)
          .lean();

      if (!products.length) {
        break;
      }

      for (
        const product of products
      ) {
        if (
          ++scanned > MAX_PRODUCTS
        ) {
          throw failure(
            "CATALOG_PRODUCT_LIMIT",
          );
        }

        const result =
          catalogRows(product);

        if (
          result.issues.length
        ) {
          issueCount +=
            result.issues.length;

          if (
            validationIssues.length <
            100
          ) {
            validationIssues.push({
              productId:
                objectId(product),

              name: text(
                product.name,
                200,
              ),

              issues:
                result.issues,
            });
          }
        }

        if (result.rows.length) {
          included++;
        }

        for (
          const row of result.rows
        ) {
          if (
            ++rowCount > MAX_ROWS
          ) {
            throw failure(
              "CATALOG_ROW_LIMIT",
            );
          }

          if (
            seen.has(row.id)
          ) {
            throw failure(
              "CATALOG_DUPLICATE_ID",
            );
          }

          seen.add(row.id);

          await append(
            csvLine(
              FEED_FIELDS.map(
                (field) =>
                  row[field],
              ),
            ),
          );
        }
      }

      lastId =
        products.at(-1)._id;
    }

    await flush();
    await renewLease(owner);

    const generatedAt =
      new Date();

    const feed = {
      version,

      epoch: config.epoch,

      datasetId:
        config.datasetId,

      testMode:
        config.testMode !== false,

      startedAt,
      generatedAt,

      refreshAfter: new Date(
        Date.now() +
          REFRESH_INTERVAL,
      ),

      rowCount,

      scannedProducts:
        scanned,

      includedProducts:
        included,

      excludedProducts:
        scanned - included,

      chunkCount: ordinal,
      bytes,

      sha256:
        digest.digest("hex"),

      validationIssueCount:
        issueCount,

      validationIssues,

      imageChecks:
        "url-validation-only",

      metaVerification:
        "not-verified",

      lastError: "",

      lastAttemptAt:
        generatedAt,
    };

    // Publish only after every chunk
    // has been durably written.
    publicationAttempted = true;

    const result =
      await Config.updateOne(
        {
          _id: "meta",

          revision:
            config.revision,

          epoch:
            config.epoch,

          enabled: true,
          feedEnabled: true,
          policiesReviewed: true,

          "feed.version":
            config.feed?.version ??
            {
              $exists: false,
            },
        },
        {
          $set: {
            feed,
          },
        },
      );

    if (
      result.modifiedCount !== 1
    ) {
      publicationAttempted = false;

      throw failure(
        "CATALOG_CONFIGURATION_CHANGED",
      );
    }

    published = true;

    return {
      ok: true,
      rowCount,

      includedProducts:
        included,

      validationIssueCount:
        issueCount,
    };
  } catch (error) {
    const allowed = [
      "CATALOG_LEASE_LOST",
      "CATALOG_SIZE_LIMIT",
      "CATALOG_ROW_LIMIT",
      "CATALOG_PRODUCT_LIMIT",
      "CATALOG_DUPLICATE_ID",
      "CATALOG_BUILD_TIMEOUT",
      "CATALOG_CONFIGURATION_CHANGED",
    ];

    const code =
      allowed.includes(error.code)
        ? error.code
        : "CATALOG_BUILD_UNAVAILABLE";

    if (config) {
      await Config.updateOne(
        {
          _id: "meta",

          revision:
            config.revision,

          epoch:
            config.epoch,
        },
        {
          $set: {
            "feed.lastError":
              code,

            "feed.lastAttemptAt":
              new Date(),
          },
        },
      ).catch(() => {});
    }

    return {
      ok: false,
      code,
    };
  } finally {
    // A lost database response might follow
    // a successful publication. Preserve
    // those chunks until TTL cleanup.
    if (
      locked &&
      !published &&
      !publicationAttempted
    ) {
      await FeedChunk.deleteMany({
        version,
      }).catch(() => {});
    }

    if (locked) {
      await Checkpoint.updateOne(
        {
          _id: LOCK_ID,
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
  }
}

function feedAvailable(config) {
  const feed = config.feed;

  const generated = new Date(
    feed?.generatedAt || 0,
  ).getTime();

  return (
    ready(config, "feed") &&
    feed &&
    sameScope(feed, config) &&
    typeof feed.version === "string" &&
    /^[a-f0-9-]{36}$/i.test(
      feed.version,
    ) &&
    Number.isFinite(generated) &&
    generated <= Date.now() &&
    Date.now() - generated <=
      MAX_FEED_AGE &&
    Number.isSafeInteger(
      feed.chunkCount,
    ) &&
    feed.chunkCount > 0 &&
    feed.chunkCount <= 256 &&
    Number.isSafeInteger(
      feed.bytes,
    ) &&
    feed.bytes > 0 &&
    feed.bytes <= MAX_BYTES &&
    /^[a-f0-9]{64}$/.test(
      feed.sha256 || "",
    )
  );
}

async function waitForDrain(res) {
  await new Promise(
    (resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);

        res.off(
          "drain",
          drained,
        );

        res.off(
          "close",
          closed,
        );

        res.off(
          "error",
          closed,
        );
      };

      const drained = () => {
        cleanup();
        resolve();
      };

      const closed = () => {
        cleanup();

        reject(
          failure(
            "CATALOG_DOWNLOAD_INTERRUPTED",
          ),
        );
      };

      const timer =
        setTimeout(
          closed,
          30000,
        );

      res.once(
        "drain",
        drained,
      );

      res.once(
        "close",
        closed,
      );

      res.once(
        "error",
        closed,
      );
    },
  );
}

async function serveFeed(req, res) {
  res.set(
    "Cache-Control",
    "no-store",
  );

  try {
    const config =
      await getConfig();

    if (
      !feedAvailable(config)
    ) {
      throw failure(
        "CATALOG_NOT_READY",
      );
    }

    const feed = config.feed;

    const metadata =
      await FeedChunk.find({
        version:
          feed.version,

        expiresAt: {
          $gt: new Date(),
        },
      })
        .select("ordinal -_id")
        .sort({
          ordinal: 1,
        })
        .read("primary")
        .maxTimeMS(5000)
        .lean();

    if (
      metadata.length !==
        feed.chunkCount ||
      metadata.some(
        (row, index) =>
          row.ordinal !== index,
      )
    ) {
      throw failure(
        "CATALOG_INCOMPLETE",
      );
    }

    res.set(
      "Content-Type",
      "text/csv; charset=utf-8",
    );

    res.set(
      "Content-Length",
      String(feed.bytes),
    );

    res.set(
      "X-Content-Type-Options",
      "nosniff",
    );

    res.set(
      "ETag",
      `"${feed.sha256}"`,
    );

    const digest =
      crypto.createHash(
        "sha256",
      );

    let bytes = 0;

    for (
      let start = 0;
      start < feed.chunkCount;
      start += 8
    ) {
      const current =
        await getConfig();

      if (
        !ready(current, "feed") ||
        !sameScope(
          config,
          current,
        )
      ) {
        throw failure(
          "CATALOG_DISABLED",
        );
      }

      const count = Math.min(
        8,
        feed.chunkCount - start,
      );

      const chunks =
        await FeedChunk.find({
          version:
            feed.version,

          ordinal: {
            $gte: start,
            $lt: start + count,
          },

          expiresAt: {
            $gt: new Date(),
          },
        })
          .sort({
            ordinal: 1,
          })
          .read("primary")
          .maxTimeMS(5000)
          .lean();

      if (
        chunks.length !== count
      ) {
        throw failure(
          "CATALOG_INCOMPLETE",
        );
      }

      for (
        let i = 0;
        i < chunks.length;
        i++
      ) {
        const chunk =
          chunks[i];

        if (
          chunk.ordinal !==
            start + i ||
          typeof chunk.data !==
            "string" ||
          res.destroyed
        ) {
          throw failure(
            "CATALOG_DOWNLOAD_INTERRUPTED",
          );
        }

        bytes +=
          Buffer.byteLength(
            chunk.data,
            "utf8",
          );

        digest.update(
          chunk.data,
          "utf8",
        );

        if (
          bytes > feed.bytes
        ) {
          throw failure(
            "CATALOG_CHECKSUM_MISMATCH",
          );
        }

        if (
          chunk.ordinal ===
            feed.chunkCount - 1 &&
          (
            bytes !== feed.bytes ||
            digest.digest("hex") !==
              feed.sha256
          )
        ) {
          throw failure(
            "CATALOG_CHECKSUM_MISMATCH",
          );
        }

        if (
          !res.write(chunk.data)
        ) {
          await waitForDrain(res);
        }
      }
    }

    res.end();
  } catch {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    res.removeHeader(
      "Content-Length",
    );

    res.removeHeader(
      "Content-Type",
    );

    res.removeHeader(
      "ETag",
    );

    res.set(
      "Retry-After",
      "60",
    );

    res.status(503).json({
      success: false,

      code:
        "CATALOG_NOT_READY",

      message:
        "The product catalogue is temporarily unavailable. Please retry later.",
    });
  }
}

function catalogFeedUrl() {
  const input = String(
    process.env.PUBLIC_API_URL ||
      "",
  ).trim();

  const safe =
    publicHttpsUrl(input);

  if (!safe) {
    return "";
  }

  const url =
    new URL(safe);

  if (
    url.search ||
    ![
      "/",
      "/api",
      "/api/",
    ].includes(url.pathname)
  ) {
    return "";
  }

  url.pathname =
    "/api/marketing/catalog.csv";

  return url.href;
}

module.exports = {
  FEED_FIELDS,
  REFRESH_INTERVAL,
  MAX_FEED_AGE,

  csvLine,
  validGtin,
  catalogRows,
  sameScope,

  refreshFeed,
  feedAvailable,
  serveFeed,
  catalogFeedUrl,
};