"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCourierUrl,
  parseTrackingExtras,
  applyTrackingExtras,
} = require("../utils/trackingUpdates");

const Order = require("../models/Order");

test(
  "courier URLs accept public HTTPS links, normalize them and allow clearing",
  () => {
    assert.equal(
      normalizeCourierUrl(
        " HTTPS://www.delhivery.com/track/package/ABC ",
      ),
      "https://www.delhivery.com/track/package/ABC",
    );

    assert.equal(
      normalizeCourierUrl(""),
      "",
    );

    assert.equal(
      normalizeCourierUrl(null),
      "",
    );

    const unsafeLinks = [
      "javascript:alert(1)",
      "http://www.delhivery.com/track",
      "https://user:pass@www.delhivery.com/track",
      "https://127.0.0.1/track",
      "https://localhost/track",
      "https://private.internal/track",
      "https://[::1]/track",
      "https://www.delhivery.com:8443/track",
      "https://www.delhivery.com/a b",
      "https://www.delhivery.com\\@other.com/track",
    ];

    for (const value of unsafeLinks) {
      assert.throws(
        () => normalizeCourierUrl(value),

        (error) =>
          error.status === 400 &&
          error.gymdrobe === true,
      );
    }
  },
);

test(
  "ordinary order courier-link validation works for blank and populated fields",
  async () => {
    const field =
      Order.schema.path("tracking.courierUrl");

    for (const value of [
      "",
      "https://www.delhivery.com/track/package/ABC",
    ]) {
      await field.doValidate(value, {});
    }
  },
);

test(
  "tracking updates preserve omitted fields and require useful delivery notices",
  () => {
    assert.deepEqual(
      parseTrackingExtras({
        status: "processing",
      }),
      {},
    );

    assert.deepEqual(
      parseTrackingExtras({
        courierUrl: "",
      }),
      {
        courierUrl: "",
      },
    );

    assert.deepEqual(
      parseTrackingExtras({
        trackingNotice: "delayed",
        trackingMessage:
          "  Courier delay; next update tomorrow.  ",
      }),
      {
        exception: {
          type: "delayed",
          message:
            "Courier delay; next update tomorrow.",
        },
      },
    );

    const invalidInputs = [
      null,
      [],
      {
        trackingNotice: "unknown",
      },
      {
        trackingNotice: "delayed",
        trackingMessage: "",
      },
      {
        trackingNotice: "none",
        trackingMessage: "a".repeat(501),
      },
      {
        trackingMessage:
          "Missing notice type",
      },
    ];

    for (const body of invalidInputs) {
      assert.throws(
        () => parseTrackingExtras(body),
      );
    }
  },
);

test(
  "identical saves keep their actual timestamp; resolving a notice clears its message",
  () => {
    const first = new Date(
      "2026-01-01T10:00:00Z",
    );

    const second = new Date(
      "2026-01-02T10:00:00Z",
    );

    const tracking = {
      carrier: "Courier",
      courierUrl: "",

      exception: {
        type: "none",
        message: "",
        updatedAt: null,
      },
    };

    const delay = parseTrackingExtras({
      trackingNotice: "delayed",
      trackingMessage: "Weather delay",
    });

    assert.equal(
      applyTrackingExtras(
        tracking,
        delay,
        first,
      ),
      true,
    );

    assert.equal(
      tracking.exception.updatedAt,
      first,
    );

    assert.equal(
      applyTrackingExtras(
        tracking,
        delay,
        second,
      ),
      false,
    );

    assert.equal(
      tracking.exception.updatedAt,
      first,
    );

    assert.equal(
      applyTrackingExtras(
        tracking,

        parseTrackingExtras({
          trackingNotice: "none",
          trackingMessage: "Stale text",
        }),

        second,
      ),
      true,
    );

    assert.equal(
      tracking.exception.message,
      "",
    );

    assert.equal(
      tracking.carrier,
      "Courier",
    );
  },
);