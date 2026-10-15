"use strict";

const { reference, confirmedDate, dayRange } = require("./kitDefinitions");
const MAX_PAISE = 10000000000;
const MAX_CHARGE_PAISE = 100000000;
const variantKey = (product, size, color) => JSON.stringify([
  reference(product), size || null, color || null,
]);
const whole = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const range = (value) => value && dayRange(value.minimum, value.maximum);

function verified(record, referenceField, now) {
  const audit = record?.verification;
  const expiry = new Date(audit?.validUntil).getTime();
  return record?.status === "active" && confirmedDate(audit?.confirmedAt, now) &&
    reference(audit?.confirmedBy) && String(audit?.[referenceField] || "").trim() &&
    Number.isFinite(expiry) && expiry > now && expiry > new Date(audit.confirmedAt).getTime();
}

function distribute(amount, weights) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!whole(amount) || !whole(total) || amount > total) throw new Error("Invalid advance allocation.");
  if (!total) return weights.map(() => 0);
  const rows = weights.map((weight, index) => {
    const numerator = BigInt(amount) * BigInt(weight);
    return { index, value: Number(numerator / BigInt(total)), remainder: numerator % BigInt(total) };
  });
  let left = amount - rows.reduce((sum, row) => sum + row.value, 0);
  const sorted = [...rows].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const row of sorted) if (left-- > 0) row.value += 1;
  return rows.map(row => row.value);
}

function originKey(origin) {
  if (!origin || !/^[1-9]\d{5}$/.test(origin.pickupPincode || "") || !String(origin.name || "").trim()) return "";
  if (origin.kind === "packing-location" && reference(origin.packingLocation) && !origin.supplier) return `packing-location:${reference(origin.packingLocation)}`;
  if (origin.kind === "supplier" && reference(origin.supplier) && !origin.packingLocation) return `supplier:${reference(origin.supplier)}`;
  if (origin.kind === "gymdrobe" && !origin.supplier && !origin.packingLocation) return "gymdrobe";
  return "";
}

function sameComponents(plan, rows, items) {
  if (!Array.isArray(plan.components) || !plan.components.length || plan.components.length > 50) return false;
  const expected = new Map();
  for (const index of rows) {
    const item = items[index];
    const key = variantKey(item.product, item.selectedSize, item.selectedColor);
    expected.set(key, (expected.get(key) || 0) + item.quantity);
  }
  const actual = new Map();
  const keys = new Set();
  for (const component of plan.components) {
    const key = variantKey(component.product, component.selectedSize, component.selectedColor);
    if (!reference(component.product) || !/^[a-z][a-z0-9-]{0,59}$/.test(component.key || "") ||
      keys.has(component.key) || actual.has(key) || !whole(component.quantity, 1) || component.quantity > 999) return false;
    keys.add(component.key); actual.set(key, component.quantity);
  }
  return expected.size === actual.size && [...expected].every(([key, quantity]) => actual.get(key) === quantity);
}

function unpack(plan, group, items, assigned) {
  if (!Array.isArray(plan.parcels) || !plan.parcels.length || plan.parcels.length > 50 ||
    (group.mode === "packed-together" && plan.parcels.length !== 1)) return null;
  const componentMap = new Map(plan.components.map(row => [row.key, row]));
  const totals = new Map(); const parcelKeys = new Set(); const parcels = [];
  for (const parcel of plan.parcels) {
    if (!/^[a-z][a-z0-9-]{0,59}$/.test(parcel.key || "") || parcelKeys.has(parcel.key) ||
      ![parcel.weightGrams, parcel.lengthMm, parcel.widthMm, parcel.heightMm].every(value => whole(value, 1)) ||
      !Array.isArray(parcel.contents) || !parcel.contents.length || parcel.contents.length > 50) return null;
    parcelKeys.add(parcel.key);
    const contents = []; const allocationKeys = new Set(); let merchandisePaise = 0;
    for (const allocation of parcel.contents) {
      const component = componentMap.get(allocation.componentKey);
      if (!component || allocationKeys.has(allocation.componentKey) || !whole(allocation.quantity, 1)) return null;
      allocationKeys.add(allocation.componentKey);
      const key = variantKey(component.product, component.selectedSize, component.selectedColor);
      totals.set(component.key, (totals.get(component.key) || 0) + allocation.quantity);
      let remaining = allocation.quantity;
      for (const index of group.rows) {
        const item = items[index];
        if (variantKey(item.product, item.selectedSize, item.selectedColor) !== key) continue;
        const used = assigned.get(index) || 0;
        const quantity = Math.min(remaining, item.quantity - used);
        if (quantity <= 0) continue;
        const price = item.priceAllocation;
        if (!price || price.quantity !== item.quantity || !whole(price.unitBasePaise) || !whole(price.extraPaiseUnits) ||
          price.extraPaiseUnits >= item.quantity || !whole(price.linePaidPaise) ||
          price.unitBasePaise * item.quantity + price.extraPaiseUnits !== price.linePaidPaise) return null;
        merchandisePaise += price.unitBasePaise * quantity + Math.max(0, Math.min(price.extraPaiseUnits - used, quantity));
        assigned.set(index, used + quantity); remaining -= quantity;
        contents.push({ itemIndex: index, name: item.name, quantity, selectedSize: item.selectedSize || null, selectedColor: item.selectedColor || null });
      }
      if (remaining) return null;
    }
    parcels.push({ parcel, plan, group, contents, merchandisePaise });
  }
  if (!plan.components.every(row => totals.get(row.key) === row.quantity)) return null;
  return parcels;
}

// Uses server-loaded records only. Does not fetch links, reserve stock,
// place supplier orders, start payment or physically combine parcels.
function buildKitShippingQuote({ quote, products = [], kits = [], plans = [], profiles = [], pincode = "", now = Date.now() }) {
  const blocked = (issues) => ({ ready: false, issues: [...new Set(issues)], packageCount: null, shipments: [], shippingPaise: null, validUntil: null });
  if (typeof pincode !== "string" || !/^[1-9]\d{5}$/.test(pincode)) return blocked(["Enter your six-digit delivery pincode to confirm packages and shipping."]);
  if (!quote?.fulfillment?.configurationReady) return blocked(quote?.fulfillment?.issues || ["Complete the supplier and packing arrangements before confirming shipping."]);
  const items = quote.items || [];
  if (!items.length || items.length > 50 || !items.every(item => whole(item.quantity, 1))) return blocked(["Check the purchased components and quantities."]);
  const productMap = new Map(products.map(product => [reference(product._id || product.id), product]));
  const kitMap = new Map(kits.map(kit => [reference(kit._id || kit.id), kit]));
  const groups = new Map(); const issues = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]; const product = productMap.get(reference(item.product));
    if (!product) { issues.push(`${item.name}: product details are unavailable.`); continue; }
    const snapshot = item.kit && quote.kitSnapshots.find(kit => kit.groupId === item.kit.groupId);
    const kit = snapshot && kitMap.get(reference(snapshot.template));
    const packed = kit?.fulfillment?.mode === "packed-together";
    const origin = packed ? `packing-location:${reference(kit.fulfillment.packingLocation)}` :
      product.fulfillment?.dispatchBy === "supplier" && reference(product.supplier) ? `supplier:${reference(product.supplier)}` :
      product.fulfillment?.dispatchBy === "gymdrobe" ? "gymdrobe" : "";
    if (!origin || origin === "packing-location:") { issues.push(`${item.name}: record a supported, confirmed dispatch origin.`); continue; }
    const key = packed ? `kit:${item.kit.groupId}` : `origin:${origin}`;
    if (!groups.has(key)) groups.set(key, { key, origin, mode: packed ? "packed-together" : "separate-shipments", rows: [], groupId: packed ? item.kit.groupId : null });
    groups.get(key).rows.push(index);
  }
  if (issues.length) return blocked(issues);
  const selected = []; const assigned = new Map();
  for (const group of groups.values()) {
    const candidates = plans.filter(plan => verified(plan, "measurementReference", now) && originKey(plan.origin) === group.origin && sameComponents(plan, group.rows, items));
    if (candidates.length !== 1) {
      issues.push(candidates.length ? "Several active package plans match this selection. Keep one confirmed plan active per selection and origin." : "No active, measured package plan matches every selected product, variant and quantity for this dispatch origin.");
      continue;
    }
    const parcels = unpack(candidates[0], group, items, assigned);
    if (!parcels) issues.push("The matching package plan needs complete parcel measurements and exact component quantities; a packed-together kit needs one parcel.");
    else selected.push(...parcels);
  }
  if (issues.length) return blocked(issues);
  if (!items.every((item, index) => assigned.get(index) === item.quantity)) return blocked(["Package contents must account for every purchased unit exactly once."]);
  const merchandise = Math.round(quote.pricing.totalAfterCoupon * 100);
  const parcelMerchandise = selected.map(row => row.merchandisePaise);
  if (!whole(merchandise) || parcelMerchandise.reduce((sum, value) => sum + value, 0) !== merchandise) return blocked(["Component payment allocations do not match the merchandise total."]);
  const cod = quote.payment.method === "cod-partial";
  const advances = distribute(cod ? Math.round(merchandise / 10) : 0, parcelMerchandise);
  let shippingPaise = 0; let expiry = Infinity;
  const shipments = [];
  for (const [index, entry] of selected.entries()) {
    const { parcel, plan, group, contents, merchandisePaise } = entry;
    const units = contents.reduce((sum, item) => sum + item.quantity, 0);
    const productIds = contents.map(item => reference(items[item.itemIndex].product));
    const matches = profiles.filter(profile => {
      const service = profile.service; const limits = profile.parcelLimits; const charges = profile.charges;
      if (!verified(profile, "arrangementReference", now) || originKey(profile.origin) !== group.origin ||
        profile.origin.pickupPincode !== plan.origin.pickupPincode || !profile.destinationPincodes?.includes(pincode) ||
        !productIds.every(id => profile.productIds?.some(value => reference(value) === id)) ||
        service?.deliveryMethod !== quote.method || !String(service.carrier || "").trim() || !String(service.name || "").trim() ||
        !dayRange(service.transitDaysMin, service.transitDaysMax) ||
        !(cod ? service.supportsCodAdvance === true : service.supportsOnline === true) ||
        !whole(charges?.shippingPaise) || !whole(charges?.codFeePaise) || charges.shippingPaise > MAX_CHARGE_PAISE || charges.codFeePaise > MAX_CHARGE_PAISE) return false;
      if (![ ["maximumWeightGrams", parcel.weightGrams], ["maximumLengthMm", parcel.lengthMm], ["maximumWidthMm", parcel.widthMm], ["maximumHeightMm", parcel.heightMm], ["maximumUnits", units] ].every(([key, value]) => whole(limits?.[key], 1) && value <= limits[key])) return false;
      const fee = charges.shippingPaise + (cod ? charges.codFeePaise : 0);
      return !cod || (whole(service.maximumCodBalancePaise) && merchandisePaise - advances[index] + fee <= service.maximumCodBalancePaise);
    }).sort((a, b) => (a.charges.shippingPaise + (cod ? a.charges.codFeePaise : 0)) - (b.charges.shippingPaise + (cod ? b.charges.codFeePaise : 0)) || String(a._id || a.id).localeCompare(String(b._id || b.id)));
    if (!matches.length) { issues.push(`Package ${index + 1}: no active courier profile covers this pincode, payment method, parcel limits, products and COD balance.`); continue; }
    const profile = matches[0]; const fee = profile.charges.shippingPaise + (cod ? profile.charges.codFeePaise : 0);
    const details = quote.fulfillment.groups;
    const preparations = group.rows.map(itemIndex => {
      const item = items[itemIndex];
      const detail = details.find(value => item.kit ? value.groupId === item.kit.groupId : value.groupId === null && value.components.some(component => component.productId === reference(item.product)));
      return group.mode === "packed-together" ? detail?.estimates?.preparationDays : detail?.components.find(component => component.productId === reference(item.product) && (component.selectedSize || null) === (item.selectedSize || null) && (component.selectedColor || null) === (item.selectedColor || null))?.preparationDays;
    });
    if (!preparations.every(range)) { issues.push("Record preparation estimates for every purchased component."); continue; }
    const preparationDays = { minimum: Math.max(...preparations.map(value => value.minimum)), maximum: Math.max(...preparations.map(value => value.maximum)) };
    const transitDays = { minimum: profile.service.transitDaysMin, maximum: profile.service.transitDaysMax };
    expiry = Math.min(expiry, new Date(plan.verification.validUntil).getTime(), new Date(profile.verification.validUntil).getTime());
    shippingPaise += fee;
    shipments.push({ key: `package-${index + 1}`, groupId: group.groupId, label: parcel.label || `Package ${index + 1}`, carrier: profile.service.carrier, service: profile.service.name,
      contents, preparationDays, transitDays, estimatedDays: { minimum: preparationDays.minimum + transitDays.minimum, maximum: preparationDays.maximum + transitDays.maximum },
      shipping: fee / 100, amountDueOnDelivery: cod ? (merchandisePaise - advances[index] + fee) / 100 : 0 });
  }
  if (issues.length) return blocked(issues);
  if (!whole(shippingPaise) || merchandise + shippingPaise > MAX_PAISE) return blocked(["The final shipping charge exceeds the supported amount limit."]);
  return { ready: true, issues: [], packageCount: shipments.length, shipments, shippingPaise, validUntil: new Date(expiry).toISOString() };
}

module.exports = { buildKitShippingQuote };
