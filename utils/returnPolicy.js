"use strict";

const REQUEST_TYPES = Object.freeze([
  "return",
  "exchange",
]);

const DEFAULT_RETURN_DAYS = 7;

function validRequestTypes(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 2 &&
    new Set(value).size === value.length &&
    value.every((type) =>
      REQUEST_TYPES.includes(type)
    )
  );
}

function requestTypes(item) {
  // Missing fields retain the behaviour of historical purchases.
  // Never infer new restrictions from today's product or supplier record.
  if (item?.returnRequestTypes == null) {
    return [...REQUEST_TYPES];
  }

  return validRequestTypes(item.returnRequestTypes)
    ? [...item.returnRequestTypes]
    : [];
}

function returnPolicyIssue(
  item,
  type,
  delivered,
  now = Date.now()
) {
  if (!item || typeof item !== "object") {
    return {
      code: "RETURN_POLICY_UNCONFIRMED",
      message:
        "The purchased item needs support review.",
    };
  }

  if (!REQUEST_TYPES.includes(type)) {
    return {
      code: "INVALID_RETURN_TYPE",
      message: "Choose return or exchange.",
    };
  }

  if (item.returnsEligible === "no") {
    return {
      code: "ITEM_NOT_RETURNABLE",
      message:
        "This purchase is not eligible for a routine return or exchange. Contact support about damaged, incorrect or faulty items.",
    };
  }

  if (!requestTypes(item).includes(type)) {
    return {
      code: "RETURN_TYPE_NOT_ALLOWED",

      message:
        type === "return"
          ? "This purchase supports exchanges only. Contact support about damaged, incorrect or faulty items."
          : "Exchanges are not included in this purchase's policy. Check the return option or contact support.",
    };
  }

  const days =
    item.returnWindowDays ?? DEFAULT_RETURN_DAYS;

  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > 7 ||
    !Number.isFinite(delivered) ||
    !Number.isFinite(now) ||
    delivered > now
  ) {
    return {
      code: "RETURN_POLICY_UNCONFIRMED",
      message:
        "The request deadline needs support review.",
    };
  }

  if (now > delivered + days * 86400000) {
    return {
      code: "RETURN_WINDOW_ENDED",
      message:
        `The ${days}-day request window has ended. Contact support for help.`,
    };
  }

  return null;
}

module.exports = {
  REQUEST_TYPES,
  DEFAULT_RETURN_DAYS,
  validRequestTypes,
  requestTypes,
  returnPolicyIssue,
};