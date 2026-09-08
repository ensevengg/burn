-- burn · 0007_delta_has_more_exists.sql
-- Idle phone pulls must not count the entire revision tail. Preserve the
-- caller's watermark for empty pages and stop after the first later row.

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

  select coalesce(max((x->>'revision')::bigint), coalesce(p_since_revision, 0)) into v_max_rev
  from jsonb_array_elements(v_events) x;

  return jsonb_build_object(
    'environments', v_envs,
    'events',       v_events,
    'max_revision', v_max_rev,
    'has_more',     exists(select 1 from burn.usage_events where revision > v_max_rev)
  );
end;
$$;

-- Signature is unchanged, so 0002's execute grant remains in effect.
