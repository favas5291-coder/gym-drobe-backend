# Payment staging configuration and acceptance

This prepares the next launch gate. It does not establish that payment staging,
provider authentication, database isolation or an end-to-end order has passed.
Do not substitute a configuration pass for the acceptance evidence below.

The review source is `codex/gymdrobe-payment-staging`, stacked on the notification
foundation. Use that reviewed source for the separate staging service. These
commands are not available on `main` until the changes are reviewed and merged.

## Configure an isolated service

1. Use a separate staging service and an empty dedicated database with restricted
   credentials. Do not clone customer, payment, notification or marketing data.
   Use an operator-confirmed replica set suitable for transactions. A database
   name alone cannot prove permissions, isolation or transaction support.
2. Copy `.env.staging.example` to the ignored `.env.staging`, or configure the
   equivalent variables privately on that staging service. Set
   `GYMDROBE_ENV=staging` and `GYMDROBE_STAGING_DATABASE=gymdrobe_staging_<name>`.
   The database selected in `MONGO_URI` must match that declared name exactly.
   `NODE_ENV=production` is valid for a staging host; it does not select this guard.
3. Generate a dedicated staging JWT secret. Configure the Razorpay **Test Mode**
   key pair and a separate test webhook secret privately. This check recognizes
   key format/placeholders; it cannot authenticate a key or determine which
   account owns it. Never paste credentials into chat or commit them.
4. Use a staging HTTPS frontend origin or loopback HTTP origin. Known GymDrobe
   production origins are blocked. Confirm the ownership and deployment yourself;
   a different hostname does not prove that a site is staging.
5. Leave Gmail credentials and the Meta CAPI token empty, and push registration
   and delivery disabled for this payment test. This is a payment-only staging
   profile. A later notification test needs a separately reviewed configuration.

## Check before starting

From the backend directory:

```sh
npm ci --ignore-scripts
npm run staging:check -- --staging-env .env.staging
```

On a staging host with environment variables already configured:

```sh
npm run staging:check
```

The command returns exit 1 and `blocked` if configuration is missing/unsafe, or
exit 0 and `configuration-passed` for consistent configuration. It only reads
configuration and parses the Mongo URI using the installed driver. It makes no
network requests, connects to no database, writes no records and calls no
payment/refund/message provider. Its output contains fixed check IDs and guidance,
never supplied keys, tokens, addresses or URI values.

Existing process environment values take precedence over a selected file, matching
the server's dotenv behavior. A private file cannot quietly override an inherited
live key. The command does not start the backend or configure its deployment.

The real server also checks its final environment **after** dotenv loads and
**before** connecting to MongoDB, creating indexes, listening or starting workers
when `GYMDROBE_ENV=staging`. Unrecognized nonempty `GYMDROBE_ENV` values are blocked
to catch typos. Unset, production, development and test modes retain their existing
startup behavior. This does not establish that production configuration is safe.

Use only an isolated service, with the same reviewed environment, to start the
staging backend. It creates indexes and may initialize disabled defaults after
the guard passes. Do not run the backend against production for this check.

## Verify the actual payment/order journey

Once configuration and the specific controlled test are approved:

| Case | Required evidence |
| --- | --- |
| Database readiness | Dedicated credentials/database, replica-set support, required indexes and permissions; no customer data or live outbound configuration. |
| Catalogue and checkout | Synthetic customer/address, controlled SKU/variant stock, server-owned pricing/discount/shipping and correct final quote. |
| Provider authentication | Actual test key authentication in the separate staging integration; not a format check. |
| Repeated payment start | Repeated taps/retries use the intended order/attempt; no duplicate order, inventory decrement or provider side effect. |
| Success/failure/cancellation | Authoritative provider result reconciles correctly; an uncertain payment is not mislabeled failed or paid. |
| Interrupted callback | Reopen the app/browser and reconcile provider state without blindly paying again. |
| Webhooks | Correct test endpoint/secret; reject invalid signatures; replay/out-of-order events without duplicate financial or inventory effects. |
| COD advance | Exact discounted-merchandise advance, remaining balance and eligibility; no duplicate payment start. |
| Refund | Eligible purchased-policy amount, partial allocation and repeated callback; preserve pending/uncertain states until verified. |
| Account/device | Browser and physical-phone login, account isolation, bag/checkout persistence and interrupted-payment recovery. |

Retain the source SHA, staging deployment, test time, case, expected/actual result
and redacted provider identifiers. Never attach credentials, customer information
or real payment screenshots. Supplier handoff, physical delivery and customer
messages are separate operations requiring their own confirmations/authorization.

No command in this document automatically places an order, captures a payment,
issues a refund, sends a message, deploys production or submits an app.

## References

- [Razorpay: Test and Live modes](https://github.com/razorpay/markdown-docs/blob/master/payments/dashboard/test-live-modes.md)
- [Razorpay: API keys](https://github.com/razorpay/markdown-docs/blob/master/payments/dashboard/account-settings/api-keys.md)
- [MongoDB: create a MongoClient](https://www.mongodb.com/docs/drivers/node/current/connect/mongoclient/)
