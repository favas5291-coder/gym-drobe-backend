# Native order notifications — review branch, sending disabled

This change prepares APNs/FCM order alerts. It is not deployed and no customer
message has been sent. Website price/stock watches remain local comparisons.

## Controls and ownership

- `PUSH_REGISTRATION_ENABLED=false` and `PUSH_DELIVERY_ENABLED=false` by default.
- An additional database control (`order-push.enabled`) defaults to false. An
  authenticated admin can inspect `/api/notifications/admin`, stop delivery with
  `PUT /api/notifications/admin/control {"enabled":false}`, and review failures.
- Native clients need an explicit customer opt-in. Startup/foreground restoration
  checks existing permission, never opens a permission prompt automatically.
- Registration is JWT-owned; body user IDs are rejected. At most 20 enabled
  devices per account. Per-process request limits supplement that database cap.
- Device tokens are AES-256-GCM encrypted with a separate random 32-byte Base64
  server key. Ciphertext is bound to the random installation ID. Tokens are not
  put in URLs, customer API responses, local browser storage, or logs.
- A fresh binding claim has a bounded timestamp; refreshes must match the current
  account/binding. Late callbacks and old sign-outs cannot reclaim/disable a
  phone after another account signs in. Token-invalid responses match the exact
  token hash so an old failure cannot disable a rotated token.
- Opt-out remains available while registration is disabled. Sign-out unregisters
  the native token and queues server cleanup; offline cleanup is retried when the
  same account reconnects. A failed server/OS cleanup is shown as incomplete.
  Provider-accepted/in-flight alerts cannot be recalled. Lock-screen text remains
  generic; viewing an order requires normal authenticated order ownership.
- Account deletion removes owned device/outbox data in the existing transaction.
  Registration/enqueue write the same User document, preventing orphan recreation.
  Financial and fulfillment orders retain the configured existing policy.

## Source, deduplication and retries

The bounded worker polls actual Order update timestamps and projects recent
confirmed/shipped/out-for-delivery/delivered/cancelled tracking events plus current
return/refund milestones. It never interprets client payment callbacks, simulated
courier animations, product stock, or arbitrary URLs as a source event. Guest
orders have no account push target. Parcel-specific messages are not implemented;
the generic alert opens the full order/parcel screen without claiming all parcels
are delivered. Historical intermediate statuses may be coalesced to the current
return/refund milestone.

First enable records a baseline. Scans page 100 orders, then overlap five minutes;
they assume server-generated `updatedAt` and commits shorter than this grace
period. Backdated/imported updates outside that interval need a deliberate audit,
not an automatic notification blast. Alerts older than 24 hours are cancelled.
Receipts are unique per binding and source event. Provider collapse IDs are a
secondary safeguard, not an exactly-once delivery promise.

Each worker claims an outbox row atomically, validates account/order/binding and
the stop control, writes `sending`, then calls the provider. Known HTTP 429/5xx
rejections retry with exponential delays, at most five attempts. Invalid tokens
are disabled. Connection loss, ambiguous response, process death after `sending`,
or inability to persist acceptance becomes `uncertain` and is not resent. A stale
`leased` row can be safely reclaimed because no request has started yet.

Admin retry only accepts a definite failed delivery below the attempt limit;
uncertain sends can be cancelled/reviewed, not blindly resent. The bounded audit
history contains state/code/time/admin ID, no token or message body. Sanitized
stderr alerts are throttled to five minutes. Counts, recent failures, worker
heartbeat and last scan are available to admins. Hosting log alert routing still
needs an owner-approved destination. Device records expire after 90 days without
refresh; outbox records after 30 days. Confirm these retention periods in policy.

## Integration and verification gates

1. Deploy to an isolated MongoDB replica set and verify required indexes before
   enabling registration. The CI fixture uses a disposable loopback MongoDB 8
   replica set, no production URI or credentials, and mocked providers.
2. iOS: Apple Developer signing, push capability, `APNS_ENVIRONMENT`, Team ID,
   Key ID, `.p8` server key and exact `com.gymdrobe.app` topic. This server instance
   supports one APNs environment; keep sandbox staging separate from production.
   APNs uses ES256/HTTP2, a 50-minute cached JWT and a generic alert payload.
3. Android: owner's Firebase project/app `google-services.json` (ignored by git),
   server FCM service-account JSON and matching project ID. Stable FCM v1 OAuth
   uses the existing google-auth-library. No preview SDK or new backend dependency.
4. Native opt-in UI flag stays false. Default native sync excludes the push plugin,
   so unconfigured Firebase cannot break existing login/startup. Enabled iOS sync
   requires an explicit APNs environment; enabled Android sync validates package
   configuration. Firebase auto-init/analytics are off before consent.
5. Unit, JWT/HTTP, real disposable Mongo concurrency and browser adapter checks
   are separate evidence. Real APNs/FCM delivery, permission denial/settings,
   foreground/background/killed app, token rotation, shared-phone sign-out,
   reinstall and physical iPhone/Android checks remain required.
6. A founder must authorize a controlled staging delivery before turning on the
   worker. Confirm notification/retention disclosures and operator alert routing.
   Enable one provider/device first, inspect outbox/provider acceptance and actual
   phone receipt, then review expansion. Acceptance is not proof of phone receipt.

## Rollback

Turn the database control off, then both server flags and native UI flag off.
Unsent work stops on the next control check; in-flight accepted alerts can finish.
Keep encrypted device/outbox collections for review until their retention policy
allows cleanup. Do not drop indexes/collections or reset source cursors to trigger
resends. Older app/API behavior remains compatible. Native bundled changes require
new test builds and later store updates; a website deploy does not update them.

Primary references (checked 30 October 2026):
- https://capacitorjs.com/docs/apis/push-notifications
- https://firebase.google.com/docs/cloud-messaging/send/v1-api
- https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
