"use strict";

const crypto = require("node:crypto");

const DAY = 86400000;

const COMMISSION_BASE =
  "net-product-sales-excluding-tax-shipping";

function problem(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    code,
  });
}

function fields(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !allowed.includes(key)
    )
  ) {
    throw problem(
      400,
      "INVALID_SUPPLIER_INPUT",
      "Check the submitted fields."
    );
  }
}

function text(value, label, max, min = 1) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  ) {
    throw problem(
      400,
      "INVALID_SUPPLIER_INPUT",
      `${label} needs ${min}–${max} characters.`
    );
  }

  return value.trim();
}

function id(value) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{24}$/i.test(value)
  ) {
    throw problem(
      400,
      "INVALID_SUPPLIER_ID",
      "Choose a valid supplier record."
    );
  }

  return value.toLowerCase();
}

function revision(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw problem(
      400,
      "SUPPLIER_REVISION_REQUIRED",
      "Reload the record before saving."
    );
  }

  return value;
}

function date(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw problem(
      400,
      "INVALID_SUPPLIER_INPUT",
      `${label} must be a valid date with a timezone.`
    );
  }

  return new Date(value).toISOString();
}

function normalizeTerms(input, now = new Date()) {
  fields(input, [
    "title",
    "text",
    "commissionBps",
    "shippingResponsibility",
    "gatewayFeeResponsibility",
    "returnResponsibility",
    "effectiveFrom",
    "offerExpiresAt",
  ]);

  if (
    !Number.isSafeInteger(input.commissionBps) ||
    input.commissionBps < 0 ||
    input.commissionBps > 10000
  ) {
    throw problem(
      400,
      "INVALID_SUPPLIER_INPUT",
      "Enter an explicit commission from 0 to 10000 basis points."
    );
  }

  for (const key of [
    "shippingResponsibility",
    "gatewayFeeResponsibility",
  ]) {
    if (
      !["supplier", "gymdrobe"].includes(input[key])
    ) {
      throw problem(
        400,
        "INVALID_SUPPLIER_INPUT",
        "Specify who pays shipping and gateway fees."
      );
    }
  }

  const effectiveFrom = date(
    input.effectiveFrom,
    "Effective date"
  );

  const offerExpiresAt = date(
    input.offerExpiresAt,
    "Offer expiry"
  );

  if (
    Date.parse(effectiveFrom) <
      now.getTime() - DAY ||
    Date.parse(effectiveFrom) >
      now.getTime() + 90 * DAY ||
    Date.parse(offerExpiresAt) <=
      now.getTime() ||
    Date.parse(offerExpiresAt) >
      now.getTime() + 30 * DAY
  ) {
    throw problem(
      400,
      "INVALID_SUPPLIER_INPUT",
      "Use a current or upcoming effective date and an offer expiry within 30 days."
    );
  }

  // Canonical order and fixed fees form part
  // of the supplier's acceptance digest.
  return {
    title: text(
      input.title,
      "Agreement title",
      150
    ),

    text: text(
      input.text,
      "Complete commercial terms",
      20000,
      20
    ),

    commissionBps: input.commissionBps,
    commissionBase: COMMISSION_BASE,

    trialDays: 90,
    joiningFeePaise: 0,
    monthlyFeePaise: 0,

    shippingResponsibility:
      input.shippingResponsibility,

    gatewayFeeResponsibility:
      input.gatewayFeeResponsibility,

    returnResponsibility: text(
      input.returnResponsibility,
      "Return responsibilities",
      2000,
      10
    ),

    effectiveFrom,
    offerExpiresAt,
  };
}

function digestTerms(terms) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(terms))
    .digest("hex");
}

function normalizeProfile(input) {
  fields(input, [
    "legalName",
    "contactName",
    "phone",
    "gstin",
    "dispatchAddress",
  ]);

  fields(input.dispatchAddress, [
    "addressLine",
    "city",
    "state",
    "pincode",
    "country",
  ]);

  const phone = text(
    input.phone,
    "Phone",
    30
  ).replace(/[\s()+-]/g, "");

  const pincode = text(
    input.dispatchAddress.pincode,
    "Pincode",
    6,
    6
  );

  const gstin = text(
    input.gstin ?? "",
    "GSTIN",
    15,
    0
  ).toUpperCase();

  if (
    !/^\d{7,15}$/.test(phone) ||
    !/^[1-9]\d{5}$/.test(pincode) ||
    (
      gstin &&
      !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(
        gstin
      )
    ) ||
    (
      input.dispatchAddress.country &&
      input.dispatchAddress.country !== "IN"
    )
  ) {
    throw problem(
      400,
      "INVALID_SUPPLIER_INPUT",
      "Check the phone, Indian pincode and optional GSTIN format."
    );
  }

  return {
    legalName: text(
      input.legalName,
      "Legal business name",
      200,
      2
    ),

    contactName: text(
      input.contactName,
      "Contact name",
      100,
      2
    ),

    phone,
    gstin,

    dispatchAddress: {
      addressLine: text(
        input.dispatchAddress.addressLine,
        "Dispatch address",
        300,
        5
      ),

      city: text(
        input.dispatchAddress.city,
        "City",
        100,
        2
      ),

      state: text(
        input.dispatchAddress.state,
        "State",
        100,
        2
      ),

      pincode,
      country: "IN",
    },
  };
}

function trialState(workspace, now = new Date()) {
  const start = workspace.trial?.startAt;
  const end = workspace.trial?.endAt;

  if (!start || !end) {
    return {
      state: "not-started",
      remainingDays: null,
      startAt: null,
      endAt: null,
    };
  }

  const startAt = new Date(start);
  const endAt = new Date(end);

  const remainingDays = Math.max(
    0,
    Math.ceil((endAt - now) / DAY)
  );

  return {
    state:
      now >= endAt
        ? "review-required"
        : now < startAt
          ? "scheduled"
          : "active",

    remainingDays,
    startAt,
    endAt,
  };
}

// This is a commercial readiness check,
// not permission to dispatch an order.
// Phase 3/4 must additionally enforce product,
// stock, payment and fulfilment checks.
function commercialReadiness(
  workspace,
  agreement,
  now = new Date()
) {
  const trial = trialState(workspace, now);
  const reasons = [];

  if (workspace.status !== "approved") {
    reasons.push(
      "Admin approval is required."
    );
  }

  if (
    !workspace.ownerUser ||
    !workspace.submittedAt
  ) {
    reasons.push(
      "Supplier onboarding is incomplete."
    );
  }

  if (
    !agreement ||
    agreement.status !== "accepted" ||
    !agreement.acceptance?.acceptedAt ||
    String(agreement._id) !==
      String(workspace.acceptedAgreement) ||
    String(agreement.workspace) !==
      String(workspace._id)
  ) {
    reasons.push(
      "Accepted commercial terms are required."
    );
  }

  if (trial.state !== "active") {
    reasons.push(
      trial.state === "review-required"
        ? "The trial ended. New terms require a separate agreement."
        : "The approved trial has not started."
    );
  }

  return {
    ready: reasons.length === 0,
    reasons,
    trial,
  };
}

module.exports = {
  DAY,
  problem,
  fields,
  text,
  id,
  revision,
  normalizeTerms,
  digestTerms,
  normalizeProfile,
  trialState,
  commercialReadiness,
};