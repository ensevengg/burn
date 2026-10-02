# Connection and data-transfer audit

Historical pre-fix audit; its cloud architecture was removed by [ADR 0003](adr/0003-tailscale-only-backend.md). Implementation, regression evidence and remaining work are recorded in [connection-transfer-fixes.md](connection-transfer-fixes.md).
Verified 2026-09-30 against the current working tree. Application code was not changed. Existing edits to direct first-backfill behavior, its tests, ADR 0002 and the root package file were included and preserved. Cloud-specific implementation and audit material was retired with ADR 0003.

## Verdict

Most of the supplied live/direct observations are accurate, but the diagnosis needs two corrections:

1. `burn-events --since-ms` does not bound upstream work, yet pinned tokscale **already has a persistent source-message cache**. Full-history result construction is not equivalent to reparsing every unchanged source file. The historical 12-second/27k-record benchmark cannot establish current warm latency on every machine.
2. Several verified correctness and connection failures deserve priority ahead of wire tuning: quota RPC authorization, cloud cursor semantics, server idle timeout, direct refresh wiring, cancellation, and consistent reset behavior.

Keep local-first rendering, the mirror write lock, atomic page/cursor commits, decimal cost strings, stable event IDs, scoped cloud credentials and independent event/quota failure handling. Improve these paths without bypassing tokscale's parser seam.

## What was measured

| Check | Result | Limit |
|---|---|---|
| Root `bun run test` | 104 pass, 0 fail | Cloud tests mock RPC responses; migration SQL is not exercised. |
| Root `bun run typecheck` | Pass | Types do not establish wire validity or SQL cursor safety. |
| Installed `burn-events 4.15.1`, two sequential runs, `--since-ms 9999999999999`, stdout discarded | 5,025 records scanned; wall time 0.452s then 0.349s; exporter reported 432.7ms then 330.4ms; zero rows emitted | This machine's existing cache/history only. No cold-cache eviction or 27k-record real-history test. |
| Actual local Bun HTTP sockets with the real request handler and a fake 13s exporter | Default idle timeout: socket closed at about 12.0s, with Bun's 10s timeout warning. `idleTimeout: 60`: HTTP 200 at about 13.0s | Local Bun 1.3.14; not Android, tailnet or relay timing. |
| Abort direct pull after events fetched, while queued behind the real write lock | Aborted caller still committed one event and returned `state: live` | Existing in-memory SQLite mirror fixture and injected API. |
| Direct quota sequence: success, older success, newer error | Older quota replaced newer usage; old account label/plan remained; error removed the only successful row | Existing mirror SQL exercised through `pullDirectFromMachines`. |
| Apply reset function's actual delete statements, then direct pull | Registry: 1; environments: 0; events: 1; pull reports live | Reset SQL extracted from `db.ts`, existing mirror fixture and actual pull driver. |
| Live structural validation with negative fractional token count, object `costSource`, invalid date string | All accepted | Actual `parseLiveEventsPage`; not a deployed backend payload. |
| 27k synthetic rows expanded from checked-in exporter fixtures | JSON 16,944,951 bytes; gzip 234,847 bytes; desktop gzip about 73ms; JSON parse plus live validation about 170ms | Highly repetitive synthetic data. Compression ratio and CPU timings are not predictions for real data or Android. |

The empty cloud watermark regression was also reproduced against the actual phone pull engine; see the companion audit. No deployed Supabase instance was contacted. No event contents from the installed exporter were retained or printed.

## Verification of the supplied 14 observations

| # | Assessment | Evidence and qualification |
|---|---|---|
| 1 | Confirmed late filtering; full-reparse wording needs correction | Exporter calls the full unified pipeline, derives missing keys and labels workspaces before timestamp filtering: [main.rs](../crates/burn-events/src/main.rs#L134). Core uses persistent caching: [pinned core](../reference/tokscale/crates/tokscale-core/src/lib.rs#L5908). |
| 2 | Confirmed foreground minute probes | [App timer](../apps/mobile/src/lib/app-context.tsx#L199) calls direct sync every minute. New pulls abort older network calls: [direct driver](../apps/mobile/src/lib/direct.ts#L214). Aborting the HTTP call does not stop the machine child process. |
| 3 | Confirmed no endpoint result cache or shared promise | [Server semaphore](../apps/reporter/src/serve.ts#L70) returns 503; it does not queue/share. The protection is local to this handler and does not coordinate exporter scans from daemon push. |
| 4 | Confirmed per-request version process | [Server](../apps/reporter/src/serve.ts#L104), [exporter runner](../apps/reporter/src/exporter.ts#L49). Runner location is cached, not the version result. First resolution also probes the binary. |
| 5 | Confirmed three serial requests in direct mode | Ping, events, SQLite merge, then quotas: [direct](../apps/mobile/src/lib/direct.ts#L278). Cloud-mode opportunistic live pull has only ping and events: [live](../apps/mobile/src/lib/live.ts#L188). |
| 6 | Confirmed no live quota TTL | Every request calls `fetchUsage`: [server](../apps/reporter/src/serve.ts#L131). Actual installed adapter launches `tokscale usage --json`: [adapter](../apps/reporter/src/tokscale.ts#L177). No successful-result cache or quota single-flight exists here. |
| 7 | Confirmed unbounded direct initial response in current working tree | First pull now explicitly sends `since=0`: [direct](../apps/mobile/src/lib/direct.ts#L296). Server returns the entire array: [server](../apps/reporter/src/serve.ts#L119). Existing uncommitted fix corrects an older bug where null selected only the push tail; its regression test passes. |
| 8 | Confirmed one-hour overlap resend | [Shared constant](../packages/sync-api/src/live.ts#L61), [cursor subtraction](../apps/mobile/src/lib/direct.ts#L300). The server honors an explicit `since` as supplied; it does not subtract overlap a second time. |
| 9 | Confirmed cursor uses phone time after merge | [Direct cursor write](../apps/mobile/src/lib/direct.ts#L393). `generatedAt` is currently response time, not scan-start time: [server](../apps/reporter/src/serve.ts#L124). Neither it nor max event timestamp is a complete source-change watermark. |
| 10 | Confirmed buffering and repeated representation changes | Child buffers JSONL: [spawn](../apps/reporter/src/tokscale.ts#L101); server parses/maps/stringifies: [server](../apps/reporter/src/serve.ts#L119); phone buffers JSON then validates: [HTTP client](../packages/sync-api/src/live.ts#L106), [validator](../packages/sync-api/src/live.ts#L160). These validations guard different trust boundaries and should be preserved. |
| 11 | Confirmed raw JSON from application handler | [Response helper](../apps/reporter/src/serve.ts#L53) has no compression negotiation/encoding. A separately configured reverse proxy could add compression; none is guaranteed by this path. |
| 12 | Confirmed full rows on each pull | [Events contract](../packages/sync-api/src/live.ts#L38). Dictionary/compact formats remain an unmeasured optimization; paging, gzip and skipping unchanged rows should precede a new representation. |
| 13 | Confirmed parallel machines, serialized transactions | [Machine `Promise.all`](../apps/mobile/src/lib/direct.ts#L260), [write lock](../apps/mobile/src/lib/writelock.ts#L13). Networks/scans overlap, so total wall time is not simply the sum of every machine's full pull. A large first backfill can monopolize the writer. |
| 14 | Confirmed direct quotas wait for event commit | [Quota request](../apps/mobile/src/lib/direct.ts#L401). Worse, event failure skips quotas entirely. Cloud downloads and reporter sources already run independently: [cloud](../apps/mobile/src/lib/sync-cloud.ts#L138), [reporter](../apps/reporter/src/commands.ts#L254). |

The read-only reference checkout is clean, at `v4.15.1`, commit `a3209ff03da1b71262a4dd97bff854c07ca548b3`, matching [Cargo.lock](../crates/burn-events/Cargo.lock#L1573). Cache facts therefore apply to the actual pin. Core reloads source shards and refreshes pricing on cached messages: [cache loading](../reference/tokscale/crates/tokscale-core/src/lib.rs#L1873), [cached messages](../reference/tokscale/crates/tokscale-core/src/lib.rs#L953), [unchanged-source reuse](../reference/tokscale/crates/tokscale-core/src/lib.rs#L1171). Supplying core's existing `LocalParseOptions.since` alone would still filter after the full pipeline: [resolved parse](../reference/tokscale/crates/tokscale-core/src/lib.rs#L4856), [date filter](../reference/tokscale/crates/tokscale-core/src/lib.rs#L3312).

## Highest-priority access and cloud fixes

These change the original optimization order. Details, scenarios and sources are in [the cloud audit](cloud-transfer-audit.md).

1. **Critical: quota authorization.** The latest public security-definer quota RPC never checks its read token and explicitly permits anonymous execution: [0004](../supabase/migrations/0004_quota_freshness.sql#L8). Restore the scoped-token check in a new migration; test missing, invalid, revoked and valid tokens against real PostgreSQL RPCs.
2. **Critical: cursor domain mismatch.** Ingest assigns environment-local revisions, while the phone tracks a global revision. A high-cursor machine hides lower-revision machines' new uploads: [increment](../supabase/migrations/0002_api.sql#L97), [read](../supabase/migrations/0006_live_endpoint.sql#L59). Use per-environment continuations, matching D5. A global sequence alone does not solve transactions committing out of sequence.
3. **High: row pagination is not revision-safe.** A page can split one revision; advancing past that revision skips the remaining rows. Return a continuation containing revision and event ID, with the environment identity, and compute `hasMore` from the same predicate: [delta](../supabase/migrations/0006_live_endpoint.sql#L59).
4. **High: idle pulls rewind the persisted cursor.** Empty SQL pages return zero and the phone saves it, causing repeated history replay: [SQL](../supabase/migrations/0006_live_endpoint.sql#L76), [phone](../apps/mobile/src/lib/sync-cloud.ts#L125). Preserve a monotonic cursor on empty pages. This is a recurring bandwidth, SQLite and aggregation cost too.
5. **High: refresh-all is consumed once.** The first reporter globally acknowledges a broadcast before upload succeeds: [poll RPC](../supabase/migrations/0002_api.sql#L256). Track per-environment delivery/completion, with lease/retry behavior.
6. **High: reporter cursor scope and persistence.** Reinitializing for another backend/environment retains the old cursor: [init](../apps/reporter/src/commands.ts#L52), [cursor file](../apps/reporter/src/config.ts#L64). Namespace by backend/environment, use atomic validated cursor-file writes, and reconcile any missed initial history.

Do not fix only cursor monotonicity and declare the protocol repaired: the current zero-reset incidentally replays some rows missed by the independent-machine bug. Correct the continuation protocol together, then repair existing mirrors deliberately.

## Direct/live reliability fixes

### High: server deadline closes valid slow scans

`startLiveServer` leaves Bun's idle timeout at the default: [server startup](../apps/reporter/src/serve.ts#L163). Bun's [official server documentation](https://bun.sh/docs/runtime/http/server#idletimeout) says the default is 10 seconds, including an in-flight handler that has not written bytes. The local socket reproduction confirms the problem on the installed runtime. Phone event timeout is 60 seconds; machine exporter timeout is 300 seconds: [phone](../apps/mobile/src/lib/direct.ts#L303), [exporter](../apps/reporter/src/exporter.ts#L69).

Set explicit compatible deadlines for server requests, scans and phone calls. Prefer bounded server work and shared cached results, and report a structured retryable timeout when freshness cannot be achieved. A disconnected phone must not leave an unnecessary exclusive scan running for five minutes. With shared work, detach the caller rather than killing a scan still needed by another caller.

### High: direct pull-to-refresh does not pull

Dashboard and Machines refresh handlers call `requestSync` only for cloud mode; direct falls through to local query refetch: [Dashboard](../apps/mobile/src/screens/DashboardScreen.tsx#L54), [Machines](../apps/mobile/src/screens/MachinesScreen.tsx#L53). Those query loaders read SQLite: [queries](../apps/mobile/src/data/queries.ts#L34). Machines text promises a probe, but the gesture cannot request one. Settings' explicit sync and app foreground/timer still work.

Wire direct gestures to the existing direct `requestSync` path and its spinner. Remove cloud-only status phrases and the incorrect direct “Not connected yet” card: [Machines](../apps/mobile/src/screens/MachinesScreen.tsx#L87). Validate gestures against an actual server; pure driver tests miss this.

### High: cancellation does not guard commits

Direct/live `assertActive` checks only the mirror generation, ignoring the internal/caller abort signal: [direct](../apps/mobile/src/lib/direct.ts#L229), [live](../apps/mobile/src/lib/live.ts#L138). Aborting while a fully fetched page waits for the writer leaves its generation unchanged, so it commits after cancellation. A superseded older pull can therefore write after a newer one. The supplied “abandoned probes never commit” assertion does not hold for this interleaving.

Coalesce redundant refreshes rather than abort/restart them. Check operation identity, lifecycle generation and abort signal after awaits, when acquiring the lock, and before transaction completion. Cancel the actual network requests on reset/removal. Direct `stop()` currently invalidates writes through the generation but has no handle to the direct internal controller: [stop](../apps/mobile/src/lib/app-context.tsx#L94), [sync](../apps/mobile/src/lib/app-context.tsx#L173). Preserve the lock; making SQLite writes concurrent would reintroduce the known transaction failures.

### High: cursor timing is unsafe under skew, late data and long transfers

Advancing to the phone's post-merge time can skip machine-clock events when the phone is more than the overlap ahead. It also hides events arriving while scan/download/merge consumes more than the overlap. Ping only reports skew; it does not change the continuation.

An interim safer boundary is explicit server scan-start evidence with overlap, committed atomically with the page. Existing `generatedAt` is computed after work, and maximum event time can be poisoned by a future-dated event or miss corrections/late old records. The durable solution is a machine-owned change cursor over normalized rows plus stable snapshot/page tokens. Keep reconciliation for imported, delayed or corrected old messages; HTTP speed does not prove that a smaller overlap is safe.

### High: reset leaves orphaned direct state and stale demo prices

Reset deletes environments/events/quotas/cursors, but not `direct_machines` or `model_prices`: [wipe](../apps/mobile/src/lib/db.ts#L150). A subsequent direct pull updates an environment that no longer exists, inserts its events anyway and reports success: [environment update](../apps/mobile/src/lib/direct.ts#L315). Thus direct reconnection after clear/disconnect/demo can produce events without a machine card. Demo prices also survive into real modes and can calculate savings from an obsolete demo reference.

Specify reset semantics explicitly: retain registry and rebuild its environment rows, or clear registry with the mirror. Clear or provenance-scope model prices, and publish machine invalidation when direct ping metadata changes. Direct currently publishes only events after that environment update: [publish](../apps/mobile/src/lib/direct.ts#L399); event invalidation deliberately excludes machines: [context](../apps/mobile/src/lib/app-context.tsx#L155).

### High: direct quota merge does not preserve freshness or successful state

Current same-key upsert accepts any timestamp and status. Older responses replace newer values; an error can replace the only successful value that `queryQuotas` displays: [upsert](../apps/mobile/src/lib/direct.ts#L413), [display filter](../apps/mobile/src/data/repository.ts#L809). Account labels/plans never update on conflict. Transport/validation failure is swallowed and the machine still reports live with no quota diagnostic: [best effort](../apps/mobile/src/lib/direct.ts#L401). A caller-specified `pingTimeoutMs` also accidentally becomes the quota timeout: [line 404](../apps/mobile/src/lib/direct.ts#L404).

Keep last successful values separately from last-attempt errors; compare freshness before replacement; update successful metadata and retire obsolete metrics/accounts by an explicit snapshot policy. Give quotas their own deadline/status. Download them independently after identity validation and publish them even if the event scan fails. When adding a server quota TTL, return the original collection time, not the time a cached response was served.

### Medium: direct correction semantics are incomplete

ADR 0002 accepts manual full resync for old corrections, but the UI has no full-resync action: [accepted mitigation](adr/0002-direct-mode-supabase-demoted.md#L96), [Settings sync](../apps/mobile/src/screens/SettingsScreen.tsx#L124). More subtly, `connectDirect` preserves cloud history and direct upsert refuses to update any positive-revision row: [mode transition](../apps/mobile/src/lib/app-context.tsx#L255), [guard](../apps/mobile/src/lib/direct.ts#L360). Even requesting all history cannot update such rows while direct is the primary backend.

Keep the cloud-mode opportunistic guard. For primary direct mode, define authority and source-generation comparison explicitly, or provide a reconciliation action that removes/reseeds the selected machine's stale authoritative rows safely. Shared IDs establish identity, not which source has the freshest correction. The ADR's claim that direct does not need provisional precedence and the implementation's inherited guard should be reconciled using this concrete case.

### Medium: setup and advertisement can describe an unusable connection

Passing daemon `--live-url` prevents the embedded server from starting, although the ADR describes it as an advertisement override: [condition](../apps/reporter/src/commands.ts#L311). It works only if a separately managed server already exists. Start the embedded server independently of the advertised URL, or document an explicit external-server mode.

Direct phone setup advertises “No cloud project,” but reporter `init` still requires a Supabase URL/key, and `serve` always loads that config: [init](../apps/reporter/src/commands.ts#L52), [serve](../apps/reporter/src/serve.ts#L178), [config schema](../apps/reporter/src/config.ts#L12). Provide direct-only machine initialization with optional cloud backup configuration. If startup falls back to loopback because Tailscale is unavailable, show a durable not-ready reason and recover/rebind after Tailscale starts rather than silently advertising a phone-inaccessible endpoint.

## Performance improvements, in order

### 1. Reuse validated normalized scan results across consumers

Share one bounded in-flight scan and its successful snapshot across HTTP requests and in-process daemon push. Keep a short freshness TTL and last-good snapshot; expose its age and whether refresh is running. A caller may use stale data while revalidation runs, but stale data must not be reported as a new successful scan.

Exact `sinceMs` cache keys alone have poor reuse: the phone advances its time cursor every successful pull. Cache a full normalized snapshot or a window covering the requested lower bound, then derive requested windows/pages cheaply. A tail-only snapshot cannot satisfy first backfill. Bound memory/cache generations and invalidate on parser pin, pricing version, scanner settings and source changes. Separate exporter-path/version resolution from per-request scanning; preserve strict pin checks on restart/change/TTL rather than indefinitely trusting a replaced binary.

A server cache eliminates duplicate scan construction and representation work, but a 30-second TTL still misses most 60-second probes. Measure and choose freshness intentionally. Hashing after a cold scan does not eliminate the scan itself.

### 2. Probe according to freshness, without cancel/restart thrashing

Replace unconditional minute full probes with foreground/gesture refresh plus cheap cached machine freshness checks, or bounded adaptive polling. Back off offline machines and avoid restarting work already in progress. Keep an explicit refresh path functioning while reducing the timer. Do not use `eventCount`/`maxOccurredAtMs` alone to infer no changes: corrections can change neither, and an old record can arrive late. Use source-generation or normalized-content change evidence.

### 3. Page initial backfill from a stable snapshot

Add deterministic ordering, bounded row/byte limits, `snapshotId`, continuation, `hasMore`, and expiry/restart behavior. Fetching each page must not respawn the exporter. Commit and publish each page while keeping the final incremental checkpoint separate from partial-backfill progress. Yield/release the writer between bounded pages so quotas and other machines can publish. Keep downloaded pages bounded too; parallel fetching followed by unbounded queues still consumes phone memory.

This improves time to first fresh row and resume reliability. If the first page still waits for a whole cold snapshot scan, it cannot eliminate that initial scan delay; cached snapshots or an upstream streaming/index seam are needed for that.

### 4. Run event and quota transfers independently; compress cached bodies

After a validated ping, start events and quotas in parallel and merge/publish each channel as it completes. Alternatively, return identity in independently usable event/quota envelopes and avoid the extra ping round trip. Preserve the slug/protocol safety check when collapsing calls. A combined response that waits for the slowest channel would recreate quota blocking.

Negotiate gzip using `Accept-Encoding`, set `Content-Encoding` and `Vary`, and reuse compressed bytes for a cached representation. Measure CPU and actual Android decompression; gzip is a strong candidate, not a zero-cost assumption. Add bounded compressed and decoded payload limits. Distinct wire versions must remain backward compatible or be negotiated explicitly.

Support `ETag`/unchanged-generation responses and teach the client to handle them without JSON parsing/upsert. The existing client treats 304 as an error: [HTTP helper](../packages/sync-api/src/live.ts#L96). Hash normalized content and stable identity, not the changing `generatedAt` field. Count inserted/changed rows separately from received rows: `pulledEvents` currently counts duplicates and rows blocked by the positive-revision guard, yet UI calls them new “not yet pushed” events: [status](../apps/mobile/src/lib/direct.ts#L455), [UI](../apps/mobile/src/screens/MachinesScreen.tsx#L215).

### 5. Eliminate full-result rebuilding only if profiling still justifies it

The pinned core already reuses unchanged parsed sources, but still reloads/reprices/collects history per process. Instrument source discovery, cache read/reuse, changed-source parsing, pricing, labels, serialization and merge separately. `LocalParseOptions.since` currently filters late too, so merely wiring it up is not the requested optimization.

If warm-result construction remains material, seek an upstream changed-source/normalized-message export seam or build an index of **tokscale-produced** messages keyed by stable message IDs and source generations. Do not implement provider parsers in burn. Preserve full-session attribution, deterministic fallback identities, rewrites/truncations, pricing changes and old corrections. A periodic/full reconciliation must remain available. Dictionary encoding or omitted string fields comes after cache reuse, safe cursors, paging and compression demonstrate remaining wire pressure.

## Information that should survive each expensive pull

Return a versioned envelope with identity, capabilities, snapshot/change generation, scan start/completion, original data/quotas collection time, cache age/hit, scan duration/counts, emitted rows/bytes, continuation and content hash. Distinguish reachability, scan success, event merge success and quota freshness.

Persist direct `last_ping_at`, last successful event/quota sync and last per-channel error; current registry updates happen only during add: [registry write](../apps/mobile/src/lib/direct.ts#L155). No `last_elapsed_ms` column exists today, so persisting elapsed time needs a migration. `pulledQuotas` already exists in `DirectPullStatus`, while scan duration/bytes do not: [type](../apps/mobile/src/lib/direct.ts#L39). The UI currently ignores those quota/elapsed fields.

Add a versioned model-pricing reference shared by direct and cloud paths, with decimal rates, provenance and refresh policy. Neither real path currently populates `model_prices`; only demo seed does: [seed](../apps/mobile/src/lib/sync.ts#L99). Thus a fresh real mirror has no savings prices, while a reused demo mirror can have stale demo prices. This is a missing real-data contract rather than a direct-only transfer omission.

Strictly validate all envelopes, ping identity/protocol, timestamps, safe integer nonnegative tokens/cursors, enums, optional fields and decimal money before writes. Current live validators silently coerce optional fields/status, cast unvalidated `costSource`, and discard quota `creditStatus`/`spendControl`: [events](../packages/sync-api/src/live.ts#L160), [quotas](../packages/sync-api/src/live.ts#L206). Cloud coercions have analogous problems; see the companion audit. Retain both machine-side export validation and phone-side peer validation, with bounded/cooperative work rather than removing the second gate.

## Recommended implementation sequence and acceptance checks

1. **Access and sync correctness:** quota authorization; per-environment/keyset cloud continuation; monotonic empty pages; migration/reconciliation for missed history. Prove against disposable PostgreSQL, including two machines at different revision levels and page boundaries within one revision.
2. **Functional direct reliability:** gestures, compatible deadlines, coalescing/cancellation, reset/registry parity, scan-aware cursor, last-good quotas, truthful channel status and direct-only setup. Exercise real HTTP sockets, abort while waiting for the writer, phone clock skew, reconnect after reset, and event failure with successful quotas.
3. **Warm-path cost:** shared scan/snapshot and quota TTLs, cached pin verification, freshness-aware probe policy, independent event/quota fetches and gzip. Assert concurrent callers use one scan, differing windows use covered snapshots safely, TTL expiry revalidates, pin/source changes invalidate, and cached quota timestamps never become artificially fresh.
4. **Large histories:** stable paged snapshots, durable resume, per-page publication and bounded memory/work queues. Disconnect midway, expire a snapshot, correct a row during paging, and pull several dynamic machines concurrently.
5. **Incremental machine indexing and richer contracts:** upstream changed-source seam, correction/full-resync path, pricing payload, content generation/ETag and durable timing diagnostics. Measure before committing to a compact row representation.

Validate Android time to cached first paint, first fresh row, quota update and completed backfill; machine scan CPU/RSS; transferred bytes; phone decode time; writer queue/commit time; retries and cancellation. Include idle, active, cold/warm, large history, offline machine and tailnet relay conditions. Existing tests and this desktop audit establish defects and baselines, not on-device speedup percentages.
