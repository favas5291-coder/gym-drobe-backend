"use strict";

function unavailable(message, code) {
  throw Object.assign(new Error(message), { gymdrobe: true, status: 409, code });
}

function assertCodCoverage(body, pincode, requirePincode = false) {
  if (process.env.STANDARD_COD_ENABLED !== "true") {
    unavailable("Cash on delivery is currently unavailable. Choose online payment.", "COD_DISABLED");
  }
  if (body.items?.some(row => row && Object.hasOwn(row, "kitGroup"))) {
    unavailable("Full cash on delivery is unavailable for kit shipments.", "COD_KIT_UNAVAILABLE");
  }
  const supported = (process.env.STANDARD_COD_PINCODES || "").split(",").map(value => value.trim()).filter(value => /^[1-9]\d{5}$/.test(value));
  if (!supported.length || ((requirePincode || pincode) && !supported.includes(String(pincode || "").trim()))) {
    unavailable("Cash on delivery is unavailable for this pincode.", "COD_PINCODE_UNAVAILABLE");
  }
}

function standardCod(order) {
  return order?.payment?.method === "cod" && order?.metadata?.version === "cod-1";
}

module.exports = { assertCodCoverage, standardCod };
