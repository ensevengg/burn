-- burn · 0002_api.sql
-- The only door into the database: token-gated security-definer RPCs.
--   * phone   → read token            → burn_fetch_delta / burn_fetch_quota_latest / burn_request_sync
--   * reporter→ per-env ingest token  → burn_heartbeat / burn_ingest_events /
--                                burn_push_quota_snapshot / burn_poll_sync_requests
-- Public entry points live in the `public` schema (PostgREST's default exposed
-- schema — zero dashboard configuration for BYO users), prefixed `burn_`.
-- Token helpers live in the internal `burn_api` schema and are never granted.
-- Tokens are random strings from `burn-report init`; only SHA-256 hashes are
-- stored. Compromise of one token is revocable without touching data.
-- Run after 0001_schema.sql.

-- ── internal token checks ────────────────────────────────────────────────────

create or replace function burn_api._env_for_ingest_token(p_ingest_token text)
returns burn.environments
language sql stable security definer set search_path = ''
as $$
  select e.*
  from burn.environments e
  where e.ingest_token_hash = encode(sha256(convert_to(p_ingest_token, 'utf8')), 'hex')
    and p_ingest_token is not null and length(p_ingest_token) between 24 and 128;
$$;

create or replace function burn_api._assert_read_token(p_read_token text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_read_token is null
     or length(p_read_token) not between 24 and 128
     or not exists (
       select 1 from burn.read_tokens t
       where t.token_hash = encode(sha256(convert_to(p_read_token, 'utf8')), 'hex')
         and t.revoked_at is null
     ) then
    raise exception 'invalid read token' using errcode = 'P0001';
  end if;
end;
$$;

-- ── reporter API ─────────────────────────────────────────────────────────────

create or replace function public.burn_heartbeat(p_ingest_token text, p_meta jsonb default '{}')
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_env burn.environments;
begin
  select * into v_env from burn_api._env_for_ingest_token(p_ingest_token);
  if v_env.id is null then
    raise exception 'invalid ingest token' using errcode = 'P0001';
  end if;

  update burn.environments set
    reporter_version   = coalesce(p_meta->>'reporter_version', reporter_version),
    tokscale_version   = coalesce(p_meta->>'tokscale_version', tokscale_version),
    export_schema      = coalesce((p_meta->>'export_schema')::integer, export_schema),
    reporting_timezone = coalesce(p_meta->>'reporting_timezone', reporting_timezone),
    last_heartbeat_at  = now(),
    last_success_at    = now()
  where id = v_env.id;

  return jsonb_build_object('environment_id', v_env.id, 'slug', v_env.slug, 'server_time', now());
end;
$$;

create or replace function public.burn_report_error(p_ingest_token text, p_error text)
returns void
language sql volatile security definer set search_path = ''
as $$
  update burn.environments set last_error = left(p_error, 500), last_heartbeat_at = now()
  where id = (burn_api._env_for_ingest_token(p_ingest_token)).id;
$$;

-- One reporter batch = one revision. Rows carry EXCLUDED.revision only when
-- their content actually changed, so unchanged rows never advance the phone's
-- watermark and parser corrections to old events DO propagate.
create or replace function public.burn_ingest_events(p_ingest_token text, p_events jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_env        burn.environments;
  v_revision   bigint;
  v_changed    integer;
begin
  select * into v_env from burn_api._env_for_ingest_token(p_ingest_token);
  if v_env.id is null then
    raise exception 'invalid ingest token' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'p_events must be a JSON array' using errcode = 'P0001';
  end if;

  update burn.environments
     set latest_revision   = latest_revision + 1,
         last_success_at   = now(),
         last_heartbeat_at = now(),
         last_error        = null
   where id = v_env.id
   returning latest_revision into v_revision;

  with incoming as (
    select
      -- NB: || and ->> share precedence; the (e->>'…') parens are load-bearing.
      encode(sha256(convert_to(v_env.slug || '|' || coalesce(nullif((e->>'client'), ''), 'unknown') || '|' || (e->>'dedup_key'), 'utf8')), 'hex') as event_id,
      v_env.id                                   as environment_id,
      coalesce(nullif(e->>'client', ''), 'unknown')     as client,
      coalesce(nullif(e->>'provider_id', ''), 'unknown') as provider_id,
      coalesce(nullif(e->>'model_id', ''), 'unknown')    as model_id,
      coalesce(nullif(e->>'session_id', ''), 'unknown')  as session_id,
      e->>'session_title'                        as session_title,
      e->>'workspace_key'                        as workspace_key,
      e->>'workspace_label'                      as workspace_label,
      e->>'agent'                                as agent,
      to_timestamp((e->>'occurred_at_ms')::bigint / 1000.0) as occurred_at,
      (e->>'source_offset_minutes')::integer     as source_offset_minutes,
      e->>'source_timezone'                      as source_timezone,
      (e->>'source_local_date')::date            as source_local_date,
      greatest(0, coalesce((e->>'input_tokens')::bigint, 0))        as input_tokens,
      greatest(0, coalesce((e->>'output_tokens')::bigint, 0))       as output_tokens,
      greatest(0, coalesce((e->>'cache_read_tokens')::bigint, 0))   as cache_read_tokens,
      greatest(0, coalesce((e->>'cache_write_tokens')::bigint, 0))  as cache_write_tokens,
      greatest(0, coalesce((e->>'reasoning_tokens')::bigint, 0))    as reasoning_tokens,
      greatest(1, coalesce((e->>'message_count')::integer, 1))      as message_count,
      coalesce((e->>'is_turn_start')::boolean, false)               as is_turn_start,
      (e->>'duration_ms')::bigint                as duration_ms,
      coalesce((e->>'cost')::numeric(14, 6), 0)  as cost,
      coalesce(e->>'cost_source', 'unknown')     as cost_source,
      coalesce((e->>'cost_is_complete')::boolean, false) as cost_is_complete,
      coalesce((e->>'model_attribution_conflicted')::boolean, false) as model_attribution_conflicted,
      coalesce(e->>'parser_version', 'unknown')  as parser_version,
      v_revision                                 as revision
    from jsonb_array_elements(p_events) as e
  ), upserted as (
    insert into burn.usage_events as u (
      event_id, environment_id, client, provider_id, model_id, session_id,
      session_title, workspace_key, workspace_label, agent,
      occurred_at, source_offset_minutes, source_timezone, source_local_date,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      message_count, is_turn_start, duration_ms,
      cost, cost_source, cost_is_complete, model_attribution_conflicted,
      parser_version, revision
    )
    select * from incoming
    on conflict (event_id) do update set
      session_title                = excluded.session_title,
      workspace_key                = excluded.workspace_key,
      workspace_label              = excluded.workspace_label,
      agent                        = excluded.agent,
      provider_id                  = excluded.provider_id,
      model_id                     = excluded.model_id,
      input_tokens                 = excluded.input_tokens,
      output_tokens                = excluded.output_tokens,
      cache_read_tokens            = excluded.cache_read_tokens,
      cache_write_tokens           = excluded.cache_write_tokens,
      reasoning_tokens             = excluded.reasoning_tokens,
      message_count                = excluded.message_count,
      is_turn_start                = excluded.is_turn_start,
      duration_ms                  = excluded.duration_ms,
      cost                         = excluded.cost,
      cost_source                  = excluded.cost_source,
      cost_is_complete             = excluded.cost_is_complete,
      model_attribution_conflicted = excluded.model_attribution_conflicted,
      parser_version               = excluded.parser_version,
      revision                     = excluded.revision,
      inserted_at                  = now()
      -- identity columns and occurred_at never change; only content edits
      -- (pricing/parser fixes) advance the revision and trigger re-sync
      where (u.provider_id, u.model_id, u.session_title, u.workspace_key, u.workspace_label, u.agent,
             u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens,
             u.message_count, u.is_turn_start, u.duration_ms, u.cost, u.cost_source, u.cost_is_complete,
             u.model_attribution_conflicted, u.parser_version)
        is distinct from
            (excluded.provider_id, excluded.model_id, excluded.session_title, excluded.workspace_key, excluded.workspace_label, excluded.agent,
             excluded.input_tokens, excluded.output_tokens, excluded.cache_read_tokens, excluded.cache_write_tokens, excluded.reasoning_tokens,
             excluded.message_count, excluded.is_turn_start, excluded.duration_ms, excluded.cost, excluded.cost_source, excluded.cost_is_complete,
             excluded.model_attribution_conflicted, excluded.parser_version)
    returning 1
  )
  select count(*) into v_changed from upserted;

  return jsonb_build_object(
    'environment_id', v_env.id,
    'slug',           v_env.slug,
    'revision',       v_revision,
    'rows',           jsonb_array_length(p_events),
    'changed',        v_changed
  );
end;
$$;

create or replace function public.burn_push_quota_snapshot(p_ingest_token text, p_snapshots jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_env burn.environments;
begin
  select * into v_env from burn_api._env_for_ingest_token(p_ingest_token);
  if v_env.id is null then
    raise exception 'invalid ingest token' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_snapshots) <> 'array' then
    raise exception 'p_snapshots must be a JSON array' using errcode = 'P0001';
  end if;

  insert into burn.quota_snapshots (
    environment_id, provider, account_key, account_label, plan,
    metric, used_percent, remaining_percent, remaining_label, resets_at,
    credit_status, spend_control, status, error, source_offset_minutes, export_schema
  )
  select
    v_env.id,
    coalesce(s->>'provider', 'unknown'),
    coalesce(s->>'account_key', 'no-account'),
    s->>'account_label',
    s->>'plan',
    coalesce(s->>'metric', 'unknown'),
    (s->>'used_percent')::numeric(5, 2),
    (s->>'remaining_percent')::numeric(5, 2),
    s->>'remaining_label',
    case when coalesce(nullif(s->>'resets_at', ''), '') <> '' then (s->>'resets_at')::timestamptz end,
    s->'credit_status',
    s->'spend_control',
    coalesce(s->>'status', 'ok'),
    s->>'error',
    (s->>'source_offset_minutes')::integer,
    coalesce((s->>'export_schema')::integer, 1)
  from jsonb_array_elements(p_snapshots) as s;

  update burn.environments
     set last_heartbeat_at = now(), last_success_at = now(), last_error = null
   where id = v_env.id;

  return jsonb_build_object('environment_id', v_env.id, 'snapshots', jsonb_array_length(p_snapshots));
end;
$$;

-- Resident daemons poll this (D1); the phone's refresh lands here within seconds.
create or replace function public.burn_poll_sync_requests(p_ingest_token text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_env     burn.environments;
  v_pending jsonb;
begin
  select * into v_env from burn_api._env_for_ingest_token(p_ingest_token);
  if v_env.id is null then
    raise exception 'invalid ingest token' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_pending
  from (
    select r.generation, r.requested_at, r.target_environment
    from burn.sync_requests r
    where r.status = 'pending'
      and (r.target_environment is null or r.target_environment = v_env.id)
    order by r.generation
    limit 50
  ) r;

  update burn.sync_requests
     set status = 'acknowledged', acknowledged_at = now()
   where status = 'pending'
     and (target_environment is null or target_environment = v_env.id)
     and generation in (select (x->>'generation')::bigint from jsonb_array_elements(v_pending) x);

  return jsonb_build_object('requests', v_pending, 'latest_revision', v_env.latest_revision);
end;
$$;

-- ── phone API ────────────────────────────────────────────────────────────────

-- Delta pull keyed on revision (NOT event time): corrected old events propagate.
create or replace function public.burn_fetch_delta(p_read_token text, p_since_revision bigint default 0, p_limit integer default 5000)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_events  jsonb;
  v_envs    jsonb;
  v_max_rev bigint;
begin
  perform burn_api._assert_read_token(p_read_token);
  p_limit := least(greatest(coalesce(p_limit, 5000), 1), 20000);

  select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) into v_events
  from (
    select e.* from burn.usage_events e
    where e.revision > coalesce(p_since_revision, 0)
    order by e.revision, e.event_id
    limit p_limit
  ) e;

  select coalesce(jsonb_agg(to_jsonb(n)), '[]'::jsonb) into v_envs
  from (
    select n.id, n.slug, n.display_name, n.host_group, n.os_kind,
           n.reporter_version, n.tokscale_version, n.export_schema,
           n.reporting_timezone, n.last_heartbeat_at, n.last_success_at,
           n.last_error, n.latest_revision
    from burn.environments n
  ) n;

  select coalesce(max((x->>'revision')::bigint), 0) into v_max_rev
  from jsonb_array_elements(v_events) x;

  return jsonb_build_object(
    'environments', v_envs,
    'events',       v_events,
    'max_revision', v_max_rev,
    'has_more',     (select count(*) from burn.usage_events where revision > v_max_rev) > 0
  );
end;
$$;

create or replace function public.burn_fetch_quota_latest(p_read_token text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
  from (
    select distinct on (provider, account_key, metric)
           q.provider, q.account_key, q.account_label, q.plan, q.metric,
           q.used_percent, q.remaining_percent, q.remaining_label, q.resets_at,
           q.credit_status, q.spend_control, q.status, q.error,
           q.fetched_at, q.source_offset_minutes, q.environment_id
    from burn.quota_snapshots q
    order by provider, account_key, metric, fetched_at desc
  ) q;
$$;

create or replace function public.burn_request_sync(p_read_token text, p_environment uuid default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_generation bigint;
begin
  perform burn_api._assert_read_token(p_read_token);
  insert into burn.sync_requests (target_environment)
  values (p_environment)
  returning generation into v_generation;
  return jsonb_build_object('generation', v_generation);
end;
$$;

-- ── access grants (tokens are checked inside the functions) ─────────────────
grant execute on function public.burn_heartbeat(text, jsonb)              to anon, authenticated;
grant execute on function public.burn_report_error(text, text)            to anon, authenticated;
grant execute on function public.burn_ingest_events(text, jsonb)          to anon, authenticated;
grant execute on function public.burn_push_quota_snapshot(text, jsonb)    to anon, authenticated;
grant execute on function public.burn_poll_sync_requests(text)            to anon, authenticated;
grant execute on function public.burn_fetch_delta(text, bigint, integer)  to anon, authenticated;
grant execute on function public.burn_fetch_quota_latest(text)            to anon, authenticated;
grant execute on function public.burn_request_sync(text, uuid)            to anon, authenticated;
