-- burn · 0006_live_endpoint.sql
-- Tailscale live-pull advertisement (D1 v2, docs/adr/0001-tailscale-direct-pull).
-- A machine running the live server publishes its tailnet-reachable base URL
-- via burn_heartbeat's `live_endpoint` meta key. Semantics:
--   absent / undefined  → preserve (a plain `push` from a sibling process
--                         must not wipe the daemon's URL)
--   empty string / null → clear  (the machine stopped serving live; a stale
--                         URL must not linger)
--   non-empty string    → set
-- The phone probes this URL only on foreground/manual refresh, and treats an
-- unreachable endpoint as "mirror only" — stale entries are benign, but they
-- are cleared properly anyway.
-- Run after 0005_delta_revision_index.sql.

alter table burn.environments add column if not exists live_endpoint text;

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
    live_endpoint = case
      when jsonb_typeof(p_meta -> 'live_endpoint') = 'null' then null
      else coalesce(nullif(p_meta ->> 'live_endpoint', ''), live_endpoint)
    end,
    last_heartbeat_at  = now(),
    last_success_at    = now()
  where id = v_env.id;

  return jsonb_build_object('environment_id', v_env.id, 'slug', v_env.slug, 'server_time', now());
end;
$$;

-- Delta now carries the advertisement so the phone knows where to probe.
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
           n.last_error, n.latest_revision, n.live_endpoint
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

-- Signatures are unchanged by this migration, so 0002's execute grants hold.
