# Automation pilot acceptance and pending work

19 November 2026. All changes described here are in review. No staged or production rollout, carrier booking, real payment, message or payout was performed as part of this pilot.

[Reproducible two-supplier test and review snapshot in backend PR #35](https://github.com/favas5291-coder/gym-drobe-backend/pull/35). The local backend check with the additional fixture-shipping, worker health, staged metadata, catalogue quality, dispatch and CRM branches passed all 184 tests. The tested [extended backend snapshot](https://github.com/favas5291-coder/gym-drobe-backend/commit/d32a6084d879910752ceacdc372d64c507a5cf38) preserves the resolutions that keep each database test in CI. The after-sales inbox is a separate stack on backend #16.

## Two-supplier order

| Step | Expected result | Observed fixture evidence |
| --- | --- | --- |
| Guest checkout | Accept ₹0 upfront and hold purchased stock once | ₹1,100 for two ₹550 items. Each SKU went from 10 to 9. A repeated confirmation left one order, two supplier fulfilments, two entitlements and one queued check. |
| Worker | Reconcile the committed supplier split without manual drain | Actual periodic worker processed the queued job once. Admin review showed completion. A separate browser/DB drill recovered a deliberately missing fulfilment through the owner retry control. |
| Delivery and collection | Separate parcel state, actual collection and payout eligibility | One delivered parcel, one shipped. Recording a synthetic full-order receipt twice left one ₹1,100 collection. Before the return, both supplier amounts were ₹500 pending, with different hold reasons. The statement preview matched ₹1,090 net plus a ₹10 fee against ₹1,100 recorded. |
| Partial return | Accept only the eligible purchased line, require inspection, restore only that line | The shipped line was rejected. The returned line restored one unit (two SKU balances 10 and 9). Repeating the decision left one resolution and reversed ₹500 for that supplier. The other supplier's full financial-review line stayed identical. |
| Refund and owner report | Record external evidence once and preserve unknown costs | Before a refund receipt, refunded was ₹0. After the fixture receipt and replay, gross was ₹1,100, refund ₹550, retained ₹550 and COD due ₹0. The other supplier had ₹500 pending, ₹0 eligible. There were no payouts or payment gateway calls and net profit remained unknown. |

MongoDB 7.0.22, Mongoose 9.11.4, Node 24.22.3, Express and the real worker and marketplace routes were used with synthetic identities and purchased terms. The standalone fixture removes inherited credentials and blocks payment-provider instantiation. It uses a fresh loopback replica set and a randomly named database. Courier events and external receipts are synthetic. Delivery and inspection decisions are authenticated operator actions. This verifies application accounting; provider booking, bank settlement and real refund execution remain external acceptance gates.

After-sales testing exposed a delivered parcel incorrectly classified as cancelled following a return. [Backend #34](https://github.com/favas5291-coder/gym-drobe-backend/pull/34) preserves the delivery timestamp and history. A fresh integration run counted one delivered, one shipped and zero cancelled after the refund. A separate pre-dispatch fixture still cancelled a fully cancelled parcel. Historical production records were not read or rewritten.

The corrected combined fixture also passed in hosted CI on MongoDB 8. Both the complete marketplace workflow and backend regression workflow passed for test PR head `79345f5e3c986d3178f8cc502d7ba5fd6f2db05e`. [Marketplace acceptance](https://github.com/favas5291-coder/gym-drobe-backend/actions/runs/44398287630) · [Backend regression](https://github.com/favas5291-coder/gym-drobe-backend/actions/runs/44398287666)

## Independent checks

- The isolated database restore workflow restored three collections and four fixture documents with the financial uniqueness constraint intact. [Restore run](https://github.com/favas5291-coder/gym-drobe-backend/actions/runs/44395360628)
- The dependency patch passed the hosted catalogue, audit and marketplace workflows. Independent hosted CI on the inbox branch also completed. Feature PRs still based on the original lock file can fail the dependency audit before their database steps. GitHub checks must be green on the actual release revision. [Patch marketplace CI](https://github.com/favas5291-coder/gym-drobe-backend/actions/runs/44395182436) · [Patch catalogue CI](https://github.com/favas5291-coder/gym-drobe-backend/actions/runs/44395182748)
- Automatic approval review rejected resuming one local legacy Razorpay-capture test because of possible external payment effects. It was not rerun via that path. The synthetic COD acceptance disables the gateway. Actual Razorpay test-mode checkout on an approved staging account remains open.
- Staging metadata checks require transaction-capable topology and nine pilot index definitions. An actual empty loopback replica set blocked; the check passed after configuring the combined checkout's model indexes and daily-report index. The operator should verify these in the selected staging environment.
- These PRs require no new provider subscriptions. Event records, indexes, heartbeats, CI and host time consume resources on the selected plan. Paid inference, campaign spend, messaging, provider shipments and production backup capacity have no approved budget in this pilot.

## Mobile storefront measurements

Three cold navigations per route and revision, 390 × 844 touch viewport, Chromium 153, 4× CPU slowdown, 150 ms latency and 1.6 Mbps download. Assets came from production builds and API data came from local fixtures. Each Cart test asserted one item. The comparison covers storefront PRs #74–82, including the adjacent settlement and dispatch UI merge, at integrated tree `d7341717db0de4fdd3d17413b220fb7f85f85c58`. All 289 unit tests, a production build and the nine feature fixtures passed on the candidate. [Storefront integration PR #83](https://github.com/favas5291-coder/gym-store/pull/83)

| Route | Median LCP on main | Median LCP on draft | Median CLS on draft | Loaded route JS and CSS gzip change |
| --- | --- | --- | --- | --- |
| Home | 2.176 s | 2.068 s | 0 | +259 bytes |
| Shop | 2.748 s | 2.780 s | 0 | +260 bytes |
| Populated Cart | 2.236 s | 2.604 s | 0 | +379 bytes |

The Cart change stabilised the coupon while the catalogue loaded. The final largest paint on Cart was the item thumbnail, while the baseline often measured recommendation text. Both Shop and the populated Cart exceeded 2.5 seconds in this release sample. Three runs can vary with host load. Production speed and low-end device performance remain unverified.

After the nine-branch snapshot, [storefront #85](https://github.com/favas5291-coder/gym-store/pull/85) tested early loading of the actual first product photo. Five alternating cold pairs measured median Shop LCP of 2.852 s on its control and 2.656 s on the draft, with identical photo bytes and zero CLS; this is a separate experiment, still above 2.5 s. [Storefront #84](https://github.com/favas5291-coder/gym-store/pull/84) deferred 38,409 bytes of install-dialog media until visible; the LCP experiment for this separate change was inconclusive.

## What still needs work

| Workstream | Pending work or decision | Evidence needed to close it | Responsible role |
| --- | --- | --- | --- |
| Standard COD rollout | Verify pilot service areas, product exclusions, supplier pickup and coverage for mixed carts. Kits remain prepaid in the pilot. A single full-order cash receipt currently covers multi-supplier COD. Partial per-parcel collection and remittance still require implementation. | Approved supplier/pincode matrix, fixtures for staggered collection and owner-authorized staging checkout. | Store operator and commerce engineering |
| Prepaid and financial effects | Rehearse Razorpay test-mode authorization, delayed/repeated callbacks and refunds using dedicated test credentials. Direct bank settlement, payout transmission, bank confirmation, tax and invoices remain separate work. | Provider test IDs; finance-approved invoice issuer, tax treatment, reconciliation source, role separation and account configuration. | Finance owner, accountant and payment engineering |
| Courier booking and returns | The fixture covers duplicate and uncertain bookings. Provider-specific AWB/label, pickup, signed tracking, NDR, reverse collection, RTO, remittance import and bank confirmation require further implementation and acceptance. | Approved carrier sandbox, pickup account, contractual rate card, actual parcel data, signed callback and sample forward/reverse/remittance evidence. | Logistics operator and integration engineering |
| Supplier operations | Confirm contracts defining dispatch clock, return terms, supplier ownership, verified stock and payout details. Use missing data as a review reason. | Accepted terms and real pickup records for each pilot supplier; staging must demonstrate visibility isolation and different dispatch outcomes. | Supplier operations |
| Customer service and channels | Configure verified operator identity and an escalation destination. Complete customer-initiated partial returns, channel fallback, consent revocation and actual device delivery checks. | Approved policies, published contact, reviewed message templates, opt-in records and provider test account/device. | Support and privacy owner |
| Growth, AI, analytics and cost | Complete features for consented lifecycle marketing, attribution, loyalty/referrals, supplier and demand forecasting, and data rights. Distinguish reporting, drafts, and external delivery. | Approved campaign and incentive rules, verified opt-outs, factual catalogue, sufficient reconciled history, complete cost sources and any authorized quota. | Operations, growth and engineering |
| Web and mobile releases | Compare candidate speed and test mobile routing, login persistence, checkout, push permissions, app relaunch and offline/reconnect on real devices. Store submissions use separate release credentials. | Paired SHAs and results on Android and iPhone, release-signing/build access and staging performance readings. | Mobile and release engineering |
| Monitoring and recovery | Select the paging destination, accountable on-call operator, store retention, actual backup schedule and recovery objectives. Rehearse an isolated restore from the actual managed backup product. | Measured real service load, backup/access evidence, owner-approved alert route and recorded restore timing. | Infrastructure owner |
| Deployment | Review independently scoped PRs, integrate matching versions and indexes, deploy to the designated staging target, run the order/return/exception checks, then decide on a staged production rollout. | Explicit environment choice and approval, feature flag and rollback test, green checks on the exact release revision, then measured production health. | Release owner |

An external account blocks provider verification. It does not complete the associated engineering work. Blank credentials, fixture IDs, and a successful frontend build never establish a production integration.
