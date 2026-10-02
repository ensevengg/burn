# Machine connection and transfer behavior

Current architecture: [ADR 0003 — Tailscale-only backend](adr/0003-tailscale-only-backend.md), 2026-10-02. The direct-sync reliability fixes from `fix/connection-transfer-reliability` remain in place. The former database backend and its upload path are removed.

## Reporter

- `init --slug ... --name ...` saves machine identity, host grouping, OS, timezone and parser pin. Loading an older config atomically rewrites it through the machine-only schema and deletes generated setup SQL. `init --direct` remains accepted for compatibility.
- `daemon` and `serve` expose the same read-only endpoints: `/ping`, `/live/events`, `/live/quotas`. Bind to Tailscale IPv4 by default; loopback fallback warns that the phone cannot reach it. Binding failures fail the command. Keep the process running for phone refreshes.
- `doctor` verifies configuration, tokscale/exporter pins and a Tailscale address. `usage` prints locally collected quota JSON. Upload commands/options are rejected; replace old scheduled push jobs with a resident daemon.
- One normalized full event snapshot, shared in-flight scan, 30-second result TTL and five-minute exporter pin check. The Bun server idle timeout is 150 seconds; exporter timeout is 90 seconds.
- Pages contain at most 1,000 rows and roughly 4MB decoded event content. Bounded encoded-page caching avoids repeated serialization; gzip negotiation and ETags avoid redundant transfer. Snapshot generations stay pageable briefly; expired cursors return HTTP 410.
- A separate 45-second quota cache preserves source collection time. A source scan may complete and populate the cache after a client disconnects. No provider parser is implemented in burn.

## Phone mirror and cursors

- Screens paint from expo-sqlite before any network work. Machines are registered by URL with a validated ping identity. Reusing a slug preserves the existing environment ID and history; a changed endpoint identity cannot inject data under another machine.
- Foreground and refresh gestures probe machines. Backfills continue automatically while foregrounded, bounded to eight pages per pass. There is no minute network polling or refresh-delivery rendezvous.
- After ping validation, event and quota requests run independently. Quotas publish even when events are slow/failing; a successful quota cannot clear an event error. Success/error quota channels remain separate and stale responses cannot replace newer collection times.
- Event identity remains `sha256(slug | client | dedup_key)` in `packages/sync-api`. All changed machine content replaces cached content under that identity. No revision watermark or backend authority guard remains. No-op event writes avoid repeated cache work.
- Each page commits rows with its continuation atomically. Completed windows checkpoint machine **scan start**, using `direct_since_v3_<environmentId>`, never phone merge time. The one-hour overlap catches messages completed across scans. Old cursor generations trigger corrective replay; machine clock rollback triggers reconciliation/reset of the checkpoint.
- Full-history reconciliation runs on the next foreground/refresh pull after 24 hours, or immediately through Machines. Reconciliation omits conditional GETs: an incremental content hash cannot prove historical rows were downloaded.
- Compatible refreshes coalesce. Different targets or full-history intents queue and recheck cancellation before starting. Adding a machine targets its first pull.
- All mirror writes use `withWriteLock`; cancellation checks run before transactions, between bounded 32-row event batches and before commit. Reset/disconnect invalidate the sync generation and abort active probes. Queued registration cannot recreate removed data. Cache eviction occurs inside writers after commit.
- Machine diagnostics persist last contact and failures. Cards show changed-event/quota counts, independent quota errors, elapsed time, scan duration and history-loading status. Failed refreshes keep cached data visible.
- Remove/disconnect/demo-clear keep native Yes/Cancel confirmation. Cancel, back and outside dismissal leave data untouched.

## Upgrade

Restart resident reporters. Their configs retain identity/pin and lose obsolete destination credentials. No exporter rebuild is needed: the pin remains 4.15.1.

The phone's legacy cloud mode upgrades locally to direct mode, retaining cached history/preferences. Saved machine endpoint URLs become direct registrations; existing registrations take precedence. A machine without a saved URL stays visible through its cached history and needs its reporter URL added manually. One corrective full reconciliation runs after upgrading, then normal per-machine cursors resume.

Demo mode is retained. Entering real machine mode from demo clears demo history/reference prices; real history survives upgrade. Clearing data/disconnecting removes registrations and mirror rows, preserving timezone/theme preferences. No remote database is contacted, migrated or deleted by this change.

## Validation

Strict typecheck and all **98 tests pass**. Coverage includes real HTTP/SQLite transfer of 27,001 synthetic rows across four resumable passes, one exporter scan, then zero event writes on unchanged refresh; late historical corrections after an incremental hash; paging/gzip/ETags/cache TTLs and a 12-second cold scan; independent quota freshness; queued cancellation/registration races; legacy config cleanup; atomic phone upgrade rollback and destructive confirmation callbacks.

The Android Hermes export succeeds (1,061 modules, about 2.5MB). These are host tests. Android interaction/merge timing and real tailnet/vendor outage measurements remain pending.

## Remaining work

`--since-ms` still filters after upstream result construction. The pinned core caches parsed source messages; avoiding cold full-history work needs a genuine source index or upstream incremental API at the D2 seam. Resident caching and unchanged-transfer avoidance do not eliminate that work.

Accurate model-price reference transport remains deferred and must preserve tokscale provider/alias/tier semantics. Event costs remain priced by tokscale. Compact/dictionary delta formats and a combined snapshot endpoint are optional protocol follow-ups.
