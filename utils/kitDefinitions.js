"use strict";

const KIT_LEVELS = Object.freeze([
  "beginner",
  "intermediate",
  "advanced",
]);

const KIT_ROLES = Object.freeze([
  "clothing",
  "footwear",
  "supplements",
  "training-accessories",
  "gym-bag",
  "bottle-or-shaker",
  "workout-essentials",
]);

const ROLE_NAMES = Object.freeze({
  clothing: "Gym clothing",
  footwear: "Footwear",
  supplements: "Optional supplements",
  "training-accessories": "Training accessories",
  "gym-bag": "Gym bag",
  "bottle-or-shaker": "Bottle or shaker",
  "workout-essentials": "Workout essentials",
});

const LEVEL_DETAILS = Object.freeze({
  beginner: {
    name: "Beginner Kit",
    audience:
      "For customers starting a workout routine and choosing their everyday training essentials.",
    explanation:
      "Start with practical clothing, suitable footwear and everyday gym-bag essentials. Choose accessories for the workouts you actually do.",
  },

  intermediate: {
    name: "Intermediate Kit",
    audience:
      "For customers with a regular routine who want to adapt their gear to their training.",
    explanation:
      "Build around the gear you use regularly and replace or skip items you already own. Choose training accessories relevant to your sessions.",
  },

  advanced: {
    name: "Advanced Kit",
    audience:
      "For experienced customers selecting gear for specific training needs.",
    explanation:
      "Focus on the products relevant to your program, including specialized accessories where appropriate. A higher kit level does not mean every item must cost more.",
  },
});

const SUPPLEMENT_NOTE =
  "Supplements are optional. Choose No supplements if you do not want them. Kit level does not determine supplement requirements.";

function kitDraft(level) {
  if (!KIT_LEVELS.includes(level)) {
    throw new Error(
      "Choose beginner, intermediate or advanced.",
    );
  }

  return {
    level,
    ...LEVEL_DETAILS[level],
    status: "draft",

    discount: {
      type: "none",
      value: 0,
    },

    fulfillment: {
      mode: "unconfigured",
    },

    slots: KIT_ROLES.map((role) => ({
      key: role,
      role,
      label: ROLE_NAMES[role],
      whySelected: "",
      optional: role === "supplements",
      suggestedEssential: role !== "supplements",
      defaultIncluded: role !== "supplements",
      defaultProduct: null,
      defaultSize: null,
      defaultColor: null,
      defaultQuantity: 1,
      maximumQuantity: 5,
      allowedProducts: [],
    })),
  };
}

function reference(value) {
  const id =
    value &&
    typeof value === "object" &&
    value._id
      ? value._id
      : value;

  const text = String(id ?? "");

  return /^[a-f0-9]{24}$/i.test(text)
    ? text.toLowerCase()
    : "";
}

function dayRange(low, high) {
  return (
    Number.isSafeInteger(low) &&
    Number.isSafeInteger(high) &&
    low >= 0 &&
    high >= low &&
    high <= 365
  );
}

function confirmedDate(
  value,
  now = Date.now(),
) {
  const time =
    value instanceof Date ||
    typeof value === "string"
      ? new Date(value).getTime()
      : NaN;

  return (
    Number.isFinite(time) &&
    time <= now
  );
}

function money(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100000000 &&
    Math.abs(
      value * 100 -
        Math.round(value * 100),
    ) < 0.00001
  );
}

function kitStructureIssues(kit) {
  const issues = [];

  const rows = Array.isArray(kit?.slots)
    ? kit.slots
    : [];

  if (!KIT_LEVELS.includes(kit?.level)) {
    issues.push("Choose a valid kit level.");
  }

  if (!rows.length || rows.length > 20) {
    issues.push(
      "Configure between 1 and 20 kit sections.",
    );
  }

  const keys = new Set();

  for (const row of rows) {
    const name =
      row?.label ||
      row?.key ||
      "Kit section";

    if (
      !row ||
      !KIT_ROLES.includes(row.role)
    ) {
      issues.push(
        "Choose a valid category for each kit section.",
      );
      continue;
    }

    if (
      !/^[a-z][a-z0-9-]{0,59}$/.test(
        row.key || "",
      ) ||
      [
        "constructor",
        "prototype",
        "__proto__",
      ].includes(row.key) ||
      keys.has(row.key)
    ) {
      issues.push(
        `${name}: use a unique section key containing lowercase letters, digits or hyphens.`,
      );
    }

    keys.add(row.key);

    if (
      row.role === "supplements" &&
      (
        !row.optional ||
        row.suggestedEssential
      )
    ) {
      issues.push(
        `${name}: supplements must be optional and cannot be labelled essential.`,
      );
    }

    if (
      !Number.isSafeInteger(
        row.defaultQuantity,
      ) ||
      !Number.isSafeInteger(
        row.maximumQuantity,
      ) ||
      row.defaultQuantity < 1 ||
      row.maximumQuantity <
        row.defaultQuantity ||
      row.maximumQuantity > 99
    ) {
      issues.push(
        `${name}: quantities must be whole numbers from 1 to 99, with the default no higher than the maximum.`,
      );
    }

    const allowed = Array.isArray(
      row.allowedProducts,
    )
      ? row.allowedProducts.map(reference)
      : [];

    if (
      allowed.length > 50 ||
      allowed.some((id) => !id) ||
      new Set(allowed).size !==
        allowed.length
    ) {
      issues.push(
        `${name}: choose up to 50 distinct existing product IDs.`,
      );
    }

    if (
      row.defaultProduct != null &&
      (
        !reference(row.defaultProduct) ||
        !allowed.includes(
          reference(row.defaultProduct),
        )
      )
    ) {
      issues.push(
        `${name}: the default product must also be in its allowed-products list.`,
      );
    }
  }

  const discount = kit?.discount || {};

  if (
    ![
      "none",
      "percentage",
      "fixed",
    ].includes(discount.type)
  ) {
    issues.push(
      "Choose a valid discount type.",
    );
  }

  if (
    !money(discount.value) ||
    (
      discount.type === "none" &&
      discount.value !== 0
    ) ||
    (
      discount.type !== "none" &&
      discount.value <= 0
    ) ||
    (
      discount.type === "percentage" &&
      discount.value > 100
    )
  ) {
    issues.push(
      "Enter a valid discount value; percentages cannot exceed 100.",
    );
  }

  return issues;
}

module.exports = {
  KIT_LEVELS,
  KIT_ROLES,
  ROLE_NAMES,
  LEVEL_DETAILS,
  SUPPLEMENT_NOTE,
  kitDraft,
  reference,
  dayRange,
  confirmedDate,
  money,
  kitStructureIssues,
};