# Commerce database readiness

The server now awaits the User, Order and GuestCheckoutSession indexes before
opening its HTTP listener, alongside the other required collections. This applies
when Apple sign-in is disabled too. Identity uniqueness, checkout-token uniqueness
and guest-token uniqueness/expiry must not depend on background index creation.

Order creation already calls `Order.init()`; this change establishes readiness
before all HTTP traffic rather than claiming a duplicate charge was observed.
PaymentAttempt uses MongoDB's intrinsic unique `_id` for each order's creation
attempt. No payment-provider call, stock, order or customer record is changed.

Four tests execute the actual server bootstrap with controlled dependencies:
each of the three pending collections keeps the listener closed, and a failed
Order index prevents startup. All four fail against the prior bootstrap and
pass after the change. `npm run check` passes all 120 backend tests, including
payment, checkout, account and supplier regressions. These are isolated tests;
they do not replace database/provider staging verification.

Before deployment, use a staging replica set to verify index permissions,
existing-data compatibility, startup success and failure, concurrent checkout
retries and the existing test-mode payment/webhook flow. Missing staging
MongoDB/Razorpay credentials are the exact current integration-test dependency.
Do not use real payment methods or modify production records for this check.

Deploy only the reviewed backend revision after staging passes. Monitor readiness
and payment-recovery errors. A failed required index intentionally blocks the
listener; investigate its cause without deleting records or dropping constraints.
Rollback means redeploying the previous reviewed server revision. It does not
require dropping indexes, rewriting orders, resending webhooks or issuing refunds.
