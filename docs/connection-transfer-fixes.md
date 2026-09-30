# Connection and transfer fixes

Implemented on `fix/connection-transfer-reliability`, 2026-09-30. The preceding
[connection audit](connection-transfer-audit.md) and [cloud audit](cloud-transfer-audit.md)
record the original failures; this document describes the resulting behavior.

## Live server and direct mode

| Problem | Result |
|---|---|
| Exporter spawned on every request; overlapping callers received 503 | One normalized full snapshot, shared scan promise, 30-second result TTL. Daemon uploads consume the same store. Exporter pin checks cache for five minutes. |
| Default Bun idle timeout dropped slow scans | Server idle timeout is 150 seconds; exporter timeout is 90 seconds and event fetch timeout is 120 seconds. A real socket test waits 12 seconds before returning its scan. |
| Direct minute timer repeatedly probed machines | Direct probes run on foreground and gestures. Foreground history backfills continue with bounded page pulls; cloud retains minute polling. Concurrent pulls coalesce. |
| Events and quotas fetched serially | After ping identity validation, event and quota requests start independently. Quotas commit even when events are slow or fail. |
| Quotas always hit vendors | Shared 45-second quota cache preserves its original collection time. Phone quota requests have a separate 45-second deadline. A source scan may complete and populate the cache after an impatient client disconnects. |
| Single unbounded initial transfer | New clients request at most 1,000 rows per page, with a roughly 4MB decoded row budget. Up to eight pages per pass, atomic continuation storage and automatic foreground continuation. Old clients without a page limit retain the old shape. |
| Interrupted or expired snapshots | Page continuation commits with its rows. Resume after interruption; restart once on HTTP 410. Idempotent batched writes prevent duplicate rows. |
| Repeated full JSON serialization and raw transfer | Normalized rows and a bounded cache of encoded pages; gzip negotiation and ETags. HTTP 304 skips row decoding and event upserts. Pages use binary search to locate time windows in the sorted snapshot. |
| Phone time advanced the direct cursor | V3 per-machine cursors store the completed snapshot's scan start. The one-hour overlap stays conservative. Old cursor generations trigger one corrective full replay. Machine clock rollback triggers reconciliation and resets the scan checkpoint. |
| Corrections to old direct events were unreachable | Full-history action on Machines, plus full reconciliation on the next foreground/gesture pull after 24 hours. In primary direct mode, machine corrections replace old positive cloud revisions. Cloud opportunistic live pulls retain their positive-revision guard. |
| Cancellation while awaiting the SQLite lock still committed | Generation and abort checks before transactions, between bounded event batches and before commit. Reset/disconnect abort cloud transport requests and direct probes. |
| Quota errors/stale responses replaced successful values | Shared collection-time-aware quota merge, distinct successful/error row keys, preserved credit/spend metadata. Successful samples survive vendor failures and cloud/direct crossover. |
| Registry and demo data survived incompatible resets | Reset clears the direct registry and model prices with mirrored rows. Switching demo to direct clears bundled history/prices. Switching cloud to direct preserves real history. |
| Machines lost durable diagnostics | Persist last contact/errors; show changed-event count, quota count/failure, total elapsed time, scan duration and history-loading state. Successful direct completion updates last pull time. |

## Cloud and reporter reliability

- Quota reads now check the scoped read token. Tests exercise anonymous SQL
  callers with missing, invalid and revoked tokens, and private function access.
- Cloud continuations are `(environment revision, event_id)` tuples in a map,
  instead of one global revision. Page ties, new low-revision machines and idle
  cursors cannot silently drop/replay history. Old global cursor installs replay
  once; rows/cursors still commit atomically.
- Every refresh has one durable delivery per environment. Poll claims a lease;
  acknowledgement follows successful event/quota work. Failed workers can retry;
  a crashed claimant's five-minute lease expires. One reporter cannot consume
  everyone else's broadcast. Scheduled pushes still run when polling fails.
- Heartbeat success means reachable, rather than successfully uploaded.
  Event, quota and heartbeat diagnostics are independent. A quota success cannot
  clear an exporter failure. An unchanged successful scan updates health without
  creating a revision.
- Reporter pushes compare normalized event fingerprints with their last
  acknowledged content index, catching late old records and parser/pricing
  corrections. Index updates follow all acknowledged batches. Lost responses
  replay idempotently; unchanged scans upload no event rows.
- Cursor/index files are scoped to backend URL, slug, ingest token and parser pin,
  written using atomic replacement. Reinitializing a deleted machine, rotating
  tokens or changing the destination cannot inherit another receiver's progress.
  A process lock prevents overlapping cron/daemon pushes; dead-process locks can
  be recovered. Legacy unscoped cursors replay once.
- Cloud RPC calls have a 30-second overall deadline and bounded transient retries
  for reads and idempotent writes. Quota collection time is part of its database
  identity, so quota retries do not duplicate or artificially refresh samples.
  Non-idempotent refresh requests/removals are not automatically retried.
- Cloud membership changes prune departed environments locally, preserve direct
  machines and reunify a direct registry slug with its cloud UUID.
- Runtime gates reject malformed identities, timestamps, nonfinite values,
  unsafe/fractional/negative tokens, unknown enums and invalid decimal costs.
  No provider parser was added; normalization still comes from pinned tokscale.
- `init --direct` and direct-only `serve`/`daemon` require no Supabase credentials.
  Boolean CLI flags no longer consume the following flag. Tailscale address
  discovery and the existing scoped cloud access boundary remain intact.

## Upgrade

Apply **every** SQL migration in numeric order through
`0012_bounded_environment_deltas.sql` to the user's Supabase project before running the
updated cloud client/reporter. Migrations 0007–0012 were tested in embedded
PostgreSQL; this work did not access or migrate an external project. Direct-only
operation does not require a database migration. Restart resident reporters to
activate the snapshot cache/protocol changes. The exporter remains pinned at
4.15.1; it does not need rebuilding for these TypeScript/SQL changes.

First runs after the upgrade intentionally perform a corrective backfill.
Cloud deployments with very large quota tables should schedule migration 0011
appropriately: duplicate cleanup and unique-index creation require database work.

## Validation

- Committed-branch verification: **151 tests pass, 0 fail**, and strict type
  checking passes. Tests include actual mirror SQL
  against SQLite and every migration applied in numeric order to PGlite
  PostgreSQL with anonymous/authenticated roles.
- Real HTTP paging of 2,501 synthetic rows, concurrent consumers sharing one
  scan, gzip negotiation (including `gzip;q=0`), conditional GET, snapshot expiry,
  cache/pin/quotas TTLs and the 12-second slow scan.
- Regression cases for page interruption/resume, expired snapshot replay,
  late/corrected old records, lost acknowledgements, cancelled queued writers,
  stale/error quotas, cloud membership changes and direct/cloud row authority.
- On this machine, the installed pinned exporter produced **5,089 validated
  rows**: first normalized snapshot call **440ms**, scan **425ms**, cached call
  **0.03ms**, same snapshot instance. Existing tokscale source caches were warm;
  these values do not establish a cold-cache or 27k-row Android benchmark.
- Full integration: 27,001 synthetic rows through real HTTP and the actual
  SQLite merge, four resumable passes, one exporter scan, then an unchanged
  refresh with zero event statements. Completed in about 1.9s on this host.
- Expo Android export succeeded: 1,107 modules, Hermes bundle about 3.2MB.
  No Android device was attached to ADB; native UI interaction, device merge
  timings and real tailnet/vendor outages were not measured.

## Second review fixes — 2026-10-01

- Automatic full reconciliation downloads history even when an incremental pull
  acknowledged the same global source hash. An incremental hash only proves the
  requested tail was downloaded. Full reconciliations omit conditional GETs;
  the next due reconciliation repairs old records missed by the preceding build.
- Compatible direct refreshes coalesce; different targets/full-replay intents
  queue. Queued work checks cancellation and reset generations before starting.
  Adding a machine targets its first pull, and pending registration checks the
  generation before and throughout its SQLite transaction.
- Cloud membership removes replaced UUIDs before inserting a reused slug.
  Successful membership is persisted with the event page. Delayed quota
  responses check that membership (including direct registrations); membership
  commits remove old orphan quotas and publish quota changes after pruning.
- Quota failures return an independent diagnostic alongside successful event
  progress. Foreground backfill continues from the committed cursors while the
  UI shows the quota error.
- Migration 0012 reads each environment through its environment/revision/event-id
  index before merging a page. An embedded PostgreSQL plan regression loads
  100,000 rows and verifies an idle pull filters no historical event rows. The
  private candidate helper is inaccessible to anonymous callers.
- Reporter locks atomically publish nonempty directories containing a unique
  process owner. Dead owners recover immediately; stale cleanup removes only
  that owner's filename and cannot remove a fresh nonempty lock directory.
  Legacy PID-file locks remain recoverable; their unused recovery guards no
  longer gate uploads. Legacy empty locks have a 30-second grace period.
  Eight competing real processes exercise 160 acquisitions without overlapping
  writes, and a real SIGKILL test verifies immediate dead-owner recovery.
- Cloud event cost, tokens, parser version and revision are required. Percentages
  accept finite numbers or decimal strings, with boolean/object/blank coercions
  rejected. Timestamps require a valid calendar date and explicit timezone.
- Live adapters apply one shared validation gate per response; injected adapters
  pass through it too. Cloud/direct writes share the event column/binding shape.
  Encoded pages skip repeated row serialization on cache hits, and gzip is
  computed only when requested.
- Machine minus buttons, disconnect/wipe and demo clearing retain their controls
  and show native Yes/Cancel dialogs describing the data affected. Cancel, back
  and outside dismissal perform no action. Yes runs once; failures are surfaced.

The regression cases first failed on the preceding code. Confirmation tests
exercise the action boundary and native-dismissal callbacks; no Android device
was attached, so physical popup interaction remains unmeasured. Android Hermes
export succeeds with these changes. No external Supabase project was migrated.

## Remaining work

`--since-ms` still filters after upstream result construction. The pinned core
already caches parsed source messages; passing its date option alone would not
avoid parsing. A genuine source index or upstream incremental API needs separate
work at the D2 seam. This implementation reduces repeated scans within a resident
process and avoids unchanged transfers; it does not claim to eliminate cold
full-history work.

Model-price reference transport remains the previously documented feature
follow-up. Accurate references need tokscale's provider/alias/tier pricing
semantics; this change does not invent approximations. Event costs remain priced
by tokscale. Compact/dictionary delta formats and a combined snapshot endpoint
remain optional protocol changes. The conservative overlap remains one hour;
ETags and no-op merge checks remove most repeated phone work before shrinking it.
