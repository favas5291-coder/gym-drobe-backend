"use strict";

function invalid(message) {
  return Object.assign(new Error(message), {
    status: 409, code: "REFUND_AMOUNT_INVALID", gymdrobe: true,
  });
}
function whole(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalid("Purchased quantities and discount allocations need reconciliation.");
  return value;
}
function paise(value) {
  if (!["number", "string"].includes(typeof value) || !String(value).trim()) throw invalid("Purchased monetary amounts are missing.");
  const number = Number(value), amount = Math.round(number * 100);
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(amount) || Math.abs(number * 100 - amount) > 0.000001) throw invalid("Purchased monetary amounts need reconciliation.");
  return amount;
}
const sum = values => whole(values.reduce((total, value) => total + value, 0));

// Build from the immutable purchase, never current product prices or kit templates.
function refundLines(order) {
  if (!Array.isArray(order?.items) || !order.items.length || !order.pricing) throw invalid("Load the complete purchased order before calculating a refund.");
  const lines = order.items.map(item => {
    const quantity = whole(item.quantity, 1);
    const price = paise(item.price);
    return {quantity, price, subtotal: whole(price * quantity)};
  });
  const subtotal = sum(lines.map(line => line.subtotal));
  const coupon = paise(order.pricing.couponDiscount);
  const kit = order.pricing.kitDiscount == null ? 0 : paise(order.pricing.kitDiscount);
  const merchandise = paise(order.pricing.totalAfterCoupon);
  if (subtotal !== paise(order.pricing.subtotal) || subtotal - coupon - kit !== merchandise) throw invalid("Purchased item totals, kit savings and coupon savings do not reconcile.");
  const allocated = Boolean(kit || order.kitSnapshots?.length || order.items.some(item => item.kit || item.priceAllocation));
  if (allocated) {
    const totals = [0, 0, 0];
    lines.forEach((line, index) => {
      const item = order.items[index], value = item.priceAllocation;
      if (!value) throw invalid("Every item in a kit order needs its purchased discount allocation.");
      for (const field of ["quantity", "lineSubtotalPaise", "kitDiscountPaise", "couponDiscountPaise", "linePaidPaise", "unitBasePaise", "extraPaiseUnits"]) whole(value[field]);
      if (value.quantity !== line.quantity || value.lineSubtotalPaise !== line.subtotal || value.kitDiscountPaise + value.couponDiscountPaise > line.subtotal || line.subtotal - value.kitDiscountPaise - value.couponDiscountPaise !== value.linePaidPaise || value.extraPaiseUnits >= line.quantity || value.unitBasePaise * line.quantity + value.extraPaiseUnits !== value.linePaidPaise || (!item.kit && value.kitDiscountPaise !== 0)) throw invalid("Purchased component discount allocations are inconsistent.");
      totals[0] += value.kitDiscountPaise; totals[1] += value.couponDiscountPaise; totals[2] += value.linePaidPaise;
      // Units with the rounding remainder are assigned first, matching checkout/shipping.
      line.unitBasePaise = value.unitBasePaise;
      line.extraPaiseUnits = value.extraPaiseUnits;
      line.linePaidPaise = value.linePaidPaise;
    });
    if (!totals.every(Number.isSafeInteger) || totals[0] !== kit || totals[1] !== coupon || totals[2] !== merchandise) throw invalid("Purchased component savings do not match the order totals.");
    return lines;
  }
  // Older ordinary orders have no saved allocation. Preserve their original coupon
  // distribution: proportional lines, largest remainder, cheaper units first.
  const allocations = lines.map((line, index) => {
    const numerator = BigInt(line.subtotal) * BigInt(coupon);
    return {index, discount: subtotal ? Number(numerator / BigInt(subtotal)) : 0, remainder: subtotal ? numerator % BigInt(subtotal) : 0n};
  });
  let remainder = coupon - sum(allocations.map(line => line.discount));
  for (const line of [...allocations].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (remainder <= 0) break;
    line.discount += 1; remainder -= 1;
  }
  lines.forEach((line, index) => {
    const discount = allocations[index].discount;
    line.legacyDiscountBase = Math.floor(discount / line.quantity);
    line.legacyDiscountExtras = discount % line.quantity;
    line.linePaidPaise = line.subtotal - discount;
  });
  return lines;
}

function calculateItemRefundPaise(order, rows, quantityField = "quantity") {
  const lines = refundLines(order);
  if (!Array.isArray(rows) || !rows.length || rows.length > lines.length) throw invalid("Choose the purchased items to refund.");
  const indexes = new Set();
  const refunds = rows.map(row => {
    if (!row || !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= lines.length || indexes.has(row.index)) throw invalid("Each purchased order item can be included only once per refund calculation.");
    indexes.add(row.index);
    const line = lines[row.index];
    const quantity = whole(row[quantityField]);
    if (quantity > line.quantity) throw invalid("Returned quantity exceeds the purchased quantity.");
    // An internal unit offset supports future repeat returns without refunding the
    // same rounding paise again. Controllers currently allow one completed request.
    const start = row.refundedUnitsBefore == null ? 0 : whole(row.refundedUnitsBefore);
    if (start + quantity > line.quantity) throw invalid("Previously refunded and returned units exceed the purchase.");
    const extras = count => Math.max(0, Math.min(count - start, quantity));
    if (line.unitBasePaise != null) return whole(line.unitBasePaise * quantity + extras(line.extraPaiseUnits));
    return whole((line.price - line.legacyDiscountBase) * quantity - extras(line.legacyDiscountExtras));
  });
  return sum(refunds);
}

module.exports = {refundLines, calculateItemRefundPaise};
