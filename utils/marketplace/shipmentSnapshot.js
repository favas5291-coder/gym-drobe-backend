"use strict";

// Only customer-facing package facts belong on the order mirror.
const { safeCourierUrl } = require("../courierTracking");

function shipmentSnapshot(group) {
  return {
    key: String(group._id),
    itemIndices: group.itemIndices,
    status: group.status,
    publicFulfilmentName: group.publicFulfilmentName || undefined,
    carrier: group.carrier || "",
    trackingNumber: group.trackingNumber || "",
    trackingUrl: safeCourierUrl(group.trackingUrl),
    shippedAt: group.shippedAt || null,
    outForDeliveryAt: group.outForDeliveryAt || null,
    deliveredAt: group.deliveredAt || null,
    estimatedDeliveryAt: group.estimatedDeliveryAt || null,
    estimateChanges: group.estimateChanges,
  };
}

module.exports = { shipmentSnapshot };
