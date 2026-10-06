const FREE_SHIPPING_LIMIT = 500;

const STANDARD_SHIPPING = 99;

const EXPRESS_SHIPPING = 199;


const COUPONS = Object.freeze({
  MIDLAJ: {
    code: "MIDLAJ",
    type: "percentage",
    value: 10,
    minimum: 1000,
  },

  NISHAD: {
    code: "NISHAD",
    type: "fixed",
    value: 200,
    minimum: 1500,
  },

  FAVAS: {
    code: "FAVAS",
    type: "percentage",
    value: 15,
    minimum: 2500,
  },
});


// ======================================================
// NUMBER
// ======================================================

function number(
  value,
  fallback = 0
) {
  const parsed =
    Number(value);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
}


// ======================================================
// MONEY ROUNDING
// ======================================================

function roundMoney(
  value
) {
  return (
    Math.round(
      (
        number(value) +
        Number.EPSILON
      ) *
        100
    ) / 100
  );
}


// ======================================================
// ORIGINAL PRODUCT PRICE
//
// IMPORTANT:
// This matches src/utils/productPricing.js exactly.
// ======================================================

function getOriginalPrice(
  product = {}
) {
  return Math.max(
    0,
    Math.round(
      number(
        product?.price
      )
    )
  );
}


// ======================================================
// DISCOUNT PERCENTAGE
// ======================================================

function getDiscountPercentage(
  product = {}
) {
  return Math.min(
    100,
    Math.max(
      0,
      number(
        product?.discount
      )
    )
  );
}


// Keep old function name available
// in case another backend file uses it.

function getDiscountPercent(
  product = {}
) {
  return getDiscountPercentage(
    product
  );
}


// ======================================================
// DISCOUNTED PRODUCT PRICE
//
// IMPORTANT:
// Product price is rounded to a WHOLE RUPEE,
// matching the frontend.
//
// Example:
// ₹2499 - 10%
// = ₹2249.10
// frontend rounds it to ₹2249
// backend must also use ₹2249
// ======================================================

function getDiscountedPrice(
  product = {}
) {
  return Math.round(
    getOriginalPrice(
      product
    ) *
      (
        1 -
        getDiscountPercentage(
          product
        ) /
          100
      )
  );
}


// ======================================================
// COUPON
// ======================================================

function resolveCoupon(
  coupon
) {
  const code =
    String(
      typeof coupon ===
        "string"
        ? coupon
        : coupon?.code ||
            ""
    )
      .trim()
      .toUpperCase();


  return (
    COUPONS[code] ||
    null
  );
}


// ======================================================
// SUBTOTAL
// ======================================================

function calculateSubtotal(
  cart = []
) {
  return roundMoney(
    (
      Array.isArray(
        cart
      )
        ? cart
        : []
    ).reduce(
      (
        sum,
        item
      ) => {
        const quantity =
          number(
            item?.quantity
          );


        if (
          !Number.isSafeInteger(
            quantity
          ) ||
          quantity < 1
        ) {
          return sum;
        }


        return (
          sum +
          Math.max(
            0,
            number(
              item?.price
            )
          ) *
            quantity
        );
      },
      0
    )
  );
}


// ======================================================
// COUPON DISCOUNT
// ======================================================

function calculateCouponDiscount(
  subtotal,
  coupon
) {
  const valid =
    resolveCoupon(
      coupon
    );


  const amount =
    Math.max(
      0,
      number(
        subtotal
      )
    );


  if (
    !valid ||
    amount <
      valid.minimum
  ) {
    return 0;
  }


  const discount =
    valid.type ===
    "fixed"
      ? valid.value
      : (
          amount *
          valid.value
        ) /
        100;


  return roundMoney(
    Math.min(
      amount,
      discount
    )
  );
}


// ======================================================
// SHIPPING
// ======================================================

function calculateShipping(
  amountAfterCoupon,
  deliveryMethod = "standard"
) {
  if (
    deliveryMethod ===
    "express"
  ) {
    return EXPRESS_SHIPPING;
  }


  return (
    number(
      amountAfterCoupon
    ) >=
    FREE_SHIPPING_LIMIT
  )
    ? 0
    : STANDARD_SHIPPING;
}


// ======================================================
// FINAL ORDER PRICING
// ======================================================

function calculateOrderPricing({
  cart = [],
  coupon = null,
  deliveryMethod = "standard",
} = {}) {
  const subtotal =
    calculateSubtotal(
      cart
    );


  const couponDiscount =
    calculateCouponDiscount(
      subtotal,
      coupon
    );


  const totalAfterCoupon =
    roundMoney(
      Math.max(
        0,
        subtotal -
          couponDiscount
      )
    );


  const shipping =
    Array.isArray(
      cart
    ) &&
    cart.length
      ? calculateShipping(
          totalAfterCoupon,
          deliveryMethod
        )
      : 0;


  return {
    subtotal,

    couponDiscount,

    totalAfterCoupon,

    shipping,

    finalTotal:
      roundMoney(
        totalAfterCoupon +
          shipping
      ),
  };
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  FREE_SHIPPING_LIMIT,

  STANDARD_SHIPPING,

  EXPRESS_SHIPPING,

  COUPONS,

  number,

  roundMoney,

  getOriginalPrice,

  getDiscountPercentage,

  getDiscountPercent,

  getDiscountedPrice,

  resolveCoupon,

  calculateSubtotal,

  calculateCouponDiscount,

  calculateShipping,

  calculateOrderPricing,
};