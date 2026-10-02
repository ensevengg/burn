# Machine connection and transfer behavior

Current architecture: [ADR 0003 — Tailscale-only backend](adr/0003-tailscale-only-backend.md), 2026-10-02. The direct-sync reliability fixes from `fix/connection-transfer-reliability` remain in place. The former database backend and its upload path are removed.

## Reporter

- `init --slug ... --name ...` saves machine identity, host grouping, OS, timezone and parser pin. Loading an older config atomically rewrites it through the machine-only schema and deletes generated setup SQL. `init --direct` remains accepted for compatibility.
- `daemon` and `serve` expose the same read-only endpoints: `/ping`, `/live/events`, `/live/quotas`, `/live/metrics`. Bind to Tailscale IPv4 by default; loopback fallback warns that the phone cannot reach it. Binding failures fail the command. Keep the process running for phone refreshes.
- `doctor` verifies configuration, tokscale/exporter pins and a Tailscale address. `usage` prints locally collected quota JSON. Upload commands/options are rejected; replace old scheduled push jobs with a resident daemon.
- One normalized full event snapshot, shared in-flight scan, 30-second result TTL and five-minute exporter pin/capability check. Source fingerprints reuse unchanged snapshots across TTL expiry without altering the pageable snapshot metadata; forced reconciliation, changed sources or clock rollback scan again. The Bun server idle timeout is 150 seconds; exporter timeout is 90 seconds.
- Pages contain at most 1,000 rows and roughly 4MB decoded event content. Bounded encoded-page caching avoids repeated serialization; gzip negotiation and ETags avoid redundant transfer. Snapshot generations stay pageable briefly; expired cursors return HTTP 410.
- Physical machine vitals sample every 30 seconds and on request; `/live/metrics?since=` serves process-local 24-hour history. CPU/RAM load uses OS counters, Linux temperatures use hwmon, and GPU readings use NVIDIA or Linux DRM sensors. Missing sensors stay null. WSL does not duplicate its Windows host. The phone persists received history.
- A separate 45-second quota cache preserves source collection time. A source scan may complete and populate the cache after a client disconnects. No provider parser is implemented in burn.

## Phone mirror and cursors

- Screens paint from expo-sqlite before any network work. Machines are registered by URL with a validated ping identity. Reusing a slug preserves the existing environment ID and history; a changed endpoint identity cannot inject data under another machine.
- Foreground and refresh gestures probe machines. Backfills continue automatically while foregrounded, bounded to eight pages per pass. There is no minute network polling or refresh-delivery rendezvous.
- After ping validation, event, quota and health requests run independently. Health/quotas publish even when events are slow/failing; a successful quota cannot clear an event error. Success/error quota channels remain separate and stale responses cannot replace newer collection times.
- Health responses pass strict timestamp/percentage/temperature gates and merge in bounded batches under `machineMetricId(environmentId, capturedAtMs)`. Overlapping samples are no-ops; local history prunes to 24 hours. Old reporters without `/live/metrics` remain usable. Health shares the cancellation generation/write lock and survives event failures independently.
- Quota reset evidence accepts validated provider calendar dates as well as instants; Copilot date-only resets are preserved without inventing a clock or timezone.
- Event identity remains `sha256(slug | client | dedup_key)` in `packages/sync-api`. All changed machine content replaces cached content under that identity. No revision watermark or backend authority guard remains. No-op event writes avoid repeated cache work.
- Each page commits rows with its continuation atomically. Completed windows checkpoint machine **scan start**, using `direct_since_v3_<environmentId>`, never phone merge time. The one-hour overlap catches messages completed across scans. Old cursor generations trigger corrective replay; machine clock rollback triggers reconciliation/reset of the checkpoint.
- Full-history reconciliation runs on the next foreground/refresh pull after 24 hours, or immediately through Machines. Reconciliation omits conditional GETs: an incremental content hash cannot prove historical rows were downloaded.
- Compatible refreshes coalesce. Different targets or full-history intents queue and recheck cancellation before starting. Adding a machine targets its first pull.
- All mirror writes use `withWriteLock`; cancellation checks run before transactions, between bounded 32-row event batches and before commit. Reset/disconnect invalidate the sync generation and abort active probes. Queued registration cannot recreate removed data. Cache eviction occurs inside writers after commit.
- Machine diagnostics persist last contact and failures. Cards show changed-event/quota counts, independent quota errors, elapsed time, scan duration and history-loading status. Failed refreshes keep cached data visible.
- Remove/disconnect/demo-clear keep native Yes/Cancel confirmation. Cancel, back and outside dismissal leave data untouched.

## Upgrade

Restart resident reporters. Their configs retain identity/pin and lose obsolete destination credentials. The pin remains 4.15.1; retain main’s exporter fingerprint capability. If `burn-events --capabilities` lacks `fingerprint-v1`, rebuild with `cargo install --path crates/burn-events` before running the reporter.

The phone's legacy cloud mode upgrades locally to direct mode, retaining cached history/preferences. Saved machine endpoint URLs become direct registrations; existing registrations take precedence. A machine without a saved URL stays visible through its cached history and needs its reporter URL added manually. One corrective full reconciliation runs after upgrading, then normal per-machine cursors resume.

Demo mode is retained. Entering real machine mode from demo clears demo history/reference prices; real history survives upgrade. Clearing data/disconnecting removes registrations and mirror rows, preserving timezone/theme preferences. No remote database is contacted, migrated or deleted by this change.

## Validation

The current main has been reconciled with this branch, preserving its All-history views, combined model totals, remaining quota display, labels and initial-sync diagnostics.

Strict typecheck and all **112 tests pass**. Coverage includes real HTTP/SQLite transfer of 27,001 synthetic rows across four resumable passes, one exporter scan, then zero event writes on unchanged refresh; late historical corrections after an incremental hash; paging/gzip/ETags/cache TTLs and a 12-second cold scan; independent quota freshness; queued cancellation/registration races; legacy config cleanup; atomic phone upgrade rollback and destructive confirmation callbacks.

The signed arm64 Android release build succeeds (APK about 31MiB). On-device validation on the USB-connected OnePlus 10R / Android 15 passed dashboard, Systems, Explore, Machines and Settings navigation, live RAM/GPU reads, quota refresh, and destructive-dialog cancellation. Tailscale was disconnected initially and was reconnected using its existing account. The build reconciled with current main was installed in place again; All-history controls, live Systems readings and saved machine registrations remained usable, with no AndroidRuntime or ReactNativeJS errors during the smoke check.

An in-place package/signature-compatible upgrade preserved all three machine IDs/URLs/names/registration times and every one of the 42,141 pre-upgrade usage rows; SQLite integrity checked clean. CachyOS and HP refreshed successfully, including all five HP quota rows after accepting Copilot’s valid calendar reset date. Lenovo Windows was offline and retained cached history/its connection. One observed warm-source refresh took 2.8s for CachyOS and 2.6s for HP; these are individual runs, not latency guarantees. Existing machines served the older unpaged protocol; the new paged protocol’s large-history/cancellation checks run over real HTTP/SQLite in host tests. Broader Android timing and outage benchmarks remain pending.

## Remaining work

`--since-ms` still filters after upstream result construction. The pinned core caches parsed source messages; avoiding cold full-history work needs a genuine source index or upstream incremental API at the D2 seam. Resident caching and unchanged-transfer avoidance do not eliminate that work.

Accurate model-price reference transport remains deferred and must preserve tokscale provider/alias/tier semantics. Event costs remain priced by tokscale. Compact/dictionary delta formats and a combined snapshot endpoint are optional protocol follow-ups.
