"use strict";

const Order = require("../../models/Order");
const { M, D, transaction, actorRequired } = require("./service");
const { supplierTarget } = require("./settlement");

function compareOrder(order, earnings, shipments, now) {
  const lines = [];
  const exceptions = [];
  const byIndex = new Map(earnings.map(row => [row.itemIndex, row]));
  const bySupplier = new Map(shipments.map(row => [String(row.supplier), row]));

  for (const [index, item] of order.items.entries()) {
    const purchase = item.marketplace;
    const earning = byIndex.get(index);
    if (!purchase) continue;
    byIndex.delete(index);
    const supplierId = String(purchase.accountId);
    const line = { itemIndex: index, supplierId, purchasedPayablePaise: purchase.supplierPayablePaise };
    lines.push(line);
    if (!earning || String(earning.supplier) !== supplierId ||
        earning.snapshot?.supplierPayablePaise !== purchase.supplierPayablePaise ||
        earning.snapshot?.quantity !== item.quantity || purchase.quantity !== item.quantity) {
      exceptions.push({ itemIndex: index, code: earning ? "ENTITLEMENT_MISMATCH" : "MISSING_ENTITLEMENT" });
      continue;
    }
    line.recorded = {
      eligiblePaise: earning.targetAmount, pendingPaise: earning.pendingAmount,
      reversedPaise: earning.reversedAmount, reservedPaise: earning.reservedAmount, paidPaise: earning.paidAmount,
    };
    const shipment = bySupplier.get(supplierId);
    if (!shipment?.itemIndices.includes(index)) {
      exceptions.push({ itemIndex: index, code: "SHIPMENT_MEMBERSHIP_MISSING" });
      continue;
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
        !Number.isSafeInteger(purchase.supplierPayablePaise) || purchase.supplierPayablePaise < 0 ||
        !Number.isSafeInteger(earning.snapshot.terms?.settlementHoldHours)) {
      exceptions.push({ itemIndex: index, code: "INVALID_SETTLEMENT_SNAPSHOT" });
      continue;
    }
    const target = supplierTarget(order, earning, shipment, now);
    line.calculated = {
      eligiblePaise: target.amount, pendingPaise: target.pending, reversedPaise: target.reversed, reason: target.reason,
    };
    if (target.amount !== earning.targetAmount || target.pending !== earning.pendingAmount || target.reversed !== earning.reversedAmount) {
      exceptions.push({ itemIndex: index, code: "BALANCE_RECONCILIATION_REQUIRED" });
    }
  }
  for (const itemIndex of byIndex.keys()) exceptions.push({ itemIndex, code: "UNMATCHED_ENTITLEMENT" });
  return { orderId: String(order._id), asOf: now.toISOString(), currency: "INR", lines, exceptions };
}

async function reviewOrder(actor, orderId) {
  actorRequired(actor, true);
  const id = D.id(orderId);
  return transaction(async session => {
    const order = await Order.findById(id)
      .select("_id items.quantity +items.marketplace pricing.finalTotal payment.status payment.amountsReconciled payment.grossCollected payment.amountPaid payment.amountDue delivery.deliveredAt status returnRequest.type returnRequest.status returnRequest.items refund.status marketplaceResolutions.customerCreditPaise")
      .session(session).lean();
    if (!order) D.fail("Order not found.", 404);
    const earnings = await M.Entitlement.find({ order: id }).session(session).lean();
    const shipments = await M.Fulfilment.find({ order: id }).select("supplier itemIndices status deliveredAt").session(session).lean();
    return { review: compareOrder(order, earnings, shipments, new Date()) };
  });
}

module.exports = { reviewOrder, compareOrder };
