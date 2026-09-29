-- A broadcast has one durable delivery per environment. Poll claims a lease;
-- successful upload completes it, and failed/crashed workers can retry.
create table burn.sync_deliveries (
  generation bigint not null references burn.sync_requests(generation) on delete cascade,
  environment_id uuid not null references burn.environments(id) on delete cascade,
  lease_until timestamptz,
  completed_at timestamptz,
  completed_revision bigint,
  primary key(generation,environment_id)
);
alter table burn.sync_deliveries enable row level security;
revoke all on burn.sync_deliveries from anon,authenticated;
insert into burn.sync_deliveries(generation,environment_id)
select r.generation,e.id from burn.sync_requests r join burn.environments e
 on (r.target_environment is null or r.target_environment=e.id)
where r.status in ('pending','acknowledged') and r.requested_at>now()-interval '1 day';

create or replace function public.burn_request_sync(p_read_token text,p_environment uuid default null)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare v_generation bigint;
begin
  perform burn_api._assert_read_token(p_read_token);
  insert into burn.sync_requests(target_environment) values(p_environment) returning generation into v_generation;
  insert into burn.sync_deliveries(generation,environment_id)
    select v_generation,id from burn.environments where p_environment is null or id=p_environment;
  return jsonb_build_object('generation',v_generation);
end;
$$;

create or replace function public.burn_poll_sync_requests(p_ingest_token text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare v_env burn.environments; v_pending jsonb;
begin
  select * into v_env from burn_api._env_for_ingest_token(p_ingest_token);
  if v_env.id is null then raise exception 'invalid ingest token'; end if;
  with candidates as (
    select generation from burn.sync_deliveries where environment_id=v_env.id
      and completed_at is null and (lease_until is null or lease_until<=now())
    order by generation limit 50 for update skip locked
  ), claimed as (
    update burn.sync_deliveries d set lease_until=now()+interval '5 minutes'
    from candidates c where d.generation=c.generation and d.environment_id=v_env.id
    returning d.generation
  ) select coalesce(jsonb_agg(jsonb_build_object('generation',r.generation,
    'requested_at',r.requested_at,'target_environment',r.target_environment)),'[]')
    into v_pending from burn.sync_requests r join claimed c using(generation);
  return jsonb_build_object('requests',v_pending,'latest_revision',v_env.latest_revision);
end;
$$;

create function public.burn_complete_sync_requests(p_ingest_token text,p_generations jsonb,p_success boolean)
returns void language plpgsql volatile security definer set search_path=''
as $$
declare v_env burn.environments;
begin
  select * into v_env from burn_api._env_for_ingest_token(p_ingest_token);
  if v_env.id is null then raise exception 'invalid ingest token'; end if;
  if jsonb_typeof(p_generations)<>'array' then raise exception 'invalid generations'; end if;
  update burn.sync_deliveries d set
    completed_at=case when p_success then now() end,
    completed_revision=case when p_success then v_env.latest_revision end,
    lease_until=case when p_success then null else now()+interval '30 seconds' end
  where d.environment_id=v_env.id and d.completed_at is null
    and d.generation in (select value::bigint from jsonb_array_elements_text(p_generations));
  update burn.sync_requests r set status='completed',acknowledged_at=now()
  where r.generation in (select value::bigint from jsonb_array_elements_text(p_generations))
    and not exists(select 1 from burn.sync_deliveries d where d.generation=r.generation and d.completed_at is null);
end;
$$;
grant execute on function public.burn_complete_sync_requests(text,jsonb,boolean) to anon,authenticated;
