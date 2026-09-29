-- Connection health is separate from successful data collection. Independent
-- event/quota completions must not erase another channel's failure.
alter table burn.environments
  add column last_event_success_at timestamptz,
  add column last_event_error text,
  add column last_quota_success_at timestamptz,
  add column last_quota_error text,
  add column last_heartbeat_error text;

alter function public.burn_ingest_events(text,jsonb) set schema burn_api;
alter function burn_api.burn_ingest_events(text,jsonb) rename to _ingest_events;
revoke all on function burn_api._ingest_events(text,jsonb) from public,anon,authenticated;

create function public.burn_ingest_events(p_ingest_token text,p_events jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb; v_error text;
begin
  -- Save diagnostics before the old implementation clears last_error.
  select concat_ws('; ',last_quota_error,last_heartbeat_error) into v_error
    from burn.environments where id=(burn_api._env_for_ingest_token(p_ingest_token)).id for update;
  if jsonb_typeof(p_events) is distinct from 'array' then raise exception 'p_events must be a JSON array'; end if;
  if p_events='[]'::jsonb then
    if (burn_api._env_for_ingest_token(p_ingest_token)).id is null then raise exception 'invalid ingest token'; end if;
    update burn.environments set last_success_at=now(),last_heartbeat_at=now()
      where id=(burn_api._env_for_ingest_token(p_ingest_token)).id
      returning jsonb_build_object('environment_id',id,'revision',latest_revision,'changed',0) into v_result;
  else
    v_result:=burn_api._ingest_events(p_ingest_token,p_events);
  end if;
  update burn.environments set last_event_success_at=now(),last_event_error=null,
    last_error=nullif(v_error,'') where id=(v_result->>'environment_id')::uuid;
  return v_result;
end $$;

alter function public.burn_push_quota_snapshot(text,jsonb) set schema burn_api;
alter function burn_api.burn_push_quota_snapshot(text,jsonb) rename to _push_quota_snapshot;
revoke all on function burn_api._push_quota_snapshot(text,jsonb) from public,anon,authenticated;

create function public.burn_push_quota_snapshot(p_ingest_token text,p_snapshots jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb; v_error text; v_quota_error text; v_event_success timestamptz;
begin
  select concat_ws('; ',last_event_error,last_heartbeat_error),last_success_at into v_error,v_event_success
    from burn.environments where id=(burn_api._env_for_ingest_token(p_ingest_token)).id for update;
  v_result:=burn_api._push_quota_snapshot(p_ingest_token,p_snapshots);
  select string_agg(left(coalesce(s->>'error','quota check failed'),200),'; ') into v_quota_error
    from jsonb_array_elements(p_snapshots) s where s->>'status'='error';
  update burn.environments set last_quota_success_at=case when v_quota_error is null then now() else last_quota_success_at end,
    last_quota_error=v_quota_error,last_success_at=v_event_success,
    last_error=nullif(concat_ws('; ',nullif(v_error,''),v_quota_error),'')
    where id=(v_result->>'environment_id')::uuid;
  return v_result;
end $$;

create or replace function public.burn_heartbeat(p_ingest_token text,p_meta jsonb default '{}') returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_env burn.environments;
begin
  select * into v_env from burn_api._env_for_ingest_token(p_ingest_token);
  if v_env.id is null then raise exception 'invalid ingest token'; end if;
  update burn.environments set
    reporter_version=coalesce(p_meta->>'reporter_version',reporter_version),
    tokscale_version=coalesce(p_meta->>'tokscale_version',tokscale_version),
    export_schema=coalesce((p_meta->>'export_schema')::integer,export_schema),
    reporting_timezone=coalesce(p_meta->>'reporting_timezone',reporting_timezone),
    live_endpoint=case when p_meta ? 'live_endpoint' then nullif(p_meta->>'live_endpoint','') else live_endpoint end,
    last_heartbeat_at=now(),last_heartbeat_error=null,
    last_error=nullif(concat_ws('; ',last_event_error,last_quota_error),'')
    where id=v_env.id;
  return jsonb_build_object('environment_id',v_env.id,'slug',v_env.slug,'server_time',now());
end $$;

create function public.burn_report_channel_error(p_ingest_token text,p_error text,p_channel text) returns void
language plpgsql volatile security definer set search_path='' as $$
declare v_id uuid;
begin
  v_id:=(burn_api._env_for_ingest_token(p_ingest_token)).id;
  if v_id is null then raise exception 'invalid ingest token'; end if;
  if p_channel not in ('events','quotas','heartbeat') or p_channel is null then raise exception 'invalid channel'; end if;
  update burn.environments set
    last_event_error=case when p_channel='events' then left(p_error,500) else last_event_error end,
    last_quota_error=case when p_channel='quotas' then left(p_error,500) else last_quota_error end,
    last_heartbeat_error=case when p_channel='heartbeat' then left(p_error,500) else last_heartbeat_error end
    where id=v_id;
  update burn.environments set last_error=nullif(concat_ws('; ',last_event_error,last_quota_error,last_heartbeat_error),'') where id=v_id;
end $$;

-- Legacy reporters still report errors, with explicit authentication.
create or replace function public.burn_report_error(p_ingest_token text,p_error text) returns void
language sql volatile security definer set search_path='' as $$
  select public.burn_report_channel_error(p_ingest_token,p_error,'events');
$$;

grant execute on function public.burn_ingest_events(text,jsonb),public.burn_push_quota_snapshot(text,jsonb),
  public.burn_report_channel_error(text,text,text) to anon,authenticated;

revoke all on function public.burn_report_channel_error(text,text,text) from public;
