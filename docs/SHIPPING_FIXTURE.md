# Synthetic shipping adapter

This fixture reads the existing Order, MarketplaceAccount and MarketplaceFulfilment records in a disposable local database. It stores simulated carrier receipts and intents in separate fixture collections. No web server route, external provider, label purchase, or customer shipment update is involved.

Run the acceptance scenario with MongoDB on a direct loopback port. The scenario creates and removes a unique test database. From the backend root, run the following commands.

```sh
export NODE_ENV=test
export GYMDROBE_SHIPMENT_PROVIDER=fixture
export GYMDROBE_SHIPMENT_FIXTURE_URI='mongodb://127.0.0.1:27017/gymdrobe_fixture_shipping_demo?directConnection=true'
node tests/integration/shipping-fixture.cjs
```

To inspect a retained synthetic dataset, use `node scripts/shipping-fixture.cjs <command> <fulfilmentId>`. The command reads a supplier group already present in the selected fixture database. Booking requires a preparing group, an active supplier, a confirmed or processing order with recorded payment, exact purchased-item membership, and valid pickup and destination contacts and Indian addresses. A group with an existing carrier or tracking reference, or an item-level resolution, requires review.

| Command | Observed effect in the fixture |
| --- | --- |
| `book` | Creates or returns one intent per order and supplier. Parallel calls share the same provider idempotency key. |
| `lose-response` | Simulates a lost reply after the synthetic carrier has recorded a new booking. |
| `recover` | Looks up the provider receipt first. If no receipt exists, submits the original key only after revalidating the original shipment details. |
| `inspect` | Returns current local state, reference and accepted tracking history. |
| `track` | Takes three additional arguments: the matching fixture reference, stage and canonical UTC timestamp. Accepts collected, in-transit or delivered. Replays, regressions and older observations leave the current stage unchanged. |

The MongoDB acceptance covers two suppliers on one order, eight concurrent booking requests, lost replies, process restart, changed details, unacknowledged preparation, stale/replayed tracking and isolation from customer fulfilment. It does not establish carrier serviceability, price, label format, cancellation, pickup availability or real delivery. A production integration still requires a selected carrier, its documented sandbox and credentials, verified idempotency and lookup semantics, package measurements, signed tracking callbacks and acceptance against that provider. Keep the existing manual fulfilment process for actual shipments.
