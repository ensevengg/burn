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
  shared 400-row chunking.
- **Per-machine time cursors** (`kv: direct_since_v2_<envId>` = lastPullAt minus
  the overlap window), not one global revision watermark. The v1 protocol is
  time-cursor-based, identical to the push path's semantics.
- **Merges commit at the machine's served data directly** — there is no
  later server to supersede it, so the revision-0-provisional dance from
  ADR 0001 is unnecessary here. Event ids still come from `liveEventId()`
  (slug is still the machine's identity), so a machine's re-pull of the same
  message is the same row, and if a user ALSO runs cloud mode for the same
  machine, both paths still collide safely on one id.
- **Quotas merge on day one in direct mode** — per-environment, env-scoped
  row keys, idempotent upserts (no wholesale table replace, which is a
  cloud-path-only hazard). ADR 0001's live-quota deferral was about the
  cloud pull's delete-all semantics; direct mode doesn't have that problem.
- **Unchanged sources are cheap** — `burn-events --fingerprint` hashes the
  exact tokscale scanner result's path/size/mtime evidence (including SQLite
  WALs), pricing/settings metadata, parser pin, and machine timezone. The
  reporter caches one validated full snapshot per generation; the phone
  persists `direct_generation_v1_<envId>` and sends it on later pulls, so an
  unchanged machine returns an empty page without another exporter parse or
  overlap download. Missing/older exporters fall back to the uncached path.

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
