# ADR 0002 — Direct mode: machines as the backend, Supabase demoted to backup

Status: **implemented** on `feat/tailscale-live-pull` (commits `655fe34`, `f1491a6`) · Refines D3/D4 · Builds on [ADR 0001](0001-tailscale-direct-pull.md) · 2026-09-07

## Context

ADR 0001 added live pull as an additive freshness layer over the Supabase
mirror. Living with it clarified the product reality:

- **Freshness never needed Supabase.** The live path delivers seconds-fresh
  data whenever a machine is reachable — and this user's laptop (dual-boot
  CachyOS/Windows, carrying their code and tooling) is effectively always up.
- **Onboarding complexity does come from Supabase**: project creation, SQL
  pastes, token ceremony, migrations. For a self-hosted app, "install
  Tailscale, run one command, add the machine on the phone" is a strictly
  better first-run story.
- What Supabase still uniquely provides is **durability** (history survives
  machine reinstalls/disk loss) and **offline-phone re-seeding** (a new phone
  rebuilds from the ledger without touching machines).

Owner decision (2026-09-07): Supabase is **demoted to backup** — it stays
deployed and keeps accumulating history exactly as today, but direct mode
becomes the primary path and the app must work with no Supabase project at
all. Removal is explicitly out of scope; demolition without daily-driven
replacement is how you end up with no working app.

## Decision

**Direct mode is a second backend, not a fork.** The machines (their existing
live servers) act as the data source; the phone's mirror keeps every property
users already have — instant local-first rendering, offline history,
idempotent merges. The Supabase path remains fully functional and untouched
(D3's backend seam was built for exactly this swap).

### Machine registry on the phone

- New mirror table `direct_machines (id, slug, base_url, display_name,
  added_at, last_ping_at, last_error)` (+ `create if not exists`/ALTER parity
  in `db.ts`). Machine URLs are not secrets — tailnet membership is the
  credential (ADR 0001) — so kv/mirror storage, not SecureStore.
- Added via Machines "+" → paste the machine's endpoint (it prints it on
  startup; `--live-url` for a `tailscale serve` HTTPS URL). Adding validates
  with `/ping` and refuses a slug already present. QR onboarding is a
  deferral.
- Removal deletes the local rows (env + events + quotas + cursor) — nothing
  server-side exists to cascade.

### Pull driver

- New `pullDirect(db, machines, …)` beside `pullCloud` — same write-lock,
  same cache-eviction-in-writer, same generation-based cancellation, same
  32-row chunking.
- **Per-machine time cursors** (`kv: direct_since_v3_<envId>` = completed machine scan start,
  with an overlap subtracted when requesting the next window), not one global revision watermark. The cloud delta uses environment revision/event-id cursors;
  direct cursors describe the machine scan, never the phone merge time.
- **Merges commit at the machine's served data directly** — there is no
  later server to supersede it, so the revision-0-provisional dance from
  ADR 0001 is unnecessary here. Event ids still come from `liveEventId()`
  (slug is still the machine's identity), so a machine's re-pull of the same
  message is the same row, and if a user ALSO runs cloud mode for the same
  machine, both paths still collide safely on one id.
- **Quotas merge on day one in direct mode** — per-environment, env-scoped
  row keys split successes from diagnostics, with collection-time comparisons.
  Both cloud and direct merges preserve a newer successful sample.
  ADR 0001's original delete-all hazard is resolved by the shared merge.

### Modes and UI

- `AppMode` gains `"direct"` (kv `mode` = direct). Setup screen gains a third
  card: "Connect machines directly (Tailscale)" — no Supabase project, no
  tokens. Settings shows the backend and machine list.
- Machines tab reuses ADR 0001's live status lines verbatim (they were built
  on this data path). Pull-to-refresh in direct mode simply probes machines —
  the rendezvous/`sync_requests` flow is cloud-mode-only.
- Existing cloud users migrate by doing nothing: `mode = cloud` keeps working,
  and a machine can serve both paths at once (daemon + live server) with the
  two merges colliding harmlessly on one event id.

## Invariants carried over unchanged

1. All mirror writes take the shared write lock; cache eviction inside the
   writer.
2. Cancellation via the cloud generation counter (renamed conceptually: the
   sync generation) — reset/disconnect/mode-change aborts before commit.
3. Event identity is server/machine-recipe-derived, never invented at call
   sites (`keys.ts` stays the only place keys are defined).
4. Money is decimal strings end-to-end (D8); every payload validated before
   touching the mirror (D2's gate, now on the phone side too via
   `parseLiveEventsPage`).

## What Supabase's demotion costs (accepted, with mitigation)

- **Durability**: history now lives on machine-local files + the phone mirror.
  Mitigation: Supabase stays as the standing backup; a future one-tap
  "export/backup to cloud" from a machine is a deferral, not part of Phase 1.
- **Corrections**: the revision-based rewrite-history story (D5) is
  time-cursor-based here; parser/pricing corrections to *old* rows need a
  manual per-machine "full resync" in v1. Revision-aware corrections are a
  deferral (machines would expose a data-generation counter).
- **Union on re-seed**: a new phone pulls from whichever machines are online;
  the dual-boot's offline OS side arrives when that OS next boots. Same
  semantics as live pull today.

## Deferrals

1. Revision-aware corrections (machine-side data-generation counter).
2. QR-based add-machine onboarding.
3. One-tap cloud backup export (Supabase stays the passive backup meanwhile).
4. `tailscale serve` HTTPS as the documented default endpoint.

## Sequencing

1. Mirror table + mode plumbing + Setup third card.
2. `pullDirect` driver + direct-machines registry + add/remove UX.
3. Quota upserts + Machines live-status reuse.
4. Dogfood as the owner's daily mode; Supabase untouched underneath the whole
   time — the escape hatch is the point.

## Connection reliability implementation — 2026-09-30

Direct mode treats machine data as authoritative: changed direct rows can
replace an earlier cloud revision. Opportunistic live pulls in cloud mode
retain the revision-0 guard. Cloud revision cursors are unchanged by either
peer path. Choosing direct mode preserves existing cloud history; entering it
from the bundled demo clears demo history and reference prices.

First pulls request `since=0`. V3 cursor keys force one corrective replay for
older installs that used a recent-tail first pull or the phone's clock. Pages
commit with their durable snapshot continuation, publish immediately and
resume automatically while foregrounded. A completed window checkpoints its
machine scan start; expired continuations restart idempotently. Foreground
and gestures trigger fresh probes; minute timers trigger cloud reads only.
Periodic full reconciliation on a foreground/gesture pull after 24 hours,
and the Machines full-history action, capture corrections outside the overlap.

Live server snapshots share one in-flight exporter scan, a 30-second result
cache and a five-minute pin check. Quotas share a 45-second collection cache.
After identity validation, event and quota fetches run independently. Pages
are at most 1,000 rows and approximately 4MB decoded; gzip and conditional
GETs reduce repeated transfer. Old clients omitting page limits retain their
original response shape.

Cloud mode requires migrations through 0011, including environment-scoped
revision/event-id cursors, durable refresh deliveries and channel health.
Direct-only reporter initialization needs no cloud URL, key or tokens.
See [connection-transfer-fixes.md](../connection-transfer-fixes.md) for checks,
upgrade instructions and remaining work.
