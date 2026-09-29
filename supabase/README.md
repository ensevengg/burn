# Supabase backend (BYO)

Your project is the only place your data lives. Setup is three pastes and one
`npx` command.

## Setup (per deployment)

1. Create a project at [supabase.com](https://supabase.com) (free tier is ample).
2. Open **SQL Editor** and run, in order:
   - `migrations/0001_schema.sql` — tables, indexes, RLS lockdown
   - `migrations/0002_api.sql` — the `burn_*` scoped-token RPCs
   - `migrations/0003_api_removal.sql` — machine removal from the app (− button)
   - `migrations/0004_quota_freshness.sql` — failed quota fetches never evict last-good numbers
   - `migrations/0005_delta_revision_index.sql` — delta query index
   - `migrations/0006_live_endpoint.sql` — optional machine endpoint advertisement
   - `migrations/0007_quota_authorization.sql` — read-token enforcement for quotas
   - `migrations/0008_environment_cursors.sql` — per-machine revision and event-id pagination
   - `migrations/0009_sync_delivery.sql` — per-machine refresh delivery and completion leases
   - `migrations/0010_channel_health.sql` — independent event, quota and connection health
   - `migrations/0011_quota_idempotency.sql` — retry-safe quota snapshots using collection time
3. On a machine you control: `npx burn-report init --url <project-url> --key <publishable-key> --slug cachyos --name "CachyOS"`
   It writes `~/.config/burn/config.json` + `~/.config/burn/setup-tokens.sql`.
   Paste that SQL into the editor too (registers the machine and your phone).
4. Phone app → Setup → paste project URL + publishable key + the **read token**
   that `init` printed.

Repeat step 3 per machine (distinct `--slug`; give Windows + WSL the same
`--host-group`).

## Trying it without machines

`seed/demo.sql` loads three fake environments (2,560 events, 30 days) with
fixed demo tokens (printed in the file header). Phone → Setup → paste URL +
publishable key + demo read token. **Demo tokens are public — use a throwaway
project, never production.**

## Security model (D7)

- Base tables: RLS enabled, zero policies. Direct reads/writes denied for
  `anon`/`authenticated` — verified (see `apps/reporter` tests + the pglite
  verification pass in the repo history).
- All access flows through `public.burn_*` security-definer RPCs gated by
  SHA-256-hashed tokens: one read token per phone, one ingest token per
  environment. Rotation revokes exactly one client.
- The Supabase secret key never leaves the dashboard. The publishable key is
  public by design; scoping comes from tokens.

## Operations

- Refresh schemas: edit migrations only additively; the phone re-syncs via the
  revision watermark after `burn-report` re-pushes.
- Inspect freshness: `select slug, last_heartbeat_at, latest_revision from burn.environments;`
- Revoke a phone: `update burn.read_tokens set revoked_at = now() where label = 'phone';`
