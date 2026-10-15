"use strict";
const {refundLines} = require("./orderRefundAllocation");
function invalid(message) {return Object.assign(new Error(message), {status: 409, code: "SHIPPING_SNAPSHOT_INVALID", gymdrobe: true});}
function amount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw invalid("Purchased shipping amounts need reconciliation.");
  return Math.round(value * 100);
}
function whole(value, min = 0) {if (!Number.isSafeInteger(value) || value < min) throw invalid("Purchased package quantities are invalid."); return value;}
function text(value, max, required = true) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (required && !value.trim())) throw invalid("Purchased package labels need review.");
  return value;
}
function range(value, max = 365) {
  if (!value || !Number.isSafeInteger(value.minimum) || !Number.isSafeInteger(value.maximum) || value.minimum < 0 || value.maximum < value.minimum || value.maximum > max) throw invalid("Purchased delivery estimates need review.");
  return {minimum: value.minimum, maximum: value.maximum};
}

function validatePurchasedShipping(order) {
  const snapshot = order.shippingSnapshot;
  if (!snapshot) return;
  const lines = refundLines(order);
  const reviewed = new Date(snapshot.reviewedAt).getTime(), expiry = new Date(snapshot.validUntil).getTime();
  const method = order.payment?.method || order.paymentMethod;
  const shipping = amount(order.pricing.shipping), merchandise = amount(order.pricing.totalAfterCoupon);
  const total = amount(order.pricing.finalTotal), advance = method === "cod-partial" ? Math.round(merchandise / 10) : total;
  if (snapshot.version !== 1 || !/^[1-9]\d{5}$/.test(snapshot.destinationPincode || "") || snapshot.destinationPincode !== order.shippingAddress?.pincode || snapshot.paymentMethod !== method || !["razorpay", "cod-partial"].includes(method) || !Number.isFinite(reviewed) || !Number.isFinite(expiry) || reviewed > Date.now() || expiry <= reviewed || snapshot.shippingPaise !== shipping || snapshot.merchandisePaise !== merchandise || snapshot.totalPaise !== total || total !== merchandise + shipping || snapshot.payNowPaise !== advance || snapshot.amountDuePaise !== total - advance || !Array.isArray(snapshot.shipments) || !snapshot.shipments.length || snapshot.shipments.length > 1000 || snapshot.packageCount !== snapshot.shipments.length) throw invalid("Purchased package totals, destination or review dates do not match the order.");
  const allocated = new Map(), keys = new Set();
  let fees = 0, dues = 0;
  const groupPackages = new Map();
  for (const parcel of snapshot.shipments) {
    text(parcel.key, 100); text(parcel.label, 150); text(parcel.carrier, 100); text(parcel.service, 200);
    if (keys.has(parcel.key) || !Array.isArray(parcel.contents) || !parcel.contents.length) throw invalid("Purchased package keys and contents must be distinct and complete.");
    keys.add(parcel.key);
    if (parcel.groupId) {
      if (!order.kitSnapshots?.some(kit => kit.groupId === parcel.groupId)) throw invalid("A purchased package references an unknown kit.");
      groupPackages.set(parcel.groupId, (groupPackages.get(parcel.groupId) || 0) + 1);
    }
    const preparation = range(parcel.preparationDays), transit = range(parcel.transitDays), estimates = range(parcel.estimatedDays, 730);
    if (estimates.minimum !== preparation.minimum + transit.minimum || estimates.maximum !== preparation.maximum + transit.maximum) throw invalid("Purchased preparation and transit estimates do not reconcile.");
    let parcelValue = 0;
    const indexes = new Set();
    for (const row of parcel.contents) {
      const index = whole(row.itemIndex), quantity = whole(row.quantity, 1);
      const item = order.items[index], line = lines[index];
      if (!item || !line || indexes.has(index) || String(item.product) !== row.productId || item.name !== row.name || (item.selectedSize || null) !== (row.selectedSize || null) || (item.selectedColor || null) !== (row.selectedColor || null) || (parcel.groupId && item.kit?.groupId !== parcel.groupId)) throw invalid("Purchased package contents do not match the selected products and variants.");
      indexes.add(index);
      const start = allocated.get(index) || 0;
      if (start + quantity > item.quantity) throw invalid("Purchased package contents allocate a unit more than once.");
      if (line.unitBasePaise == null) throw invalid("Purchased packages require exact component discount allocations.");
      parcelValue += line.unitBasePaise * quantity + Math.max(0, Math.min(line.extraPaiseUnits - start, quantity));
      allocated.set(index, start + quantity);
    }
    whole(parcel.shippingPaise); whole(parcel.amountDuePaise);
    if (parcel.merchandisePaise !== parcelValue || !Number.isSafeInteger(parcelValue)) throw invalid("Purchased parcel merchandise values do not match their contents.");
    if (method === "razorpay" ? parcel.amountDuePaise !== 0 : parcel.amountDuePaise > parcelValue + parcel.shippingPaise) throw invalid("Purchased package COD balances need reconciliation.");
    fees += parcel.shippingPaise; dues += parcel.amountDuePaise;
  }
  if (!Number.isSafeInteger(fees) || !Number.isSafeInteger(dues) || fees !== shipping || dues !== total - advance || !order.items.every((item, index) => allocated.get(index) === item.quantity)) throw invalid("Purchased packages must allocate every selected unit, delivery fee and COD balance exactly once.");
  if (method === "cod-partial") {
    const allocations = snapshot.shipments.map((parcel, index) => {
      const numerator = BigInt(parcel.merchandisePaise) * BigInt(advance);
      return {index, value: merchandise ? Number(numerator / BigInt(merchandise)) : 0, remainder: merchandise ? numerator % BigInt(merchandise) : 0n};
    });
    let left = advance - allocations.reduce((sum, row) => sum + row.value, 0);
    for (const row of [...allocations].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
      if (left <= 0) break;
      row.value += 1; left -= 1;
    }
    if (snapshot.shipments.some((parcel, index) => parcel.amountDuePaise !== parcel.merchandisePaise - allocations[index].value + parcel.shippingPaise)) throw invalid("The COD advance must be allocated consistently across the purchased packages.");
  }
  for (const kit of order.kitSnapshots || []) {
    if (kit.fulfillmentMode === "packed-together" && (groupPackages.get(kit.groupId) !== 1 || snapshot.shipments.some(parcel => parcel.contents.some(row => order.items[row.itemIndex]?.kit?.groupId === kit.groupId) && parcel.groupId !== kit.groupId))) throw invalid("A packed-together kit must be contained in its one recorded package.");
  }
}

// The caller must supply a quote freshly calculated from backend records.
// Client-submitted snapshots must never be passed into this function.
function snapshotPurchasedShipping(quote, pincode, now = Date.now()) {
  const review = quote.shippingReview;
  if (quote.shippingIsEstimate !== false || review?.ready !== true || !Number.isFinite(Date.parse(review.validUntil)) || Date.parse(review.validUntil) <= now) throw invalid("Recheck current package contents and shipping before creating the order.");
  const shipping = amount(quote.pricing.shipping), merchandise = amount(quote.pricing.totalAfterCoupon);
  if (review.shippingPaise !== shipping) throw invalid("Reviewed shipping charges do not match the checkout total.");
  const total = amount(quote.pricing.finalTotal), method = quote.payment.method;
  const used = new Map();
  const shipments = review.shipments.map(parcel => {
    let merchandisePaise = 0;
    const contents = parcel.contents.map(row => {
      const item = quote.items[row.itemIndex];
      if (!item) throw invalid("A reviewed parcel references an unavailable item.");
      const start = used.get(row.itemIndex) || 0, allocation = item.priceAllocation;
      if (!allocation) throw invalid("The reviewed item discount allocation is missing.");
      merchandisePaise += allocation.unitBasePaise * row.quantity + Math.max(0, Math.min(allocation.extraPaiseUnits - start, row.quantity));
      used.set(row.itemIndex, start + row.quantity);
      return {itemIndex: row.itemIndex, productId: String(item.product), name: item.name, selectedSize: item.selectedSize || null, selectedColor: item.selectedColor || null, quantity: row.quantity};
    });
    return {key: parcel.key, groupId: parcel.groupId || null, label: parcel.label, carrier: parcel.carrier, service: parcel.service, contents, preparationDays: range(parcel.preparationDays), transitDays: range(parcel.transitDays), estimatedDays: range(parcel.estimatedDays, 730), merchandisePaise, shippingPaise: amount(parcel.shipping), amountDuePaise: amount(parcel.amountDueOnDelivery)};
  });
  const snapshot = {
    version: 1, destinationPincode: pincode, paymentMethod: method,
    reviewedAt: new Date(now), validUntil: new Date(review.validUntil), packageCount: review.packageCount,
    shippingPaise: shipping, merchandisePaise: merchandise, totalPaise: total,
    payNowPaise: amount(quote.payment.amountToPayNow), amountDuePaise: amount(quote.payment.amountDue), shipments,
  };
  validatePurchasedShipping({...quote, paymentMethod: method, shippingAddress: {pincode}, shippingSnapshot: snapshot});
  return snapshot;
}

module.exports = {snapshotPurchasedShipping, validatePurchasedShipping};
