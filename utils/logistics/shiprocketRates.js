"use strict";

const endpoint = "https://apiv2.shiprocket.in/v1/external/courier/serviceability/";

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function queryFor(parcel) {
  if (!parcel || ![parcel.pickupPincode, parcel.deliveryPincode].every(
    value => typeof value === "string" && /^[1-9]\d{5}$/.test(value)
  )) throw new Error("Valid six-digit pickup and delivery pincodes are required.");
  if (![parcel.weightGrams, parcel.lengthMm, parcel.widthMm, parcel.heightMm,
        parcel.declaredValuePaise].every(positiveInteger)) {
    throw new Error("Use positive whole grams, millimetres and paise for the packed parcel.");
  }
  if (!["cod", "prepaid"].includes(parcel.payment)) throw new Error("Select cod or prepaid.");
  return new URLSearchParams({
    pickup_postcode: parcel.pickupPincode, delivery_postcode: parcel.deliveryPincode,
    cod: parcel.payment === "cod" ? "1" : "0", weight: String(parcel.weightGrams / 1000),
    length: String(parcel.lengthMm / 10), breadth: String(parcel.widthMm / 10),
    height: String(parcel.heightMm / 10), declared_value: (parcel.declaredValuePaise / 100).toFixed(2),
  });
}

function ratePaise(rate) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(rate));
  if (!match) throw new Error("Carrier returned an invalid rate.");
  const paise = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(paise)) throw new Error("Carrier rate exceeds supported range.");
  return paise;
}

async function quoteParcel(parcel, { env = process.env, fetchImpl = fetch } = {}) {
  const query = queryFor(parcel);
  const token = env.SHIPROCKET_QUOTE_TOKEN;
  if (env.SHIPROCKET_QUOTE_ENABLED !== "true" || typeof token !== "string" || !token.trim()) {
    throw new Error("Carrier rate lookup is not configured.");
  }
  let response;
  try {
    response = await fetchImpl(endpoint + "?" + query, {
      method: "GET", headers: { Accept: "application/json", Authorization: "Bearer " + token },
      redirect: "error", signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("Carrier rate lookup did not complete. Availability is unknown.");
  }
  if (!response.ok) throw new Error("Carrier rate lookup returned HTTP " + response.status + ".");
  const result = await response.json().catch(() => null);
  const rows = result?.data?.available_courier_companies;
  if (!Array.isArray(rows)) throw new Error("Carrier response is missing its serviceability results.");
  return rows.filter(row => parcel.payment !== "cod" || [true, 1, "1"].includes(row?.cod)).map(row => {
    if (!positiveInteger(row?.courier_company_id) || typeof row.courier_name !== "string" || !row.courier_name.trim()) {
      throw new Error("Carrier response is missing courier identity.");
    }
    const days = String(row.estimated_delivery_days ?? "");
    return { carrierId: row.courier_company_id, name: row.courier_name.trim(),
      ratePaise: ratePaise(row.rate), estimatedDeliveryDays: /^\d{1,3}$/.test(days) ? Number(days) : null };
  }).sort((a, b) => a.ratePaise - b.ratePaise || a.carrierId - b.carrierId);
}

module.exports = { quoteParcel };
