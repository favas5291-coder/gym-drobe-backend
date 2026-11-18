"use strict";
const mongoose = require("mongoose");
const { D, M, account } = require("./service");

const OPEN = ["pending", "accepted", "preparing"];
const PAGE = 50;
const DAY = 86400000;
const clock = "elapsed-days-from-payment-verification";

function itemDueAt(item, accountId, verifiedAt) {
  const snapshot = item?.marketplace;
  const terms = snapshot?.terms;
  if (snapshot?.accountId !== accountId || terms?.dispatchClock !== clock ||
      !Number.isSafeInteger(terms.dispatchDaysMax) || terms.dispatchDaysMax < 0 || terms.dispatchDaysMax > 365 ||
      snapshot.termsDigest !== D.digest(terms) || !(verifiedAt instanceof Date) ||
      !Number.isFinite(verifiedAt.getTime())) return null;
  return verifiedAt.getTime() + terms.dispatchDaysMax * DAY;
}

function reviewGroup(group, order, now) {
  if (!["confirmed","processing"].includes(order.status) ||
      !["paid","partially-paid","partially-refunded"].includes(order.payment?.status)) return null;
  const result = { fulfilmentId: String(group._id), orderId: String(group.order),
    status: group.status, timing: "unknown", dueAt: null, unknownItems: 0 };
  const indices = group.itemIndices;
  if (!Array.isArray(indices) || !indices.length || new Set(indices).size !== indices.length) return result;
  let actionable = 0, earliest = Infinity;
  for (const index of indices) {
    const item = order.items?.[index];
    if (!Number.isSafeInteger(index) || index < 0 || !item || !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0 || item.marketplace?.accountId !== String(group.supplier)) {
      result.unknownItems++;
      continue;
    }
    const cancellations = (order.marketplaceResolutions || []).filter(r => r.kind === "cancellation" && r.itemIndex === index);
    if (cancellations.some(r => !Number.isSafeInteger(r.quantity) || r.quantity < 1)) {
      result.unknownItems++;
      continue;
    }
    const cancelled = cancellations.reduce((n,r) => n + r.quantity,0);
    if (cancelled > item.quantity) { result.unknownItems++; continue; }
    if (cancelled === item.quantity) continue;
    actionable++;
    const due = itemDueAt(item, String(group.supplier), order.payment.verifiedAt);
    if (due === null || !(order.payment.verifiedAt <= now)) result.unknownItems++;
    else earliest = Math.min(earliest,due);
  }
  if (!actionable && !result.unknownItems) return null;
  if (Number.isFinite(earliest)) {
    result.dueAt = new Date(earliest).toISOString();
    if (now.getTime() > earliest) result.timing = "overdue";
    else if (!result.unknownItems) result.timing = "within-window";
  }
  return result;
}

async function dispatchReview(actor, query, now = new Date()) {
  D.object(query, ["supplier","after","source"], "Dispatch review");
  if (query.source !== undefined && !["real","test"].includes(query.source)) D.fail("Choose real or test orders.");
  if (query.supplier !== undefined && typeof query.supplier !== "string") D.fail("Invalid supplier.");
  if (query.after !== undefined && typeof query.after !== "string") D.fail("Invalid page cursor.");
  const source = query.source || "real";
  const after = query.after === undefined ? null : new mongoose.Types.ObjectId(D.id(query.after));
  const supplier = await account(actor,query.supplier,null,true);
  const match = { supplier: supplier._id, status: { $in: OPEN } };
  if (after) match._id = { $gt: after };
  let groups;
  try {
    groups = await M.Fulfilment.aggregate([
      { $match: match }, { $sort: { _id: 1 } }, { $limit: PAGE + 1 },
      { $project: { order:1, supplier:1, status:1, itemIndices:1 } },
      { $lookup: { from: "orders", localField: "order", foreignField: "_id", let: { accountId: { $toString: "$supplier" } }, as: "purchase", pipeline: [
        { $match: { "metadata.demo": source === "test" } },
        { $project: { _id:0, status:1, "payment.verifiedAt":1, "payment.status":1,
          items: { $map: { input: { $ifNull:["$items",[]] }, as:"item", in:{ $cond:[
            { $eq:["$$item.marketplace.accountId","$$accountId"] },
            { quantity:"$$item.quantity", marketplace:{ accountId:"$$item.marketplace.accountId",
              termsDigest:"$$item.marketplace.termsDigest", terms:"$$item.marketplace.terms" } }, null,
          ] } } },
          "marketplaceResolutions.itemIndex":1, "marketplaceResolutions.kind":1, "marketplaceResolutions.quantity":1 } },
      ] } },
    ]).hint({supplier:1,status:1,_id:1}).option({maxTimeMS:5000,allowDiskUse:false});
  } catch (error) {
    if (error.code === 50 || error.code === 2) D.fail("The dispatch review is unavailable. Verify its staging index and retry.",503,"DISPATCH_REVIEW_UNAVAILABLE");
    throw error;
  }
  const rows = [];
  for (const g of groups.slice(0,PAGE)) {
    if (g.purchase.length !== 1) continue;
    const row = reviewGroup(g,g.purchase[0],now);
    if (row) rows.push(row);
  }
  return { source, generatedAt:now.toISOString(), rows,
    nextCursor:groups.length > PAGE ? String(groups[PAGE-1]._id) : null };
}
module.exports = { dispatchReview, reviewGroup };
