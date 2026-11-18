# Run the two-supplier COD pilot acceptance

This test runs on the integration snapshot for backend PRs #18–24, #26, #27 and #34. Its code and fixture input are synthetic. Git tree `a6808ae047d885b66936e3c789dc02350429dc2c` is pinned on branch `review/automation-pilot-fixture`. Use the acceptance branch containing this document to run it. Neither branch is a production release.

Install dependencies with npm ci in this checkout, use Node 24 and set MONGOD_BIN to a local MongoDB 7 replica-set-capable server executable. Allow room for the disposable database under TMPDIR. Run the shell script from this repository.

    bash tests/integration/run-combined-guest-cod.sh

The launcher starts a private MongoDB replica set on a free loopback port, clears inherited environment settings for the test process, and cleans up on exit. The scenario creates a guest order through Express against a real database, with an actual scheduled worker. It disables the provider client, records synthetic courier/cash evidence and submits a synthetic remittance statement to the owner preview. Each supplier order line is ₹550, including ₹500 payable under its fixture agreement. A retry must leave one customer order, two supplier groups, two entitlements, one job and the correct stock. One parcel is delivered and the other remains shipped.

The test checks exact money values, hold reasons, access through public routes, correlated job transitions and no provider calls or transfers. The owner report must show receipts and outstanding balances, supplier states, real/test cohort isolation and unknown net profit. Synthetic recorded cash and a matched statement row do not establish a bank deposit or courier settlement. A provider-originated sandbox booking, tracking callback, customer notification delivery and a prepaid provider checkout are separate release gates.

The after-sales leg returns one delivered item, leaves the other supplier's shipped item intact, and exercises the operator's inspection decision and the separate external-refund evidence endpoint. Recording the synthetic ₹550 refund twice must produce one refund, ₹550 retained, ₹0 due, one restored unit and a ₹500 reversal for the returned supplier. The shipped supplier must still have ₹500 pending. The operator records evidence in the fixture; no gateway, bank, message or courier is involved.

After an inspected return the delivered timestamp and parcel history remain intact. The final report counts one delivered and one shipped parcel, zero cancelled, and ₹550 in refunds.
