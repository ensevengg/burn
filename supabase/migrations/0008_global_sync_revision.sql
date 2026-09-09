-- burn · 0008_global_sync_revision.sql
-- Environment-local revisions overlap (every machine starts at 1), so they
-- cannot be used as one phone-wide watermark. Stamp each inserted/corrected
-- row with a database-global sequence and page on that instead.

create sequence if not exists burn.usage_event_sync_revision_seq;

alter table burn.usage_events add column if not exists sync_revision bigint;
update burn.usage_events
set sync_revision = nextval('burn.usage_event_sync_revision_seq')
where sync_revision is null;
alter table burn.usage_events alter column sync_revision set default nextval('burn.usage_event_sync_revision_seq');
alter table burn.usage_events alter column sync_revision set not null;
alter sequence burn.usage_event_sync_revision_seq owned by burn.usage_events.sync_revision;
create unique index if not exists usage_events_sync_rev_idx on burn.usage_events (sync_revision);

create or replace function burn_api._stamp_usage_event_sync_revision()
returns trigger language plpgsql volatile set search_path = '' as $$
begin
  new.sync_revision := nextval('burn.usage_event_sync_revision_seq');
  return new;
end;
$$;

drop trigger if exists usage_events_sync_revision_update on burn.usage_events;
create trigger usage_events_sync_revision_update
before update on burn.usage_events
for each row execute function burn_api._stamp_usage_event_sync_revision();

create or replace function public.burn_fetch_delta(p_read_token text, p_since_revision bigint default 0, p_limit integer default 5000)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_events jsonb;
  v_envs jsonb;
  v_max_rev bigint;
begin
  perform burn_api._assert_read_token(p_read_token);
  p_limit := least(greatest(coalesce(p_limit, 5000), 1), 20000);

  select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) into v_events
  from (
    select e.* from burn.usage_events e
    where e.sync_revision > coalesce(p_since_revision, 0)
    order by e.sync_revision
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

  select coalesce(max((x->>'sync_revision')::bigint), coalesce(p_since_revision, 0)) into v_max_rev
  from jsonb_array_elements(v_events) x;

  return jsonb_build_object(
    'cursor_version', 2,
    'environments', v_envs,
    'events', v_events,
    'max_revision', v_max_rev,
    'has_more', exists(select 1 from burn.usage_events where sync_revision > v_max_rev)
  );
end;
$$;
