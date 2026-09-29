-- D5: revisions are scoped to an environment. The continuation also includes
-- event_id, so a page can end inside a batch without losing its remaining rows.
create index if not exists usage_events_environment_revision_idx
  on burn.usage_events(environment_id, revision, event_id);

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
  from (
    select e.* from burn.usage_events e
    where (e.revision,e.event_id) > (
      coalesce((v_cursors->e.environment_id::text->>'revision')::bigint,0),
      coalesce(v_cursors->e.environment_id::text->>'eventId',''))
    order by e.revision,e.event_id limit p_limit
  ) e;
  for v_row in
    select distinct on (x->>'environment_id') x->>'environment_id' as env,
      (x->>'revision')::bigint as revision,x->>'event_id' as event_id
    from jsonb_array_elements(v_events) x
    order by x->>'environment_id',(x->>'revision')::bigint desc,x->>'event_id' desc
  loop
    v_cursors := jsonb_set(v_cursors,array[v_row.env],
      jsonb_build_object('revision',v_row.revision,'eventId',v_row.event_id));
  end loop;
  select exists(select 1 from burn.usage_events e
    where (e.revision,e.event_id) > (
      coalesce((v_cursors->e.environment_id::text->>'revision')::bigint,0),
      coalesce(v_cursors->e.environment_id::text->>'eventId',''))) into v_has_more;
  return jsonb_build_object('protocol',2,'events',v_events,'cursors',v_cursors,
    'has_more',v_has_more,'environments',(
      select coalesce(jsonb_agg(to_jsonb(e) - 'ingest_token_hash'),'[]') from burn.environments e));
end;
$$;
grant execute on function public.burn_fetch_delta_v2(text,jsonb,integer) to anon,authenticated;
