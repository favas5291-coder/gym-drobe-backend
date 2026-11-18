# Marketplace order reconciliation

## Audit before implementation

At base HEAD, Order pre-save delegates marketplace orders to initializeOrder inside the existing MongoDB transaction. The initializer verifies eligible supplier accounts, creates a fulfilment per supplier, and records one entitlement and pending ledger entry per supplier item. An isolated Meta marketing worker already has its own leases, retries and consent rules. It serves a different purpose and may be disabled independently. Admin APIs already enforce protect and adminOnly. There is no general commerce job record for auditing whether these supplier allocations persisted as expected. A new shopper-facing API, secondary financial ledger or external queue is unnecessary for this check.

## First workflow

Emit order.fulfilment.check.v1 in the same database transaction as marketplace order creation. The checkout either commits the order, allocations and outbox document together, or aborts. One job per order and version compares each marketplace item’s supplier and payable snapshot against its immutable entitlement and shipment membership. The action is read-only. A mismatch stops for admin review instead of guessing a repair. Read transient failures retry with bounded backoff. A lease token fences late completions. Replaying a check cannot create a shipment, charge, refund or supplier payout. Use the admin API to check an older marketplace order on demand.

One new MongoDB collection with bounded job history is required. Both switches default off. Enabling AUTOMATION_ENGINE_ENABLED requires the transactional marketplace. Before enabling in production, review the new collection and its indexes, backup policy, expected storage and the extra write per marketplace checkout. AUTOMATION_WORKER_ENABLED additionally enables a timer in the active API process. It does not guarantee processing while a free host sleeps. Use Process pending jobs in the admin dashboard for manual drain. Disabling the worker leaves pending jobs intact. Disable the engine as well to stop new inserts.

## Administration

Use the existing authenticated admin API. GET /api/admin/automation returns status counts, the most recent successful completion time, a page of up to 25 redacted jobs, and the next cursor. Optional status and before filters use the five workflow states and a MongoDB object ID. POST /api/admin/automation/process drains at most ten eligible jobs. POST /api/admin/automation/jobs/:id/retry requeues an exhausted or review-needed job after an operator has corrected its underlying records through an authorized normal workflow. POST /api/admin/automation/orders/:id/reconcile queues a historical order or rechecks a completed job. Actions are recorded on each job. Seller and customer tokens have no access.

Review codes: ORDER_MISSING, SUPPLIER_SNAPSHOT_INVALID, FULFILMENT_MISMATCH, ENTITLEMENT_MISMATCH. Inspect the order, fulfilment records and entitlement snapshots before retrying. RETRYABLE_READ_FAILURE and LEASE_EXHAUSTED can be retried after database availability has been restored. lastSuccessAt may be null on a new installation. workerEnabled describes configuration, not a heartbeat.

Production enablement, migrations and provider actions require separate authorization. No external services or extra recurring charges are enabled by this change.

Verification on base e07fb78: 147 backend tests passed and 36 isolated MongoDB 7 replica-set/HTTP acceptance checks passed, including a two-supplier purchase transaction, job deduplication and rollback, denied customer access, lease recovery, bounded retries, terminal status and an administrator replay. The worker batches at most ten jobs per 30-second tick per API process. Each check reads only the order and two indexed order-scoped collections. No customer traffic or production latency measurement was used.
