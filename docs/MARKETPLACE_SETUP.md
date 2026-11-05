# GymDrobe supplier marketplace setup and release

This extends the existing Express/Mongoose API, Supplier/User identity, Product catalogue, Order checkout/stock and React/Capacitor clients. No new hosted service, queue, payout provider or subscription is provisioned. Sharp is loaded only for an upload; MongoDB stores bounded compressed images. Existing products have no supplier ownership assigned by this change.

## Flags and prerequisites

Backend: `MARKETPLACE_ENABLED=false` (default). Frontend: `VITE_MARKETPLACE_ENABLED=false` (default, rebuild required to change). Keep the older `SUPPLIER_PORTAL_ENABLED` and `VITE_SUPPLIER_PORTAL_ENABLED` disabled when using this replacement; do not run two independent commercial agreements for the same supplier.

When disabled the API returns 404/no-store. Marketplace products cannot be purchased through a disabled API. The existing catalogue, customer Google login, cart and five-destination navigation continue normally.

Before enabling in an isolated staging environment:

1. Reuse the existing MongoDB replica set with transactions, unique-index privileges and sufficient storage. Do not use a standalone database or purchase an upgrade. Confirm any existing free hosting limits in the actual account.
2. Set a **new private** `MARKETPLACE_DATA_KEY` to 64 hexadecimal characters in the existing backend secret manager. Generate it once with the command in `.env.marketplace.example`. Back it up through the owner's secure process. Never place it in Vite, source control, an invitation or chat. Losing it makes encrypted payment destinations unreadable. Rotation requires a deliberate decrypt/re-encrypt migration; do not replace it casually.
3. Preserve existing `MONGO_URI` and `JWT_SECRET`. Optional `MARKETPLACE_PUBLIC_API_ORIGIN` must be the existing HTTPS API origin. Review CORS against the approved clients before activation: the existing server currently uses general cors(). Bearer-token authorization remains mandatory; CORS is not an authorization mechanism.
4. Run `node scripts/marketplace-audit.cjs` using the securely configured staging environment. It prints aggregate counts/record IDs, never bank values/passwords. It is read-only and disables automatic Mongoose collection/index creation on connection.
5. Review any reported orphan accounts or inconsistent accepted terms. Run `node scripts/marketplace-audit.cjs --initialize` only after review. This creates supporting unique indexes and missing image quota rows. It does not map old products/orders to a supplier, alter their stock, approve terms, send an invitation or turn on the marketplace. Startup also requires the enabled feature's indexes/key/replica set before accepting traffic.
6. Enable backend and frontend flags in staging, rebuild the existing web/native clients and follow the synthetic acceptance steps below. No paid staging service is required for CI: the workflows use disposable loopback MongoDB containers.
7. Obtain actual supplier identity, rights, agreed amounts, tax-inclusive price/tax declaration, physical stock, settlement/dispatch responsibilities, verified destination and owner acceptance. Confirm courier and returns responsibilities. A blank business fact is not an agreement.
8. Complete actual Razorpay test-mode acceptance using secure staging keys and real devices. CI's gateway is a synthetic SDK boundary, not a real provider test. No real transfer, refund, supplier/customer message or shipment is allowed as a test.

Only then enable production during a monitored release. No supplier has been created, accepted or paid in production by the test suite. Production activation is a separate operational step from deploying disabled source.

## Monetary and payout contract

All marketplace monetary values are integer paise. Supplier submitted `supplierUnitAmount` and admin `customerUnitAmount` are separate, tax-inclusive amounts; admin declares the included rate. Supplier ₹500/customer ₹550 produces ₹500 supplier obligation and ₹50 markup **before expenses**. The markup is not profit and is not reduced by an assumed tax/fee rate. Actual tax liabilities and fees require reconciliation/professional review.

A supplier promotion cap defaults to zero. Only a submitted explicit cap/agreement permits supplier-funded discounts. Platform-funded coupons preserve supplier amounts; an admin must explicitly approve and audit sufficient per-unit platform loss budget before any below-cost sale. Admin can preview the actual server coupon effect before publication. Customer totals, variants, stock and payment confirmation remain backend-authoritative.

Earnings are pending until full collection is reconciled, delivery is confirmed and the later of the purchased return window and agreed settlement hold has elapsed. The current project supports purchased windows of 1–7 days; its default is seven days. A COD advance never unlocks full earnings. No commission, automatic tax deduction or settlement duration is invented.

Reservations serialize on the supplier account and use unique idempotency keys. Each payout stores its verified destination version, item amounts and any explicit prior-recovery offsets. Recording an external transfer requires its actual reference/date/full amount confirmation. **No banking API is called.** A completed payout is never edited to hide a subsequent return. Recoverable balances are itemized against future earnings; cancelling a reservation releases both cash reservations and its recovery offsets. If recovery consumes every selected item, select sufficient further eligible items for a positive payout; there is no zero-value bank-transfer record.

## Item resolutions and operational limits

Existing full-order cancellation and the purchased return/exchange workflow remain available for orders without marketplace item resolutions. For a mixed-supplier order, admin can resolve an undispatched item or record an inspected return quantity, calculate the exact purchased refund (including saved discounts/rounding), optionally restore verified reserved stock, then separately record an already completed external refund. Multiple partial quantities have offsets so the same unit/paise cannot be refunded twice. Supplier amount reversals and post-payout recovery are explicit.

A verified, reconciled COD advance supports item cancellation: the exact purchased cancellation credit first reduces unpaid merchandise, and only excess actual collection becomes a customer refund obligation. Admin records any externally collected remaining balance separately with its actual reference, date and evidence; this never collects money. Returns require completed collection. Whole-order and item-resolution paths cannot overlap, preventing duplicate restocking/refunds. Once item resolution exists, remaining quantities use the admin item controls and customer support instead of a second whole-order request.

Returns through the admin item controls require actual receipt/inspection evidence; the admin is responsible for the purchased policy and any recorded exception. Financial snapshots are immutable. External refund records are reconciliation actions; the dashboard does not execute refunds or independently confirm provider/bank references. Provider automation for those records is deferred.

## Images, privacy and costs

- Picker accepts JPEG/PNG/WebP, reduces to 1280px before upload; server validates MIME versus decoded type, single frame, dimensions/pixel count and byte limit, then strips metadata by WebP re-encoding.
- Server input max512KiB, output max480KiB, 12MP decode limit, one decoder at a time. Application quotas: 8MiB per owner, 64MiB global including thumbnails. These caps do not guarantee the database provider has that space; verify account usage first.
- Draft product images and payout proofs require the owner/admin token; active published product images are public. Another supplier's upload cannot be submitted or published by changing an ID. Unused uploads can be deleted through the API; referenced live/history/proof assets are protected. Supplier uploads are catalogue/business records, not temporary customer photo searches.
- Bank/UPI values use AES-256-GCM with supplier/version-bound associated data; normal views are masked. Changes and admin reveal require reauthentication; reveal is audited. No private API response enters the service-worker cache. Browser auth tokens use the existing project mechanism.
- Process-local rate limits fit the existing single-instance deployment. A future multi-instance deployment needs shared enforcement; do not claim distributed limits.
- Photo Search, Virtual Try-On, push sending and automated payout integrations remain independently disabled/deferred. No provider credentials or paid calls were added.

## Verification and rollback

`npm run check` covers syntax/imports plus existing and marketplace financial/security tests. Backend `.github/workflows/marketplace.yml` starts disposable MongoDB8 replica set and runs `tests/integration/marketplace-mongo.cjs` through actual JWT/HTTP routes and transactions. The test-only `tests/helpers/marketplaceGateway.cjs` replaces the payment SDK with an in-memory synthetic boundary and refuses real refund execution. It is never imported from production source.

Frontend `.github/workflows/marketplace-review.yml` pins the paired backend SHA and runs actual React forms/JWT/database flows in Chromium/WebKit with screenshots at representative widths. Existing storefront/PWA/performance/Android/iPhone workflows remain mandatory. A CI test fixture advances its own delivery clock by eight days; no production hold is shortened.

For emergency pause, disable new supplier activity by admin suspension (hides products; preserves existing order/resolution access). Disabling the backend flag stops all supplier APIs, so retain the tested release for existing operational history and arrange a maintenance/reconciliation window before global shutdown. Hide the frontend portal via its flag/rebuild. Do not downgrade the backend while marketplace orders remain operational; older code cannot understand their variant prices, groups or private settlement snapshots. Never drop ledger/payout/destination collections or rewrite historical orders to roll back a deployment. Use a forward repair for existing records.
