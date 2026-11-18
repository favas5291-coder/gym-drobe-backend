# Automation worker health

## Audit

The automation summary originally reported the worker configuration and the timestamp of the most recent completed job. Administrators could manually process jobs through the same drain function used by the timer. An empty queue could be polled indefinitely without recording a completed job. Those fields could not distinguish a scheduled poll from manual work or detect a stalled polling loop.

## Reading the admin summary

The existing authenticated `GET /api/admin/automation` response adds `workerHealth` with the following fields.

| Field | Meaning |
|---|---|
| state | `disabled` when this API instance has the engine or worker switched off, `never_seen` before any scheduled batch was recorded, `polling` after a recent successful scheduled batch, `stale` after 90 seconds without evidence, `unavailable` if the enabled worker’s heartbeat cannot be read, or `clock_skew` when the heartbeat timestamp leads the reader clock by more than 30 seconds. |
| lastScheduledPollAt | Database timestamp of the last scheduled batch that accessed the queue and reached the end of its drain. An empty batch counts. |
| lastManualDrainAt | Database timestamp of the most recent completed admin-triggered drain, including an empty batch. |
| heartbeatReadable, dueWorkReadable | Whether each bounded read succeeded. Null when the engine is disabled. A failed health read leaves the job summary available. |
| oldestDueAt | Earliest due timestamp of a queued job or expired running lease for this workflow. Future or terminal jobs are excluded. |
| observedAt, staleAfterMs | The API observation timestamp and the threshold used for the status. |

The summary reads a singleton by primary key and performs one bounded-time indexed query against the existing job table. It creates no data. When the entire engine is disabled, the status is disabled, previous poll and due timestamps are null, and the summary skips all job and heartbeat queries. When only the timer is disabled, earlier evidence and pending work remain visible.

## Runtime costs and limits

Each successful scheduled 30-second batch issues one small upsert to a fixed document in `automationworkerheartbeats`, at most 2,880 scheduled writes per enabled API process per day. Each completed manual batch issues one upsert to the same document. MongoDB assigns the timestamps and concurrently updated sources retain their own fields. The document has no growing arrays, request identifiers, hostnames, customer data or job details. Existing credentials must permit these writes if the worker is enabled. Missing write evidence leaves the prior timestamp in place and emits a generic application log message.

A skipped overlapping tick or failed queue access never advances the heartbeat. A completed poll can still leave individual jobs awaiting review or retry. Read job counts, due time and job history for that information. The timestamps describe the latest observation across all processes sharing the database. They do not measure individual replica health. The enablement flags describe the API instance serving the summary. Sleeping hosts and slow batches can produce stale evidence. Both switches remain off by default. There is no external monitor or notification destination.

The focused integration check runs with a disposable loopback MongoDB replica set. Set `GYMDROBE_TEST_MONGO_URI` to a fixture URI and run `node tests/integration/automation-worker-health.cjs`. The check waits for the actual 30-second timer and uses a randomly named temporary database.
