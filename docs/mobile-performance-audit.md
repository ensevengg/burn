# Mobile performance and quota freshness audit

Date: 2026-09-06. Scope: original findings plus the implemented follow-up below.

## Reproduction and limits

Run `bun run scripts/diagnostics/mobile-perf.ts` from the repository root. It uses synthetic events, an in-memory SQLite database, and production repository functions. It reads no credentials and makes no network calls. The original formatter-substitution experiment was confined to the diagnostic process; the current script measures the fixed production functions.

With 27,000 distinct event timestamps, the production historical-peak aggregation took 793 ms and delayed a zero-delay timer by 793 ms. A second pass with only Intl.DateTimeFormat construction intercepted to reuse formatters took 72 ms, timer delay 73 ms. An earlier baseline was 800 ms. These are Bun-on-Windows measurements, not Android/Hermes timings or a reproduction of actual tab taps. They demonstrate an event-loop stall in the screen's data path; on-device profiling is still needed to quantify the reported navigation freeze.

Quota cases through the real queryQuotas SQL and mapper:

- Same account and label, older 20% and newer 50%: correctly returns one card at 50%.
- Same account with different labels: returns two cards instead of one. The cloud RPC normally preselects one row per account/metric, so this case principally exposes a local grouping contract defect, not proof of the reported cloud problem.
- Different account IDs with the same label: returns one card instead of two. This can also affect cloud data.

## Prioritized findings

### 1. High: timezone bucketing blocks the UI thread

`apps/mobile/src/lib/format.ts:16` constructs an Intl.DateTimeFormat for each timestamp cache miss. At line 25 the entire timestamp cache clears after roughly 8k entries. Sequential scans larger than the cache repeatedly rebuild formatters. `queryGranularityMax` loads all history and synchronously buckets it; async database access does not make the following JavaScript loop interruptible.

Reuse a bounded formatter cache by timezone. Then share bucket results and chunk large mapping/aggregation work with event-loop yields; cancel obsolete work on range changes or loss of focus. Preserve reporting-timezone semantics and the all-history fixed chart ceiling. Do not substitute machine source dates or persist day keys. Formatter reuse alone still exceeded a frame budget in the PC benchmark.

### 2. High: refresh can finish before a machine pushes

`apps/mobile/src/lib/app-context.tsx:114` schedules exactly one cloud pull after 6 seconds. The reporter polls requests every 30 seconds (`apps/reporter/src/commands.ts:350`), then exports/uploads events before collecting quotas. If the request arrives just after a poll, the phone can finish its follow-up long before the new Windows snapshot exists. There is no subsequent polling or app-resume sync in this provider; the next manual sync or app remount is needed to fetch that result.

Use a bounded, cancellable refresh loop that covers daemon polling plus upload latency, ideally using explicit request completion state. Keep cached data visible, expose pending/timeout state, coalesce duplicate requests, and cancel timers when disconnecting or changing backend. A larger single fixed delay would remain unreliable.

### 3. High: quota freshness depends on event backfill succeeding

`apps/mobile/src/lib/sync.ts:230` fetches quotas only after up to eight event pages. Each event is written with its own awaited runAsync call at line 179. An event-fetch/write failure prevents the quota fetch entirely. In the reporter, runPush uploads only events; runUsage is separate. A healthy event push or heartbeat does not establish a successful vendor quota fetch.

Fetch quotas independently of events and publish each successful mirror update promptly. Preserve serialized writes, atomic page transactions and post-commit revision watermarks. Batch cloud event inserts using bound parameters in conservative chunks; demo seeding is already batched. Coalesce simultaneous cloud pulls rather than queuing complete redundant syncs. Keep write locking but avoid holding it over unrelated network waiting, with explicit protection against reset/backend-switch races.

For the reported Windows case, first distinguish: successful event upload, successful quota upload, and phone pull after that upload. Existing server selection (`supabase/migrations/0004_quota_freshness.sql:14`) picks the freshest successful snapshot per provider/account_key/metric across environments; it does not prefer CachyOS. The deployed migration state, actual Windows account ID and vendor-fetch result were not inspected.

### 4. Medium: screens repeat full event loads and hidden work

Explore starts four queries at once (`apps/mobile/src/screens/ExploreScreen.tsx:31`) even though only one subsection is visible. Each loads/maps the same event window. History starts history, historical max, daily totals and records queries; the latter three overlap heavily. Cost/Tokens changes also use separate max-query keys despite both maxima being derivable in one pass. Every sync invalidates all queries, even if no events changed, and query hooks have no screen-focus gate.

Enable only the visible Explore subsection and focused-screen work. Share event-window/aggregation results, derive both maxima together, and invalidate only affected data families. Scope cached derived results to mirror changes, timezone and time window; include rollover invalidation as time advances. Use SQL grouping for timezone-independent totals where decimal semantics can be preserved, or chunked shared JavaScript aggregation; do not silently move money calculations to lossy SQLite REAL sums.

### 5. Medium: mobile subscription identity uses labels

`apps/mobile/src/data/repository.ts:602` omits account_key from the projection and deduplicates by account_label. Dashboard groupSubscriptions repeats label-based grouping. This disagrees with the server's provider/account_key/metric identity and can hide a separate account or split one account's metrics when labels change.

Carry accountKey in QuotaCard, deduplicate by provider/accountKey/metric, and group cards by provider/accountKey. Keep labels for display only. Cover same-account/different-label and different-account/same-label cases with regression tests. This confirmed defect alone does not explain a newer same-account/same-label Windows snapshot being ignored: that test passes.

### 6. Medium: unvirtualized lists and unnecessary session materialization

Explore renders every breakdown row inside a ScrollView (`ExploreScreen.tsx:61`). Sessions display at most 60 rows, but querySessions still loads, groups and sorts the entire selected event window before slicing (`repository.ts:497`). Large workspace/model counts increase view creation, while large histories inflate allocations even for short session lists.

Use a virtualized list for growing breakdowns and sessions, and select/page session identities before materializing their details. Session identity must include environment (and client where appropriate); the current sessionId-only grouping also merges sessions across machines, contrary to D6.

## Suggested order and verification

1. Reuse formatters, gate hidden Explore work, share historical aggregation; profile rapid tab changes with at least 27k rows on Android.
2. Make quota refresh independent and wait for machine completion with bounded polling; test a request just after a daemon poll and an event-sync failure.
3. Fix account identity in repository and UI, test cross-machine freshness and label collisions.
4. Batch cloud writes, narrow invalidation, virtualize growing lists and page sessions.

Acceptance checks should include cold and warm page navigation during backfill, rapid range changes, a quota-only machine update with no event revision change, offline CachyOS plus online Windows using the same account, two distinct accounts sharing a label, and disconnect during a pending refresh. The exact live subscription issue remains unconfirmed until the upload/pull timeline is observed.

## Implemented follow-up (2026-09-06)

The original findings above describe the pre-fix code. The current diagnostic runs against the fixed implementation; account-identity cases now pass.

- Cached timezone formatters; shared bounded event/bucket caches; roughly 4 ms cooperative work budgets; cancellation for obsolete per-screen aggregation; focused/visible query gating and finite query-cache retention.
- Virtualized Explore lists; SQL selects the most recent session identities before decoding details; sessions remain separate across environments and clients.
- Independent quota/event downloads and serialized local commits; parameterized 32-row cloud inserts (896 bindings); immediate invalidation of the affected data family; overlapping cloud pulls coalesce; lifecycle generations reject stale backend responses after reset.
- Machine refresh checks every six seconds for up to two minutes after requesting a push. The app also pulls on foreground entry and every minute while active. The API does not expose completed request generations, so the bounded follow-up does not claim machine completion; offline machines remain visibly stale.
- Scheduled reporter `push` now uploads events and quotas independently. The daemon uses the same operation and prevents overlapping poll cycles. `usage` remains available as the quota-only command.

Final desktop sample: synchronous historical bucketing of 27k events took 71 ms (original: roughly 800 ms). The production cooperative query, with a mock native read, took 521 ms overall and serviced 33 timer ticks, with a maximum gap of 20 ms. The yields trade some total latency for responsiveness; these are not Android/Hermes measurements and exclude native SQLite transfer costs in the cooperative benchmark.

Validation: workspace typecheck and regression tests cover identity collisions, delayed machine responses, quota success during slow/failed event sync, cancellation, batched writes and rollback/watermarks, session selection before decoding, and cache invalidation. No Supabase migration is required. Reload/rebuild the mobile app and restart reporters using the updated source; an already published npm reporter is not updated by this workspace change.

## Second pass (2026-09-06, post-review fixes)

A follow-up review of the implemented work found one significant regression path and several interaction gaps; all are addressed in the same working tree:

- **Event queries no longer heartbeat.** The 60s `refetchInterval` applied to every focused query re-read and re-aggregated each screen's full window every minute (minute-rolling `loadEvents` keys defeated the shared caches). Event queries now rely on the scoped mirror-change invalidations; only the tiny quotas/machines queries keep a 60s heartbeat.
- **Cache eviction lives in the writers.** `resetDb`, the demo seeder, and `removeEnvironmentLocal` evict the shared event cache right after their deletes commit (inside the write lock); the caller-side invalidates and the pre-write evictions are gone. A regression test holds the delete open while a read races it and asserts the cached pre-delete rows do not survive the commit.
- **Backfill progress is a notice, not an error.** `syncNotice` renders separately from `syncError`; the whole pull-status surface (`lastSync`, errors, notices, spinner flags) moved into a dedicated `useSyncStatus` context so per-minute `lastSync` ticks no longer re-render every `useApp()` consumer.
- **Pull-to-refresh settles.** The refresh spinner now covers only the first pull after a machine-refresh request (`followMachineUpdates` `onSettle`, released exactly once even when cancelled pre-pull); the two-minute follow-up is reflected by a "Checking machines…" label via `checkingMachines`. Demo mode drives the spinner from the gesture itself so heartbeat refetches cannot blip it.
- **Window changes keep their chart.** `keepPreviousData` on the window/metric-keyed queries (history, granularity-max, window-overview, models, clients, workspaces, sessions) — TanStack's `NonFunctionGuard` on `placeholderData` required pinning `TData` via an annotated options object.
- **All touch targets are Pressable.** Segmented controls, contribution-grid cells, and every custom button converted from `View onTouchEnd` — press feedback and ripple, scroll gestures no longer mis-trigger taps, and screen-reader roles/labels are set. Contribution-grid cells are memoized so a selection tap re-renders two cells, not the 371-cell grid.
- **Small correctness/consistency:** the dashboard token headline and provider-share denominators now include reasoning tokens (they disagreed with the totals strip, and shares could exceed 100%); `computeStreaks` walks the active ordinals instead of every day since 2000; duplicate `DailyTotals`/`RecordStats` declarations removed; the 32-row cloud insert chunk documents its binding math.
- **Migration 0005** adds `usage_events (revision, event_id)` so `burn_fetch_delta`'s global revision scan stays fast as history grows — the one server-side item from the review.

Typecheck clean; 31 tests pass, including the new writer-eviction race and follow-up `onSettle` cases. Android timing validation remains the open item.

## Direct-sync smoothing pass (2026-09-08)

Branch `perf/sync-smoothness` addresses the work introduced when direct mode
became primary:

- The resident reporter fingerprints tokscale's discovered source files,
  SQLite WALs, scanner/pricing inputs, parser pin and timezone. It caches one
  fully validated event snapshot per generation. Real local fingerprint probes
  took 3–5 ms; a warm release build exported and schema-validated 1,896 real
  rows in 58 ms. An earlier cold debug-path smoke took 29.8 s initially and
  6 ms for the unchanged follow-up. Timings remain machine-specific.
- Direct and cloud-live callers coalesce instead of cancelling/restarting the
  same machine scan. Direct events and quotas start concurrently; live quotas
  have a five-minute machine-side TTL.
- The phone persists each machine's source generation. Matching pulls return
  no overlap payload, and identical fallback overlaps no longer write rows,
  evict event caches, or invalidate focused screen queries.
- Event mirror writes increased from 32 to 400 rows per bound statement:
  11,200 bindings under Expo SQLite's 32,766 limit. A 27k-row backfill drops
  from 844 bridge calls to 68 without interpolating user data.
- Cloud connections now decrypt SecureStore values and construct the backend
  adapter once per connected lifecycle. The daemon's eager poll remains at
  the D1 default of 30 seconds. Migration `0007` replaces the idle delta tail count with an
  indexed `exists` probe and preserves the caller watermark on empty pages.
- Live event responses use gzip when the phone advertises it; direct pull-to-
  refresh now actually probes machines and displays the direct backend state.

Validation on the branch: 117 Bun tests across all workspaces, one Rust test,
workspace typecheck, Rust release build/check, the existing 27k synthetic
diagnostic, and the real exporter/live-handler smoke above. Release-build
Android frame
timing is still the remaining device-only check.
