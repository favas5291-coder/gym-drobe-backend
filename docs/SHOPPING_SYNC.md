# Shared shopping lists

This is a gated development feature. Set `SHOPPING_SYNC_ENABLED=true` only in
staging after reviewing the paired client, database indexes and privacy policy.
The client build also requires `VITE_SHOPPING_SYNC_ENABLED=true`. Defaults keep
the existing device-only behavior. No deployment or activation is included.

`GET /api/shopping-state` and `POST /api/shopping-state/operations` use the
existing Bearer authentication and derive ownership only from the verified user.
Responses are private/no-store. The API stores selections and wishlist product
IDs, not prices, stock, coupons, checkout permission or payment state. Existing
server-authoritative checkout still verifies those facts independently.

Each operation has an immutable random identifier, creation time, expected
revision and a bounded set of changes. A transaction applies the changes and
records their fingerprint together. Repeated acknowledgements return current
state without adding quantities again. Stale revisions return the current state
so clients can retry the same intent. Quantity adjustments combine; explicit
removals/wishlist changes follow committed order. Legacy device lists merge by
the maximum quantity per selection, while later guest additions add through
their durable transfer receipt. Initial legacy migration therefore avoids
doubling the same list copied onto several devices.

The client journals changes before updating local copies, keeps independent
immutable entries across tabs and retains pending changes through interruption.
It refreshes on foreground/online/focus and every 30 seconds while visible.
Expired or conflicting changes require a customer choice between account lists
and this device's lists. Replacing account lists requires confirmation and a
current revision; it is not automatically rebased after another device changes.

Bounds: 200 cart selections, 500 wishlist IDs, 400 changes per operation,
1,000,000 units per selection (matching the inventory ceiling), 128KiB request
body and process-local request limits. New offline operations older than seven
days require review. Operation receipts expire after 30 days; accepted replays
within retention remain harmless. This is shopping-state synchronization, not
offline ordering or payment replay.

Shopping mutations write a hidden User counter within the same transaction,
serializing against permanent account deletion. Deletion removes the owned
shopping document and receipts even if the feature has subsequently been
disabled. On-device deletion stops in-flight publishing and removes only the
deleted account's journal. Other accounts and guest lists are preserved.

Before enabling: run a staging replica-set test with concurrent requests,
lost replies, deletion racing a mutation, transaction rollback and TTL behavior.
Verify website, signed Android and signed iPhone persistence/guest merging,
background/restart/offline recovery, prices/stock and kit grouping. Unit/HTTP
fixtures use an isolated repository and generated test JWTs; they do not prove
real MongoDB transactions or physical-device operation. Roll back by disabling
both flags and rebuilding bundled clients; preserve stored lists/receipts so
pending acknowledgements can be reconciled. Do not delete customer records as a
rollback mechanism.
