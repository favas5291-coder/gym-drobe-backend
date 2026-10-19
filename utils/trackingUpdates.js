"use strict";

const NOTICES = [
  "none",
  "delayed",
  "delivery-attempt-failed",
];

const own = (value, key) =>
  Object.prototype.hasOwnProperty.call(value, key);

function invalid(message) {
  return Object.assign(new Error(message), {
    status: 400,
    code: "INVALID_TRACKING_INPUT",
    gymdrobe: true,
  });
}

function normalizeCourierUrl(value) {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    throw invalid(
      "Enter a valid HTTPS courier tracking link.",
    );
  }

  const input = value.trim();

  if (!input) {
    return "";
  }

  if (
    input.length > 2000 ||
    /[\u0000-\u0020\u007f\\]/.test(input)
  ) {
    throw invalid(
      "Use a courier link without spaces or backslashes.",
    );
  }

  let url;

  try {
    url = new URL(input);
  } catch {
    throw invalid(
      "Enter a valid HTTPS courier tracking link.",
    );
  }

  const publicHostname =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

  const restrictedHostname =
    /\.(?:localhost|local|internal|lan|test|invalid|example|onion)$/i;

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !publicHostname.test(url.hostname) ||
    restrictedHostname.test(url.hostname) ||
    url.href.length > 2000
  ) {
    throw invalid(
      "Use an HTTPS tracking link on a public courier website.",
    );
  }

  return url.href;
}

function parseTrackingExtras(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw invalid(
      "Send tracking details as an object.",
    );
  }

  const result = {};

  if (own(body, "courierUrl")) {
    result.courierUrl =
      normalizeCourierUrl(body.courierUrl);
  }

  if (
    own(body, "trackingNotice") ||
    own(body, "trackingMessage")
  ) {
    if (!NOTICES.includes(body.trackingNotice)) {
      throw invalid(
        "Choose no delivery notice, delayed, or failed delivery attempt.",
      );
    }

    const message = body.trackingMessage ?? "";

    if (
      typeof message !== "string" ||
      message.trim().length > 500 ||
      /[\u0000-\u001f\u007f]/.test(message)
    ) {
      throw invalid(
        "Use a delivery message of at most 500 characters without unsupported characters.",
      );
    }

    if (
      body.trackingNotice !== "none" &&
      !message.trim()
    ) {
      throw invalid(
        "Explain the delay or failed delivery attempt for the customer.",
      );
    }

    result.exception = {
      type: body.trackingNotice,

      message:
        body.trackingNotice === "none"
          ? ""
          : message.trim(),
    };
  }

  return result;
}

function applyTrackingExtras(
  target,
  extras,
  now = new Date(),
) {
  if (
    !target ||
    typeof target !== "object" ||
    !extras ||
    typeof extras !== "object"
  ) {
    throw invalid(
      "Load the saved tracking details before updating them.",
    );
  }

  let changed = false;

  if (
    own(extras, "courierUrl") &&
    (target.courierUrl || "") !== extras.courierUrl
  ) {
    target.courierUrl =
      normalizeCourierUrl(extras.courierUrl);

    changed = true;
  }

  if (
    extras.exception &&
    (
      (target.exception?.type || "none") !==
        extras.exception.type ||
      (target.exception?.message || "") !==
        extras.exception.message
    )
  ) {
    target.exception = {
      ...extras.exception,
      updatedAt: now,
    };

    changed = true;
  }

  return changed;
}

module.exports = {
  normalizeCourierUrl,
  parseTrackingExtras,
  applyTrackingExtras,
};