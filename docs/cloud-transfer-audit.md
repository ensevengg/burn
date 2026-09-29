# Cloud connection and transfer audit

Historical pre-fix audit. Implementation, regression evidence and remaining work are recorded in [connection-transfer-fixes.md](connection-transfer-fixes.md).
Source audit dated 2026-09-30. Covers the current Supabase migrations, `packages/sync-api`, reporter push/daemon, and phone cloud mirror. Application code was not changed. No external backend or Android timing measurement was used. References below point to the source examined; deployed migration state remains unknown.

## Fix correctness and access before tuning throughput

### Critical: quota RPC bypasses its read token

The latest `burn_fetch_quota_latest` definition accepts `p_read_token` but never uses it. It is a security-definer function reading `burn.quota_snapshots` directly, and grants execution to `anon` and `authenticated`. A caller with the public project key can supply an arbitrary token and obtain account labels, plans, quotas and machine IDs. Base-table RLS does not repair a security-definer RPC that omits authorization. This also prevents read-token revocation from protecting this endpoint.

Evidence: [current function and grant](../supabase/migrations/0004_quota_freshness.sql#L8), [actual read-token helper](../supabase/migrations/0002_api.sql#L25), [base-table lockdown](../supabase/migrations/0001_schema.sql#L125). Migration 0006 changes heartbeat/delta only; 0004 is the latest quota definition.

Fix with a new migration that executes `_assert_read_token` before the query. Regression checks must invoke the real RPC with missing, invalid, revoked and valid tokens; TypeScript mocks cannot validate this boundary.

### Critical: independent machine revisions are consumed as one global watermark

Ingest increments `latest_revision` on one environment and gives the batch that local revision. Delta queries all machines with `revision > p_since_revision`, while the phone persists one `watermark_revision`. If machine A has reached revision 100 and machine B first uploads revision 1, the next delta at 100 excludes B. Corrections on B are excluded until its own counter passes the cursor or a separate replay occurs. The idle-watermark bug below can accidentally trigger such a replay; that does not make the incremental protocol correct. Event IDs being idempotent does not repair skipped reads.

Evidence: [per-environment increment](../supabase/migrations/0002_api.sql#L97), [global query](../supabase/migrations/0006_live_endpoint.sql#L59), [single phone watermark](../apps/mobile/src/lib/sync-cloud.ts#L12).

Use per-environment revision cursors, consistent with D5, or introduce a genuinely global committed change protocol. A bare global sequence alone is insufficient if transaction 11 commits before transaction 10 and the phone advances past 10. Repair existing mirrors with a deliberate migration/reconciliation; changing only future reads leaves historical omissions.

### High: pagination skips the rest of a revision

The SQL orders by `(revision, event_id)` and applies a row limit, but returns only the largest revision as the continuation. If a page ends inside revision 7, the next `revision > 7` query omits the remaining rows of revision 7. `has_more` uses the same strict revision comparison and can incorrectly report completion. The normal reporter's 500-row batches versus the default 5,000-row page reduce this risk; they do not establish a contract, because callers can request smaller limits, ingest RPC accepts larger batches, and distinct environments reuse revision numbers.

Evidence: [limit and continuation](../supabase/migrations/0006_live_endpoint.sql#L59), [RPC limit parameter](../packages/sync-api/src/supabase.ts#L263), [reporter batch default](../apps/reporter/src/events.ts#L197).

Use a continuation containing both revision and event ID within each environment, or return whole revision groups with bounded server-side batches. Compute `hasMore` from the exact continuation predicate. A local SQLite reproduction of the same selection predicate with three rows at revision 1 and limit 2 yielded two rows, cursor 1, then zero rows.

### High: an idle delta resets the persisted watermark to zero

When no events match, SQL computes `max_revision = 0`. The phone writes that value unconditionally, although its returned in-memory watermark is `Math.max(old, 0)`. It then breaks because the page is empty. The next sync starts at zero and replays history. `has_more` also counts all historical rows on that idle response, producing a false backfill notice. This is a correctness bug and a recurring transfer/SQLite/aggregation cost, rather than merely a `count(*)` optimization.

Evidence: [empty max and full-history count](../supabase/migrations/0006_live_endpoint.sql#L76), [persisted versus returned watermark](../apps/mobile/src/lib/sync-cloud.ts#L125).

Reproduced against the actual `pullCloud` and existing in-memory mirror fixture: initial persisted watermark 42; empty response with `maxRevision: 0, hasMore: true`; returned watermark 42; persisted value `"0"`; next request cursor 0. Preserve the existing cursor on empty results, enforce monotonic commits, and replace the count with `exists` using the corrected continuation.

### High: a broadcast refresh is acknowledged by the first machine only

A null-target sync request means all environments. Polling globally changes its status from pending to acknowledged. The first reporter to poll consumes it; subsequent reporters no longer see it. Acknowledgment also occurs before export/upload succeeds, with no lease, retry or completion API, so a crashed/failed cycle loses the eager request.

Evidence: [broadcast meaning](../supabase/migrations/0001_schema.sql#L103), [selection and global acknowledgment](../supabase/migrations/0002_api.sql#L256), [cycle after poll](../apps/reporter/src/commands.ts#L360).

Track request delivery/completion per environment, coalesce redundant pending requests, and reclaim timed-out deliveries. The scheduled push remains the floor, but does not make refresh-to-all reliable.

### High: reporter reconfiguration retains the old backend's time cursor

`runInit` saves a new backend/slug/token configuration without resetting or namespacing the cursor. The cursor is always one `cursor.json` in the same config directory. Reusing that directory to register a different Supabase project or environment after a recent push means its first push exports only the overlap window instead of backfilling history.

Evidence: [init](../apps/reporter/src/commands.ts#L52), [shared cursor path](../apps/reporter/src/config.ts#L40), [window based on old cursor](../apps/reporter/src/commands.ts#L220).

Namespace the cursor by backend/environment identity; preserve it only for rotation of the same environment. Write cursor files atomically and validate their contents: currently an interrupted direct write can leave malformed JSON and block subsequent runs ([load/save](../apps/reporter/src/config.ts#L70)).

## Connection reliability and truthful freshness

### High: cloud requests have no application deadline or cancellation signal

The shared RPC helper awaits `client.rpc` without a deadline, abort signal or explicit transient retry policy. Phone cancellation prevents obsolete commits, but does not abort the network operation. Both the phone's single-flight promise and daemon polling guard can remain occupied until the transport eventually fails. `Promise.allSettled` also keeps overall sync status waiting for a stuck sibling even after one channel has published successfully.

Evidence: [RPC](../packages/sync-api/src/supabase.ts#L190), [phone single flight and generation cancellation](../apps/mobile/src/lib/sync.ts#L126), [channels wait for both](../apps/mobile/src/lib/sync-cloud.ts#L175), [daemon guard](../apps/reporter/src/commands.ts#L353).

Add explicit deadlines and signal propagation through SyncApi. Retry transient transport/429/5xx failures with bounded backoff and jitter; avoid retrying invalid credentials/schema errors. Retrying event batches is already content-idempotent, whereas quota append and sync-request insertion need request IDs before generic mutation retries are safe.

### Medium: scheduled daemon pushes depend on a successful request poll

`scheduled` is computed before polling, but the fallback cycle runs only after `pollSyncRequests` succeeds. If the poll endpoint fails while ingest remains usable, a due scheduled push is skipped. A failed data cycle updates `lastPush` as if it succeeded and waits the normal interval before scheduled retry.

Evidence: [cycle timing](../apps/reporter/src/commands.ts#L340), [poll-gated schedule](../apps/reporter/src/commands.ts#L357).

Separate the scheduled reliability loop from the rendezvous endpoint, maintain separate last-attempt/last-success times, and use bounded retry backoff after failed cycles. Preserve the existing non-overlap guard.

### Medium: parallel channels overwrite each other's failure diagnostics

Heartbeat sets `last_success_at` before export/upload. Each successful event batch and quota write clears the same environment `last_error`. Because event/quota channels run in parallel, an event error can be recorded and then erased by a successful quota write, or a quota error by a later event batch. Machines can consequently appear successful while one data stream is failing.

Evidence: [heartbeat](../supabase/migrations/0006_live_endpoint.sql#L38), [event status update](../supabase/migrations/0002_api.sql#L97), [quota status update](../supabase/migrations/0002_api.sql#L234), [parallel error reporting](../apps/reporter/src/commands.ts#L266).

Persist channel-specific last attempt/success/error and reserve heartbeat for reachability. Derive overall health after both channels settle, without turning reachability into proof that all data uploaded.

### Medium: correction delivery is still event-time limited before cloud ingestion

Once a changed row reaches ingest, revisions propagate its content changes. The reporter normally emits only events newer than `lastPushAt - 1h`, however, so old pricing/parser corrections and late-discovered old records never reach ingest automatically. `--full` is supported, but the daemon never invokes it on a pin change. Saving the cursor after all uploads also makes the overlap absorb scan/upload duration rather than just scan lag.

Evidence: [window](../apps/reporter/src/events.ts#L182), [pin check/window/cursor](../apps/reporter/src/commands.ts#L212), [daemon normal cycle](../apps/reporter/src/commands.ts#L341).

Persist parser/pricing versions alongside the cursor and run a controlled reconciliation when they change. Use machine scan-start evidence as the time boundary; maintain a source-change-aware index or periodic correction sweep for old records. Do not shrink overlap solely from an HTTP speedup.

### Medium: deletions do not propagate to other mirrors

Cloud deltas include current environments but the phone only upserts them. No deleted environment/event tombstones are shipped. Removing a machine on this phone deletes its mirror locally, but removal from another phone or the backend leaves an existing mirror's historical data indefinitely.

Evidence: [server cascade removal](../supabase/migrations/0003_api_removal.sql#L21), [environment-only upserts](../apps/mobile/src/lib/sync-cloud.ts#L46), [local removal](../apps/mobile/src/data/repository.ts#L521).

Treat the fetched environment registry as an authoritative cloud membership snapshot, with explicit protection for direct/demo-owned rows, or transmit revisioned tombstones. Test deletion across two cached clients.

### Medium: cloud payload parsing silently converts malformed data

The RPC helper casts unvalidated data to its requested generic type. Cloud parsers coerce IDs with `String`, default invalid event timestamps to zero, and default invalid costs to zero. Invalid revisions/envelopes can therefore affect a durable cursor rather than fail before commit. Reporter export schema validation does not validate the separate backend-to-phone contract.

Evidence: [RPC cast](../packages/sync-api/src/supabase.ts#L196), [date/cost defaults](../packages/sync-api/src/supabase.ts#L40), [event coercions](../packages/sync-api/src/supabase.ts#L76), [delta envelope](../packages/sync-api/src/supabase.ts#L274).

Validate a versioned delta envelope and every row with finite integer cursors/tokens, valid timestamps/enums, and decimal strings; reject malformed pages before entering the mirror transaction. Preserve compatibility deliberately rather than treating missing identity or revision as valid historical data.

## Keep the protections that already work

- Cloud event/quota downloads and reporter event/quota sources already run in parallel; quotas publish independently of a slow or failed event channel ([phone](../apps/mobile/src/lib/sync-cloud.ts#L138), [reporter](../apps/reporter/src/commands.ts#L254)). The user's serial-quota complaint belongs to direct mode.
- Cloud pages commit events and watermark in one transaction. Failed pages roll back both. Inserts use 32-row bound batches beneath the conservative 999-bind limit ([commit](../apps/mobile/src/lib/sync-cloud.ts#L43)). Keep this while repairing cursor semantics.
- The phone coalesces cloud syncs, guards obsolete network responses with a generation counter, and serializes mirror writers ([single flight](../apps/mobile/src/lib/sync.ts#L126), [lock](../apps/mobile/src/lib/writelock.ts#L13)). `removeMachine` calls `stop()` before deletion; do not claim that path lacks cancellation ([removal](../apps/mobile/src/lib/app-context.tsx#L322)).
- Current cloud quota selection preserves the last successful snapshot by filtering `status = 'ok'`; failed event downloads do not stop quota commits ([selection](../supabase/migrations/0004_quota_freshness.sql#L20), [tests](../apps/mobile/test/sync-cloud.test.ts#L50)). Errors remain in the backend, but there is no phone diagnostics RPC, and successful quota ingestion can erase environment-level errors as described above.

After correctness fixes, tune RPC payload size, server `exists` checks, repeated environment transfers, and bounded upload concurrency based on measured times. Preserve page commits and local-first rendering. Increasing pages to 20,000 rows or removing the write lock is not a justified first performance step.

## Validation and gaps

Ran `bun test apps/mobile/test/sync-cloud.test.ts apps/reporter/test/push-quotas.test.ts packages/sync-api/test/wire.test.ts`: 18 pass, 0 fail. These establish local rollback, batching, cancellation and independent channel behavior, but cloud tests mock `fetchDelta`; they do not run migration SQL, exercise authorization, detect tied revisions, or simulate independent environment counters. The empty-watermark reproduction used the actual `pullCloud` plus `mirrorFixture`. The cross-machine and split-page reproductions used the same selection predicate in local SQLite; no claim is made that a deployed PostgreSQL instance was tested.

Add a real disposable PostgreSQL migration/RPC test suite before calling the protocol reliable. Required cases: invalid/revoked quota tokens; new/slower environment after a high cursor; page boundary inside a revision; idle sync retains cursor; two reporters consume one broadcast; failed/crashed delivery is retried; backend switch starts a fresh reporter cursor; partial success remains visible; disconnect/removal during a delayed response.

Existing `docs/sync-latency.html` calls the global wire protocol correct and says parallel batch upload is safe because later pages catch interleaved revisions. Those statements need correction in light of the findings above; safe concurrency requires a cursor/commit-order design first.
