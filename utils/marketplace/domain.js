"use strict";

const crypto = require("node:crypto");
const MAX = 10000000000;
function fail(message, status = 400, code = "MARKETPLACE_VALIDATION") {
  throw Object.assign(new Error(message), { status, code, gymdrobe:true });
}
function object(value, allowed, label = "Request") {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !allowed.includes(k))) fail(`${label} contains unsupported fields.`);
  return value;
}
function text(value, label, max = 200, min = 0) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`Check ${label}.`);
  return value.trim();
}
function integer(value, label, min = 0, max = MAX) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
const id = value => /^[a-f\d]{24}$/i.test(String(value)) ? String(value) : fail("Invalid record ID.");
const digest = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
function email(value) { const out = text(value, "email", 150, 3).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out)) fail("Enter a valid email."); return out; }
function password(value) { text(value, "password", 72, 12); if (Buffer.byteLength(value, "utf8") > 72) fail("Password exceeds 72 bytes."); return value; }
function address(value, label) {
  object(value, ["addressLine", "city", "state", "pincode", "country"], label);
  const out = { addressLine: text(value.addressLine, label, 300, 5), city: text(value.city, "city", 100, 2), state: text(value.state, "state", 100, 2), pincode: text(value.pincode, "pincode", 6, 6), country: "IN" };
  if (!/^[1-9]\d{5}$/.test(out.pincode) || (value.country && value.country !== "IN")) fail("Enter an Indian address and six-digit pincode.");
  return out;
}
function business(value) {
  object(value, ["legalName", "contactName", "phone", "businessAddress", "pickupAddress", "returnAddress", "brands", "categories", "gstin", "taxNotes"], "Business profile");
  const out = { legalName: text(value.legalName, "business name", 200, 2), contactName: text(value.contactName, "contact person", 100, 2), phone: text(value.phone, "phone", 15, 7), businessAddress: address(value.businessAddress, "business address"), pickupAddress: address(value.pickupAddress, "pickup address"), returnAddress: address(value.returnAddress, "return address"), gstin: text(value.gstin || "", "GSTIN", 15), taxNotes: text(value.taxNotes || "", "tax notes", 1000) };
  if (!/^\d{7,15}$/.test(out.phone) || (out.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(out.gstin))) fail("Check phone or GSTIN.");
  for (const key of ["brands", "categories"]) { if (!Array.isArray(value[key]) || !value[key].length || value[key].length > 30) fail(`Provide ${key}.`); out[key] = [...new Set(value[key].map(v => text(v, key, 100, 1)))]; }
  return out;
}
function terms(value) {
  object(value, ["text", "settlementHoldHours", "dispatchDaysMin", "dispatchDaysMax", "shippingResponsibility", "returnsResponsibility", "gatewayFeeResponsibility"], "Commercial terms");
  const out = { model: "protected-supplier-amount-v1", text: text(value.text, "agreed terms", 12000, 20), settlementHoldHours: integer(value.settlementHoldHours, "Settlement hold hours", 0, 2160), dispatchDaysMin: integer(value.dispatchDaysMin, "Minimum preparation days", 0, 365), dispatchDaysMax: integer(value.dispatchDaysMax, "Maximum preparation days", 0, 365) };
  if (out.dispatchDaysMax < out.dispatchDaysMin) fail("Maximum preparation time must follow minimum.");
  for (const key of ["shippingResponsibility", "returnsResponsibility", "gatewayFeeResponsibility"]) out[key] = text(value[key], key, 1000, 2);
  return out;
}
function option(value, max = 80) { if (value == null || value === "") return null; const s = text(value, "variant option", max, 1); if (s === "default" || /[.$]/.test(s) || ["__proto__", "constructor", "prototype"].includes(s)) fail("Invalid variant option."); return s; }
const key = row => JSON.stringify([row.size ?? null, row.color ?? null]);
function image(value) {
  const s = text(value, "image URL", 2000, 5);
  let u; try { u = new URL(s); } catch { fail("Use an uploaded image or public HTTPS image URL."); }
  if (u.protocol !== "https:" || u.username || u.password || /^(localhost|127\.|0\.|169\.254\.|10\.|192\.168\.|\[)/i.test(u.hostname)) fail("Use a public HTTPS image URL.");
  return s;
}
function draft(value, submit = false) {
  object(value, ["name", "brand", "category", "description", "images", "variantImages", "specifications", "material", "careInstructions", "sizeChart", "manufacturer", "origin", "warranty", "shippingLeadDays", "returnsEligible", "returnWindowDays", "returnRequestTypes", "returnConditions", "weightGrams", "dimensionsCm", "expiryDate", "batch", "variants"], "Product draft");
  const out = { name: text(value.name || "Untitled product", "name", 200, 2), brand: text(value.brand || "", "brand", 100, submit ? 1 : 0), category: text(value.category || "", "category", 100, submit ? 1 : 0), description: text(value.description || "", "description", 5000, submit ? 10 : 0) };
  if (!Array.isArray(value.images) || value.images.length > 12 || (submit && !value.images.length)) fail("Provide up to twelve product images.");
  out.images = [...new Set(value.images.map(image))];
  if(value.variantImages!==undefined&&(!Array.isArray(value.variantImages)||value.variantImages.length>30))fail("Provide up to thirty variant image groups.");
  out.variantImages = (value.variantImages || []).map(v => { object(v, ["color", "images"], "Variant images"); if (!Array.isArray(v.images) || v.images.length > 8) fail("Too many variant images."); return { color: option(v.color), images: v.images.map(image) }; });
  if (out.variantImages.length > 30) fail("Too many variant image groups.");
  for (const field of ["material", "sizeChart", "manufacturer", "origin", "warranty", "batch", "expiryDate"]) out[field] = text(value[field] || "", field, 1000);
  if(value.careInstructions!==undefined&&(!Array.isArray(value.careInstructions)||value.careInstructions.length>12))fail("Provide up to twelve care instructions.");
  out.careInstructions = (value.careInstructions || []).map(v => text(v, "care instruction", 300));
  if (out.careInstructions.length > 12) fail("Too many care instructions.");
  out.specifications = value.specifications || {};
  if (Object.getPrototypeOf(out.specifications) !== Object.prototype || Object.keys(out.specifications).length > 30) fail("Check specifications.");
  out.specifications = Object.fromEntries(Object.entries(out.specifications).map(([k,v]) => [text(k, "specification", 80, 1), text(v, "specification value", 1000)]));
  out.shippingLeadDays = integer(value.shippingLeadDays ?? 0, "Shipping lead days", 0, 365);
  out.weightGrams = integer(value.weightGrams ?? 0, "Weight in grams", submit ? 1 : 0, 1000000);
  out.dimensionsCm = value.dimensionsCm || { length: 0, width: 0, height: 0 };
  object(out.dimensionsCm, ["length", "width", "height"], "Package dimensions");
  for (const n of ["length", "width", "height"]) integer(out.dimensionsCm[n], "Dimension in cm", submit ? 1 : 0, 1000);
  if (!["yes", "no", "unconfirmed"].includes(value.returnsEligible || "unconfirmed")) fail("Check returns eligibility.");
  out.returnsEligible = value.returnsEligible || "unconfirmed";
  out.returnWindowDays = integer(value.returnWindowDays ?? 7, "Purchased return window days", 1, 7);
  out.returnRequestTypes = value.returnRequestTypes || ["return", "exchange"];
  if (!Array.isArray(out.returnRequestTypes) || !out.returnRequestTypes.length || out.returnRequestTypes.length > 2 || out.returnRequestTypes.some(v => !["return", "exchange"].includes(v))) fail("Check return or exchange options.");
  out.returnConditions = text(value.returnConditions || "", "return conditions", 2000, submit ? 2 : 0);
  if (submit && out.returnsEligible === "unconfirmed") fail("Confirm the purchased returns policy before submission.");
  if (/protein|supplement|creatine|nutrition|fish oil|pre.?workout/i.test(out.category) && submit) {
    if (!out.batch || !/^\d{4}-\d{2}-\d{2}$/.test(out.expiryDate) || !Number.isFinite(new Date(out.expiryDate).getTime()) || new Date(out.expiryDate).toISOString().slice(0,10)!==out.expiryDate || new Date(out.expiryDate).getTime() <= Date.now()) fail("Supplements require batch and future expiry date.");
    if (!out.manufacturer || !out.origin) fail("Supplements require manufacturer and origin.");
  }
  if (!Array.isArray(value.variants) || !value.variants.length || value.variants.length > 100) fail("Provide one to 100 variants.");
  const seen = new Set(), skus = new Set();
  out.variants = value.variants.map(v => {
    object(v, ["size", "color", "supplierSku", "barcode", "supplierUnitAmount", "mrpUnitAmount", "stock", "supplierPromotionMaximumPaise", "promotionAgreement"], "Supplier variant");
    const row = { size: option(v.size, 50), color: option(v.color), supplierSku: text(v.supplierSku||"", "supplier SKU", 80, submit?1:0), barcode: text(v.barcode || "", "barcode", 60), supplierUnitAmount: integer(v.supplierUnitAmount, "Supplier unit paise", submit?1:0), mrpUnitAmount: v.mrpUnitAmount == null ? null : integer(v.mrpUnitAmount, "MRP paise", 1), stock: integer(v.stock, "Variant stock", 0, 1000000), supplierPromotionMaximumPaise: integer(v.supplierPromotionMaximumPaise || 0, "Agreed supplier promotion contribution", 0, v.supplierUnitAmount), promotionAgreement: text(v.promotionAgreement || "", "promotion agreement reference", 500) };
    if (row.supplierPromotionMaximumPaise && !row.promotionAgreement) fail("Supplier-funded promotions need explicit agreement reference.");
    if (seen.has(key(row)) || (row.supplierSku&&skus.has(row.supplierSku))) fail("Each variant and supplier SKU must be unique in this listing.");
    seen.add(key(row)); skus.add(row.supplierSku); return row;
  });
  if (new Set(out.variants.map(v => Boolean(v.size))).size > 1 || new Set(out.variants.map(v => Boolean(v.color))).size > 1) fail("Use consistent size and colour dimensions for all variants.");
  if (out.variants.reduce((n,v) => n+v.stock,0) > 1000000) fail("Combined stock exceeds 1,000,000.");
  return out;
}
function reviewPrices(d, input) {
  if (!Array.isArray(input) || input.length !== d.variants.length) fail("Price every submitted variant.");
  return d.variants.map(v => {
    const p = input.find(p => key(p) === key(v)); if (!p) fail("Price each variant exactly once.");
    object(p, ["size", "color", "customerUnitAmount", "taxRateBps", "lossBudgetUnitPaise", "lossReason"], "Admin price");
    const customer = integer(p.customerUnitAmount, "Customer unit paise", 1), loss = integer(p.lossBudgetUnitPaise || 0, "Approved unit loss budget", 0);
    const lossReason = text(p.lossReason || "", "platform-funded loss reason", 1000);
    if (loss && !lossReason) fail("An explicit audited reason is required for platform-funded losses.");
    if (customer + loss < v.supplierUnitAmount) fail("Customer price is below the protected supplier amount without sufficient loss approval.");
    if (v.mrpUnitAmount != null && customer > v.mrpUnitAmount) fail("Customer selling price exceeds MRP.");
    return { ...v, customerUnitAmount: customer, taxInclusive: true, taxRateBps: integer(p.taxRateBps, "Declared inclusive tax rate (basis points)", 0, 10000), lossBudgetUnitPaise: loss, lossReason };
  });
}
function allocateExact(total, weights) {
  integer(total, "Allocation", 0); weights.forEach(v => integer(v, "Allocation weight", 0));
  if (!weights.length) return [];
  const sum = weights.reduce((a,b) => a+b,0);
  if (!sum) return weights.map(() => 0);
  // Largest remainders with stable item order, all arithmetic exact in BigInt.
  const rows = weights.map((w,i) => ({ i, n: Number(BigInt(total)*BigInt(w)/BigInt(sum)), r: BigInt(total)*BigInt(w)%BigInt(sum) }));
  let left = total-rows.reduce((a,b)=>a+b.n,0);
  for (const row of [...rows].sort((a,b)=>a.r===b.r?a.i-b.i:a.r>b.r?-1:1)) { if (!left--) break; row.n++; }
  return rows.map(r=>r.n);
}
function lineFinance(variant, quantity, discount = 0) {
  integer(quantity, "Quantity", 1, 99); integer(discount, "Line discount", 0, variant.customerUnitAmount*quantity);
  const supplierFunded = Math.min(discount, variant.supplierPromotionMaximumPaise*quantity);
  const supplierPayable = variant.supplierUnitAmount*quantity-supplierFunded;
  const customerPaid = variant.customerUnitAmount*quantity-discount;
  const markup = customerPaid-supplierPayable;
  if (markup < -variant.lossBudgetUnitPaise*quantity) fail("This promotion would create an unapproved marketplace loss.",409,"MARKETPLACE_LOSS_NOT_APPROVED");
  const tax = Number((BigInt(customerPaid)*BigInt(variant.taxRateBps)+BigInt(Math.floor((10000+variant.taxRateBps)/2)))/BigInt(10000+variant.taxRateBps));
  return { supplierPayablePaise: supplierPayable, customerPaidPaise: customerPaid, discountPaise: discount, supplierFundedDiscountPaise: supplierFunded, platformFundedDiscountPaise: discount-supplierFunded, markupBeforeExpensesPaise: markup, taxIncludedPaise: tax };
}
function seal(value, keyHex, associatedData) {
  if (!/^[a-f\d]{64}$/i.test(keyHex || "")) fail("Private payment storage is not configured.",503,"MARKETPLACE_DATA_KEY_MISSING");
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm",Buffer.from(keyHex,"hex"),nonce);
  cipher.setAAD(Buffer.from(associatedData));
  return { nonce:nonce.toString("hex"), data:Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]).toString("base64"), tag:cipher.getAuthTag().toString("hex") };
}
function unseal(value, keyHex, associatedData) {
  if (!/^[a-f\d]{64}$/i.test(keyHex || "")) fail("Private payment storage is not configured.",503);
  const decipher=crypto.createDecipheriv("aes-256-gcm",Buffer.from(keyHex,"hex"),Buffer.from(value.nonce,"hex"));decipher.setAAD(Buffer.from(associatedData));decipher.setAuthTag(Buffer.from(value.tag,"hex"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,"base64")),decipher.final()]).toString());
}
function paymentDetails(value) {
  object(value,["accountHolder","accountNumber","ifsc","upiId"],"Payment details");
  const result={accountHolder:text(value.accountHolder,"account holder",150,2),accountNumber:text(value.accountNumber||"","account number",20),ifsc:text(value.ifsc||"","IFSC",11).toUpperCase(),upiId:text(value.upiId||"","UPI ID",150)};
  if (!result.accountNumber&&!result.upiId) fail("Provide bank details or a UPI ID.");
  if (result.accountNumber&&(!/^\d{8,20}$/.test(result.accountNumber)||!/^[A-Z]{4}0[A-Z\d]{6}$/.test(result.ifsc))) fail("Check account number and IFSC.");
  if (result.upiId&&!/^[a-z\d._-]{2,100}@[a-z\d.-]{2,50}$/i.test(result.upiId)) fail("Check UPI ID.");
  return result;
}
function maskPayment(d) { return {accountHolder:d.accountHolder,accountNumber:d.accountNumber?"••••"+d.accountNumber.slice(-4):"",ifsc:d.ifsc,upiId:d.upiId?d.upiId.slice(0,2)+"••••@"+d.upiId.split("@")[1]:""}; }
function csv(rows) { return rows.map(row=>row.map(v=>'"'+String(v??"").replace(/^(?:\s*[=+@\-]|[\t\r\n])/,"'$&").replaceAll('"','""')+'"').join(",")).join("\r\n"); }
module.exports = { fail, object, text, integer, id, digest, email, password, address, business, terms, key, image, draft, reviewPrices, allocateExact, lineFinance, seal, unseal, paymentDetails, maskPayment, csv, MAX };
