-- Bound each machine's read by its own constant cursor before merging pages.
-- The private SQL helper is invoker-only; public callers must pass the token gate.
create or replace function burn_api._delta_candidates(p_cursors jsonb, p_limit integer)
returns setof burn.usage_events language sql stable as $$
  select candidate.*
  from burn.environments env
  cross join lateral (
    select e.* from burn.usage_events e
    where e.environment_id = env.id
      and (e.environment_id,e.revision,e.event_id) > (
        env.id,
        coalesce((p_cursors->env.id::text->>'revision')::bigint,0),
        coalesce(p_cursors->env.id::text->>'eventId',''))
    order by e.revision,e.event_id limit p_limit
  ) candidate
  order by candidate.revision,candidate.event_id limit p_limit;
$$;
revoke all on function burn_api._delta_candidates(jsonb,integer) from public,anon,authenticated;

create or replace function public.burn_fetch_delta_v2(
  p_read_token text, p_cursors jsonb default '{}', p_limit integer default 1000
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_events jsonb;
  v_cursors jsonb := coalesce(p_cursors, '{}');
  v_row record;
  v_has_more boolean;
begin
  perform burn_api._assert_read_token(p_read_token);
  if jsonb_typeof(v_cursors) <> 'object' then raise exception 'invalid cursors'; end if;
  if exists (select 1 from jsonb_each(v_cursors) c
    where jsonb_typeof(c.value) <> 'object'
       or coalesce(c.value->>'revision','') !~ '^[0-9]+$'
       or jsonb_typeof(c.value->'eventId') is distinct from 'string') then
    raise exception 'invalid cursor';
  end if;
  p_limit := least(greatest(coalesce(p_limit,1000),1),5000);
  select coalesce(jsonb_agg(to_jsonb(e) || jsonb_build_object('cost',e.cost::text)
    order by e.revision,e.event_id),'[]') into v_events
  from burn_api._delta_candidates(v_cursors, p_limit) e;
  for v_row in
    select distinct on (x->>'environment_id') x->>'environment_id' as env,
      (x->>'revision')::bigint as revision,x->>'event_id' as event_id
    from jsonb_array_elements(v_events) x
    order by x->>'environment_id',(x->>'revision')::bigint desc,x->>'event_id' desc
  loop
    v_cursors := jsonb_set(v_cursors,array[v_row.env],
      jsonb_build_object('revision',v_row.revision,'eventId',v_row.event_id));
  end loop;
  select exists(select 1 from burn_api._delta_candidates(v_cursors, 1)) into v_has_more;
  return jsonb_build_object('protocol',2,'events',v_events,'cursors',v_cursors,
    'has_more',v_has_more,'environments',(
      select coalesce(jsonb_agg(to_jsonb(e) - 'ingest_token_hash'),'[]') from burn.environments e));
end;
$$;
grant execute on function public.burn_fetch_delta_v2(text,jsonb,integer) to anon,authenticated;
