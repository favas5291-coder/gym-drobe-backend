# Supplier settlement audit

Source examined: backend main e07fb781cfa4686e8945f3c52fcd9227df3c0e11.

| Finding | Evidence | Decision |
| --- | --- | --- |
| Order creation snapshots the supplier payable in paise and creates an entitlement, pending ledger entry and supplier shipment in one transaction. | models/Order.js, models/Marketplace.js, utils/marketplace/settlement.js | Reuse these records. |
| Earnings reconciliation, reservation and recording an external transfer already exist. The existing GET admin reporting path calls earnings, which can append eligibility adjustments. | utils/marketplace/settlement.js, routes/marketplaceRoutes.js | Supply a separate order-scoped read-only review for the owner. |
| Eligibility can combine a delivered order with a pending supplier shipment or substitute the order timestamp for a shipment with no delivery date. | supplierTarget in utils/marketplace/settlement.js | Require the shipment's own delivery evidence whenever it exists. A missing expected shipment needs review. |
| Historical purchases without a recorded return window use seven days for returns but zero days in supplier eligibility. | utils/returnPolicy.js, supplierTarget | Apply the same historical fallback. |
| Ledger records and payout history are append-only accounting evidence. Reconciliation records gross customer collection but does not independently confirm courier-to-platform remittance. | models/Marketplace.js, utils/marketplace/resolution.js | Courier and gateway statement reconciliation require a separately configured evidence source. |

## Owner review

GET /api/marketplace/admin/orders/:id/settlement-review uses the existing authenticated marketplace admin role. Supply the order database ID. The response uses integer paise. The endpoint reads one order, its purchased entitlements and its fulfilment groups together. It shows each recorded balance and its current calculated eligibility, including holds and differences that require review. These observations never book a payout or refresh a ledger.

A reviewer can inspect a discrepancy before running an existing explicit supplier reconciliation. Missing entitlements and shipments require record review. Historical transfers remain available for audit. The existing marketplace feature and transaction-capable database are prerequisites. No new indexes, provider credentials or subscriptions are required.
