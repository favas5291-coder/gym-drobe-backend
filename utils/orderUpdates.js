"use strict";

const { createHash } = require("node:crypto");
const digest = value => createHash("sha256").update(value).digest("hex");

function orderUpdates(order) {
  if (order.status === "payment-pending") return [];
  const updates = new Map();
  const number = order.orderNumber;
  const shipments = order.supplierShipments || [];
  const names = new Set(shipments.map(row => row.publicFulfilmentName).filter(Boolean));
  const assigned = new Set(shipments.flatMap(row => row.itemIndices || []));
  const partner = names.size === 1 && shipments.length === 1 &&
    shipments.every(row => row.publicFulfilmentName) && assigned.size === order.items?.length
    ? [...names][0] : "";
  const messages = {
    confirmed: partner
      ? `Your GymDrobe order #${number} is confirmed. Our fulfilment partner ${partner} will prepare and ship your order. We’ll keep you updated.`
      : `Your GymDrobe order #${number} is confirmed. See your order details for confirmed package assignments.`,
    shipped: `Your GymDrobe order #${number} has shipped.`,
    "out-for-delivery": `Your GymDrobe order #${number} is out for delivery.`,
    delivered: `Your GymDrobe order #${number} was marked delivered.`,
    cancelled: `Your GymDrobe order #${number} was cancelled.`,
    refunded: `A refund for your GymDrobe order #${number} was recorded.`,
    "estimate-changed": `The estimated delivery for your GymDrobe order #${number} has changed. Check tracking for the latest date.`,
  };
  function add(kind, time, message, packageKey = "", identity = "") {
    const at = time && new Date(time);
    if (!at || !Number.isFinite(+at) || +at > Date.now() + 60000 || !message) return;
    const id = digest(JSON.stringify([number, kind, packageKey, identity]));
    updates.set(id, { id, kind, at, message, ...(packageKey ? { packageKey } : {}) });
  }

  for (const event of order.tracking?.events || []) {
    if (!Object.hasOwn(messages, event.status)) continue;
    if (shipments.length && ["shipped", "out-for-delivery", "delivered"].includes(event.status) &&
        assigned.size === order.items?.length) continue;
    const identity = event.status === "estimate-changed" ? event.timestamp : "";
    add(event.status, event.timestamp, messages[event.status], "", identity);
  }
  add("cancelled", order.cancellation?.cancelledAt, messages.cancelled);
  if (order.refund?.status === "refunded") add("refunded", order.refund.refundedAt, messages.refunded);
  for (const row of order.marketplaceResolutions || []) {
    if (row.kind === "cancellation") add("item-cancelled", row.createdAt, `An item from your GymDrobe order #${number} was cancelled.`, "", row.key);
    if (row.status === "refunded") add("refunded", row.refundedAt, messages.refunded, "", row.key);
  }
  for (const row of shipments) {
    const label = `A package from your GymDrobe order #${number}`;
    const courier = row.carrier ? ` via ${row.carrier}` : "";
    const shipped = row.publicFulfilmentName
      ? `${row.publicFulfilmentName} has shipped a package from your GymDrobe order #${number}${courier}.`
      : `${label} has shipped${courier}.`;
    add("shipped", row.shippedAt, shipped, row.key);
    add("out-for-delivery", row.outForDeliveryAt, `${label} is out for delivery.`, row.key);
    add("delivered", row.deliveredAt, `${label} was marked delivered.`, row.key);
    for (const change of row.estimateChanges || []) {
      const date = new Date(change.estimatedDeliveryAt);
      if (Number.isFinite(+date)) add("estimate-changed", change.at,
        `${label} is now estimated to arrive on ${date.toISOString().slice(0, 10)}.`, row.key, change.at);
    }
  }
  return [...updates.values()].sort((a, b) => +b.at - +a.at || a.id.localeCompare(b.id));
}

module.exports = { digest, orderUpdates };
