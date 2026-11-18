# Daily operations report

The existing admin dashboard serves recent sales and customer details. The marketplace financial endpoint refreshes eligibility before returning balances. This admin-only read-only endpoint instead returns a single IST order cohort, without customer or supplier identifiers, external calls or ledger writes.

Request `GET /api/admin/reports/daily-operations?date=2024-02-29&source=real` with an active admin session. Omit date for today. Source is precisely `metadata.demo=false` for real and `true` for test. Older rows without an explicit source flag are excluded. Legacy accounts without an admin role cannot run the report. Access is shared with authorised admins; the current app has no separate owner role.

An order belongs to the local calendar date on which it was created. Its payment and parcel statuses are read at report generation time. Later refunds change the same cohort. For cash received on a particular transaction or remittance date, use a statement-based reconciliation workflow.

| Field | Meaning |
|---|---|
| orders | Counts all included orders and separates currently confirmed (including shipped/delivered), cancelled, payment-pending and unknown statuses. |
| confirmedOrderValue | Original final checkout amounts of currently confirmed INR orders, including charges. Completed cancellations are excluded. Returns do not rewrite the original price. |
| grossCollections, refunds | Recorded gross customer collection and recorded completed refund totals from explicitly reconciled INR payment data, including cancelled orders. |
| codRecordedCollections | Recorded gross customer money for COD methods, including historical advances. A completed courier remittance requires separate bank/courier evidence. |
| codOutstanding | Recorded amount still due from customers on currently confirmed COD orders. |
| fulfilments | Counts stored marketplace supplier fulfilment records for the cohort. An admin-owned line may have none. These are supplier task statuses, independent of carrier tracking. |
| netProfitPaise | Null. Real gateway fees, remittance data, taxes and complete expense allocation cannot be established from these records. |

Each monetary field reports `knownPaise`, `knownOrders` and `unknownOrders`. If unknownOrders exceeds zero, label the value as a partial subtotal. A missing currency, unreconciled transaction or absent amount cannot silently count as a verified zero.

**Staging setup and rollout.** On a disposable/approved staging DB, create the supporting index on orders: `db.orders.createIndex({"metadata.demo":1,createdAt:1})`. The marketplace model already declares a unique index on `{order:1,supplier:1}` for the join; verify it if marketplace fulfilments exist. The report requires the orders index with a query hint and caps the read at 5 seconds and 5,000 orders per cohort. A missing index, timeout or excess daily volume returns 503 instead of a partial result. Empty cohorts return 200 with zero counts. No index or migration is executed during API startup by this change. Production index creation requires a separate approved change and resource check.

Run `npm test` and, on an isolated MongoDB with a loopback fixture URI, `node tests/integration/daily-operations.cjs`. Verify invalid date (400), signed-out (401), customer/supplier (403), real/test date isolation and a large cohort in staging. An authenticated protected endpoint uses private no-store responses via the existing admin router. When rolling back the API the additive index can remain in place until a separately approved maintenance operation.
