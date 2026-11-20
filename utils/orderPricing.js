const FREE_SHIPPING_LIMIT = 500;
const STANDARD_SHIPPING = 99;
const EXPRESS_SHIPPING = 199;

const COUPONS = Object.freeze({
  GYM10: Object.freeze({
    code: "GYM10",
    type: "percentage",
    value: 10,
    minimum: 1000,
  }),

  GEAR200: Object.freeze({
    code: "GEAR200",
    type: "fixed",
    value: 200,
    minimum: 1500,
  }),

  TRAIN15: Object.freeze({
    code: "TRAIN15",
    type: "percentage",
    value: 15,
    minimum: 2500,
  }),
});

// Convert a value into a finite number.
function number(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

// Round monetary amounts to two decimal places.
function roundMoney(value) {
  return (
    Math.round(
      (number(value) + Number.EPSILON) * 100,
    ) / 100
  );
}

// A chosen size/colour must match exactly, including an absent axis. Only
// unselected catalogue displays can use the starting (lowest) price.
function getProductPrices(product = {}, size = product?.selectedSize, color = product?.selectedColor) {
  const rows = product?.variantPrices;
  if (Array.isArray(rows) && rows.length) {
    const row = size === undefined && color === undefined
      ? rows.reduce((lowest, candidate) =>
          candidate.customerUnitAmount < lowest.customerUnitAmount ? candidate : lowest)
      : rows.find((candidate) =>
          (candidate.size || null) === (size || null) &&
          (candidate.color || null) === (color || null));

    const amount = row?.customerUnitAmount;
    const mrp = row?.mrpUnitAmount ?? amount;
    if (!Number.isSafeInteger(amount) || amount < 1 || !Number.isSafeInteger(mrp) || mrp < amount) {
      throw Object.assign(new Error("This selection needs a price correction before purchase."), {
        status: 409,
        code: "PRODUCT_PRICE_INVALID",
        gymdrobe: true,
      });
    }

    return {
      originalPrice: mrp / 100,
      price: amount / 100,
      discount: Math.round((mrp - amount) * 10000 / mrp) / 100,
    };
  }

  // The existing catalogue applies its percentage discount in whole rupees.
  const originalPrice = Math.max(0, Math.round(number(product?.price)));
  const discount = Math.min(100, Math.max(0, number(product?.discount)));
  return { originalPrice, price: Math.round(originalPrice * (1 - discount / 100)), discount };
}

function getOriginalPrice(product, size, color) {
  return getProductPrices(product, size, color).originalPrice;
}

function getDiscountPercentage(product, size, color) {
  return getProductPrices(product, size, color).discount;
}

function getDiscountedPrice(product, size, color) {
  return getProductPrices(product, size, color).price;
}

// Accept only coupon codes defined by the server.
function resolveCoupon(coupon) {
  const code = String(
    typeof coupon === "string"
      ? coupon
      : coupon?.code || "",
  )
    .trim()
    .toUpperCase();

  return Object.prototype.hasOwnProperty.call(
    COUPONS,
    code,
  )
    ? COUPONS[code]
    : null;
}

function calculateSubtotal(cart = []) {
  const items = Array.isArray(cart)
    ? cart
    : [];

  return roundMoney(
    items.reduce((sum, item) => {
      const quantity = number(
        item?.quantity,
      );

      if (
        !Number.isSafeInteger(quantity) ||
        quantity < 1
      ) {
        return sum;
      }

      return (
        sum +
        Math.max(
          0,
          number(item?.price),
        ) *
          quantity
      );
    }, 0),
  );
}

function calculateCouponDiscount(
  subtotal,
  coupon,
) {
  const valid = resolveCoupon(coupon);

  const amount = Math.max(
    0,
    number(subtotal),
  );

  if (
    !valid ||
    amount < valid.minimum
  ) {
    return 0;
  }

  const discount =
    valid.type === "fixed"
      ? valid.value
      : (amount * valid.value) / 100;

  return roundMoney(
    Math.min(
      amount,
      discount,
    ),
  );
}

function calculateShipping(
  amountAfterCoupon,
  deliveryMethod = "standard",
) {
  if (deliveryMethod === "express") {
    return EXPRESS_SHIPPING;
  }

  return (
    number(amountAfterCoupon) >=
    FREE_SHIPPING_LIMIT
  )
    ? 0
    : STANDARD_SHIPPING;
}

function calculateOrderPricing({
  cart = [],
  coupon = null,
  deliveryMethod = "standard",
} = {}) {
  const subtotal =
    calculateSubtotal(cart);

  const couponDiscount =
    calculateCouponDiscount(
      subtotal,
      coupon,
    );

  const totalAfterCoupon =
    roundMoney(
      Math.max(
        0,
        subtotal - couponDiscount,
      ),
    );

  const shipping =
    Array.isArray(cart) &&
    cart.length > 0
      ? calculateShipping(
          totalAfterCoupon,
          deliveryMethod,
        )
      : 0;

  return {
    subtotal,
    couponDiscount,
    totalAfterCoupon,
    shipping,

    finalTotal: roundMoney(
      totalAfterCoupon + shipping,
    ),
  };
}

module.exports = {
  FREE_SHIPPING_LIMIT,
  STANDARD_SHIPPING,
  EXPRESS_SHIPPING,
  COUPONS,
  number,
  roundMoney,
  getProductPrices,
  getOriginalPrice,
  getDiscountPercentage,
  getDiscountPercent: getDiscountPercentage,
  getDiscountedPrice,
  resolveCoupon,
  calculateSubtotal,
  calculateCouponDiscount,
  calculateShipping,
  calculateOrderPricing,
};
