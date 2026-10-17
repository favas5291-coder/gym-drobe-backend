"use strict";

// Uses availability and timing recorded by the admin.
// This does not perform a live courier coverage check.

function checkoutDelivery(
  products,
  items,
  pincode,
) {
  const code =
    typeof pincode === "string"
      ? pincode.trim()
      : "";

  const validPincode =
    /^[1-9]\d{5}$/.test(code);

  const selected = items.map((item) =>
    products.find(
      (product) =>
        String(product._id || product.id) ===
        String(item.product || item.id),
    ),
  );

  const unavailable = selected.some(
    (product) =>
      !product ||
      product.delivery?.available === false,
  );

  const estimates = selected.map((product) => {
    const preparation = product?.fulfillment;
    const transit = product?.delivery;

    const values = [
      preparation?.preparationDaysMin,
      preparation?.preparationDaysMax,
      transit?.transitDaysMin,
      transit?.transitDaysMax,
    ];

    const validDays = values.every(
      (value) =>
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 365,
    );

    if (
      !validDays ||
      values[1] < values[0] ||
      values[3] < values[2]
    ) {
      return null;
    }

    return {
      minimum: values[0] + values[2],
      maximum: values[1] + values[3],
    };
  });

  const estimatedDays =
    estimates.length &&
    estimates.every(Boolean)
      ? {
          minimum: Math.max(
            ...estimates.map(
              (row) => row.minimum,
            ),
          ),

          maximum: Math.max(
            ...estimates.map(
              (row) => row.maximum,
            ),
          ),
        }
      : null;

  return {
    ready:
      validPincode &&
      !unavailable,

    pincode: code,

    available: !unavailable,

    courierCoverageConfirmed: false,

    estimatedDays,

    validUntil: new Date(
      Date.now() + 10 * 60000,
    ).toISOString(),

    notice: unavailable
      ? "A selected product is unavailable for delivery."
      : "Availability follows the product’s recorded delivery settings. Courier pincode coverage is not checked live. Preparation and transit estimates apply only when recorded.",
  };
}

module.exports = {
  checkoutDelivery,
};