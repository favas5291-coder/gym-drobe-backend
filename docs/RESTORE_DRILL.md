# Recovery rehearsal

At backend e07fb781 the marketplace CI creates a disposable MongoDB replica set and tests transactions. It does not restore an archive. The repository does not establish whether the production MongoDB plan takes snapshots, who can restore them, or whether the supplier encryption key is recoverable.

The database restore workflow creates a synthetic two-supplier order, an inventory record and supplier financial records in a disposable MongoDB process. It archives that database, restores it into a separate namespace, and compares documents and index definitions. An attempted duplicate supplier line must still be rejected in the restored copy. The job has read-only repository permissions and no production credentials. No database port is published, and the fixture archive never leaves the container. It tests logical namespace recovery on complete, quiescent data.

Run the workflow through GitHub Actions or run bash scripts/restore-drill/run.sh on a development machine with Docker. The MongoDB 8.0 image includes the database tools. CI uploads a small timings/counts summary only. Fixture restore duration is not a production recovery-time objective.

## Before production recovery can be claimed

1. Establish actual Atlas tier, point-in-time or snapshot capabilities, approved retention, encryption and costs. Assign an owner and recovery delegate; record the recovery point and time the business can tolerate.
2. Use the hosting provider's approved backup and consistency mechanism for active writes. Verify restricted access and the independent recovery path for the marketplace encryption key. A data snapshot cannot decrypt a supplier destination by itself.
3. Restore a selected real backup only with owner authorization, into a separate access-controlled environment. Keep workers, payment webhooks, outbound notifications, courier bookings and payout operations disabled. Never restore over a live cluster as a test.
4. Compare backup timestamp and recovery target, collection/index manifests, order counts, payment references, purchased stock and supplier liabilities. Have authorized personnel verify decryption without printing secrets or identifying customers. Reconcile changes since the recovery point with verified payment and carrier evidence.
5. Document elapsed time, gaps and sign-off before any cutover. Retain the original database for rollback and agree on who can reopen writes. Verify a repeat drill on the owner-approved schedule.

No production schedule, backup storage, alert recipient or paid service is enabled by this change.
