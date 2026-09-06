# ADR 0001 — Tailscale direct-pull (live machines)

Status: **accepted for v2** (in progress on `feat/tailscale-live-pull`) · Amends D1 · 2026-09-07

## Context

D1 fixed v1's data flow: machines push to the user's Supabase; the phone reads
the mirror; the phone never talks to machines. That keeps burn simple and
safe, but it caps freshness at the push cadence (10-min cron, ~30 s with the
daemon) — and "live" data (the current machine's un-pushed tail) is
unreachable by construction. D1 explicitly reserved Tailscale direct-pull as
the v2 door.

This ADR opens that door. Trigger: comparison with a peer app doing live
machine monitoring over Tailscale, and a concrete burn-shaped need — the
phone's numbers lag the booted machine by up to one push interval, which a
10-minute cron cannot fix.

## Decision

**Live pull is an additive enrichment layer over the unchanged mirror.** The
Supabase path remains the source of truth for history, offline rendering, and
corrections; the Tailscale path exists only to shorten the gap between "now"
and "the last push".

### Machine side

- `burn-report daemon` gains an embedded HTTP server (`--no-live` to disable);
  `burn-report serve` runs it standalone. Default bind: the tailnet IPv4
  (`tailscale ip -4`); loopback fallback with a loud warning; `--bind`/`--port`
  overrides.
- Endpoints (read-only, GET):
  - `/ping` — environment identity + contract version + the machine's
    `sinceMs` (its push cursor minus the overlap window) + machine clock.
  - `/live/events` — the same `IngestEventInput[]` rows the next `push` would
    send (same exporter, same schema gate, same dedup fallback, same cursor
    window). One scan at a time; concurrent callers get 503.
  - `/live/quotas` — tokscale quotas on demand. **Served but not yet merged by
    the phone** (deferral below).
- **Auth is tailnet membership.** No tokens cross this boundary; binding is
  the tailnet interface. `--live-url` overrides what gets advertised (e.g. a
  `tailscale serve` HTTPS URL, the recommended hardening).
- The endpoint URL is advertised via `burn_heartbeat` meta (`live_endpoint`).
  Advertisement semantics: absent preserves, empty/null clears, a URL sets.

### Server side

- Migration `0006_live_endpoint.sql`: nullable `burn.environments.live_endpoint`,
  heartbeat coalesce/clear semantics, `burn_fetch_delta` includes the column.

### Phone side

- Probe targets = mirror environments with a non-null `live_endpoint`.
- Probes run **only on app foreground and explicit refresh gestures** — never
  the per-minute timer (each probe triggers a machine-side exporter scan).
- Ping timeout 2.5 s (slow = offline; the mirror is already correct, live is
  opportunistic). Events timeout 60 s (real scans take seconds on large
  histories). Slug must match the mirror row — a reused address cannot inject
  rows under another environment.
- Merge invariants (the part that must never regress):
  1. Live rows are written with `revision = 0`; the upsert's `DO UPDATE ...
     WHERE usage_events.revision = 0` clause makes it impossible to overwrite
     a server-authoritative row (revision ≥ 1), in any interleaving.
  2. Event ids are computed with `liveEventId()` — byte-identical to
     `burn_ingest_events`' recipe (`sha256(slug|client|dedup_key)`, verified
     against node:crypto in `packages/sync-api/test/keys.test.ts`) — so the
     server's eventual row collides with the live copy and replaces it.
  3. The revision watermark is never advanced by the live path; the next
     cloud delta re-fetches everything live pulled early and converges.
  4. Writes take the shared mirror write lock, eviction happens inside the
     writer, and cancellation rides the same cloud generation counter as
     `cancelCloudSync` — resets and disconnects abort live pulls before they
     can commit.
- Quota snapshots are deliberately **not** merged live yet: the cloud quota
  pull replaces the snapshot table wholesale, so a fresher live row would be
  silently reverted on the next cloud pull. Live quota merge needs
  freshness-aware upserts first (deferral).

## Consequences

- Both paths coexist without reconciliation logic: the live path can only ever
  write rows the server will later confirm or replace, never fork history.
- Freshness on the booted machine improves from "one push interval" to
  "one app foreground". The dual-boot constraint is unchanged by design: the
  offline OS side exists only in the mirror until it boots and pushes; no
  cross-OS mounts.
- Free-tier Tailscale (6 users, unlimited user devices, no traffic caps) is
  ample: one user, one phone, a handful of machines — all user devices.
- Rollout is inert-by-default: machines that never run `daemon`/`serve` never
  advertise; phones without migration 0006 applied see `live_endpoint` null.

## Deferrals

1. Live quota merge (needs freshness-aware snapshot upserts).
2. `tailscale serve` HTTPS hardening as the documented default setup.
3. Live status surfaced on the dashboard headline (currently Machines tab only).
4. Background/ widget probing — rejected for battery and machine-load reasons
   unless a future ADR argues otherwise.
