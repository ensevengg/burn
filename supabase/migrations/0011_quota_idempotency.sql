-- Retrying an acknowledged quota snapshot must not create a second row or
-- relabel a cached sample as fresh. Reporter collection time is part of its key.
delete from burn.quota_snapshots a using burn.quota_snapshots b
 where a.environment_id=b.environment_id and a.provider=b.provider
 and a.account_key=b.account_key and a.metric=b.metric and a.status=b.status
 and a.fetched_at=b.fetched_at and a.id>b.id;
create unique index quota_snapshot_identity on burn.quota_snapshots
 (environment_id,provider,account_key,metric,status,fetched_at);

create or replace function burn_api._push_quota_snapshot(p_ingest_token text, p_snapshots jsonb)
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
  if jsonb_typeof(p_snapshots) is distinct from 'array' then
    raise exception 'p_snapshots must be a JSON array' using errcode = 'P0001';
  end if;

  insert into burn.quota_snapshots (
    environment_id, provider, account_key, account_label, plan,
    metric, used_percent, remaining_percent, remaining_label, resets_at,
    credit_status, spend_control, status, error, source_offset_minutes, export_schema, fetched_at
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
    coalesce((s->>'export_schema')::integer, 1),
    coalesce((s->>'fetched_at')::timestamptz,now())
  from jsonb_array_elements(p_snapshots) as s
  on conflict (environment_id,provider,account_key,metric,status,fetched_at) do nothing;

  update burn.environments
     set last_heartbeat_at = now(), last_success_at = now(), last_error = null
   where id = v_env.id;

  return jsonb_build_object('environment_id', v_env.id, 'snapshots', jsonb_array_length(p_snapshots));
end;
$$;


revoke all on function burn_api._push_quota_snapshot(text,jsonb) from public,anon,authenticated;
