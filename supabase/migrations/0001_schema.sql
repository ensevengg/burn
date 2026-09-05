-- burn · 0001_schema.sql
-- Core tables. RLS is enabled with NO policies: direct table access is denied
-- for every role. All reads/writes go through burn_api.* security-definer RPCs
-- gated by scoped tokens (see 0002_api.sql). Run this in the Supabase SQL editor.

-- Token hashing uses core sha256() (Postgres 11+) — no extensions required.

create schema if not exists burn;
create schema if not exists burn_api;

-- ── environments ─────────────────────────────────────────────────────────────
-- One row per reporter installation (windows / wsl / cachyos). WSL and Windows
-- are one physical machine: give both the same host_group so the per-machine
-- screen can group them later.
create table if not exists burn.environments (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text unique not null,
  display_name         text not null,
  host_group           text,
  os_kind              text not null check (os_kind in ('windows', 'wsl', 'linux', 'macos')),
  ingest_token_hash    text unique not null,          -- sha256 hex of the ingest token
  reporter_version     text,
  tokscale_version     text,
  export_schema        integer,
  reporting_timezone   text,                          -- evidence only; bucketing happens on the phone
  last_heartbeat_at    timestamptz,
  last_success_at      timestamptz,
  last_error           text,
  latest_revision      bigint not null default 0,
  created_at           timestamptz not null default now()
);

-- ── usage_events ─────────────────────────────────────────────────────────────
-- Raw per-message usage rows (tokscale UnifiedMessage), one row per message.
-- event_id is computed server-side from (environment slug, client, dedup_key)
-- so identity is stable across parser/pricing corrections.
create table if not exists burn.usage_events (
  event_id                     text primary key,
  environment_id               uuid not null references burn.environments(id) on delete cascade,
  client                       text not null,              -- tokscale client id: codex, opencode, zcode, …
  provider_id                  text not null,
  model_id                     text not null,
  session_id                   text not null,
  session_title                text,
  workspace_key                text,
  workspace_label              text,
  agent                        text,
  occurred_at                  timestamptz not null,       -- authoritative UTC instant
  source_offset_minutes        integer,                    -- machine-local UTC offset when recorded
  source_timezone              text,                       -- IANA zone when discoverable
  source_local_date            date,                       -- audit value matching the machine's view
  input_tokens                 bigint not null default 0 check (input_tokens >= 0),
  output_tokens                bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens            bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens           bigint not null default 0 check (cache_write_tokens >= 0),
  reasoning_tokens             bigint not null default 0 check (reasoning_tokens >= 0),
  message_count                integer not null default 1 check (message_count > 0),
  is_turn_start                boolean not null default false,
  duration_ms                  bigint,
  cost                         numeric(14, 6) not null default 0,
  cost_source                  text not null default 'unknown' check (cost_source in ('unknown', 'provider_reported', 'estimated')),
  cost_is_complete             boolean not null default false,  -- false = pricing incomplete; do not conflate with free
  model_attribution_conflicted boolean not null default false,
  parser_version               text not null,
  revision                     bigint not null,            -- environment revision that wrote this row
  inserted_at                  timestamptz not null default now()
);

create index if not exists usage_events_env_rev_idx    on burn.usage_events (environment_id, revision);
create index if not exists usage_events_occurred_idx   on burn.usage_events (occurred_at);
create index if not exists usage_events_session_idx    on burn.usage_events (environment_id, session_id);
create index if not exists usage_events_client_idx     on burn.usage_events (client);
create index if not exists usage_events_model_idx      on burn.usage_events (model_id);
create index if not exists usage_events_workspace_idx  on burn.usage_events (workspace_key);

-- ── quota_snapshots ──────────────────────────────────────────────────────────
-- Vendor-reported account-level limits (tokscale usage --json). Append-only;
-- the app selects the freshest successful snapshot per (provider, account, metric)
-- and keeps failures as diagnostics — a missing entry is never "unlimited".
create table if not exists burn.quota_snapshots (
  id                    bigint generated always as identity primary key,
  environment_id        uuid not null references burn.environments(id) on delete cascade,
  provider              text not null,
  account_key           text not null,               -- stable per-account identity (hash of provider account id)
  account_label         text,
  plan                  text,
  metric                text not null,               -- e.g. 'session_5h', 'weekly', 'tokens'
  used_percent          numeric(5, 2),
  remaining_percent     numeric(5, 2),
  remaining_label       text,
  resets_at             timestamptz,
  credit_status         jsonb,
  spend_control         jsonb,
  status                text not null check (status in ('ok', 'error')),
  error                 text,
  fetched_at            timestamptz not null default now(),
  source_offset_minutes integer,
  export_schema         integer not null default 1
);

create index if not exists quota_snapshots_provider_idx on burn.quota_snapshots (provider, account_key, metric, fetched_at desc);

-- ── sync_requests ────────────────────────────────────────────────────────────
-- Phone-to-reporter rendezvous. The phone inserts a request (generation counter
-- is the identity); resident daemons observe newer generations and push eagerly.
create table if not exists burn.sync_requests (
  generation          bigint generated always as identity primary key,
  target_environment  uuid references burn.environments(id) on delete cascade,  -- null = all environments
  requested_at        timestamptz not null default now(),
  acknowledged_at     timestamptz,
  completed_revision  bigint,
  status              text not null default 'pending' check (status in ('pending', 'acknowledged', 'completed', 'failed'))
);

-- ── read_tokens ──────────────────────────────────────────────────────────────
-- Phone-side scoped credentials (hash only). Revoking one row kills one phone's
-- access without touching data or other clients.
create table if not exists burn.read_tokens (
  token_hash   text primary key,           -- sha256 hex
  label        text,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

-- ── lockdown ─────────────────────────────────────────────────────────────────
-- Deny direct table access to client roles; the postgres-role-owned burn_api
-- functions are the only door, and they check scoped tokens internally.
alter table burn.environments    enable row level security;
alter table burn.usage_events    enable row level security;
alter table burn.quota_snapshots enable row level security;
alter table burn.sync_requests   enable row level security;
alter table burn.read_tokens     enable row level security;

revoke all on all tables in schema burn from anon, authenticated;
revoke all on all sequences in schema burn from anon, authenticated;
revoke all on all functions in schema burn_api from public, anon, authenticated;
