-- burn · 0009_machine_metrics.sql
-- Physical-machine health samples. WSL reporters deliberately do not write:
-- their Windows host owns the hardware sensors and represents that machine.

create sequence if not exists burn.machine_metric_revision_seq;

create table if not exists burn.machine_metrics (
  id                text primary key,
  environment_id    uuid not null references burn.environments(id) on delete cascade,
  captured_at       timestamptz not null,
  cpu_load_pct      numeric(5, 1) not null check (cpu_load_pct between 0 and 100),
  cpu_temp_c        numeric(5, 1) check (cpu_temp_c between -50 and 200),
  ram_used_pct      numeric(5, 1) not null check (ram_used_pct between 0 and 100),
  ram_temp_c        numeric(5, 1) check (ram_temp_c between -50 and 200),
  gpu_util_pct      numeric(5, 1) check (gpu_util_pct between 0 and 100),
  gpu_temp_c        numeric(5, 1) check (gpu_temp_c between -50 and 200),
  revision          bigint not null default nextval('burn.machine_metric_revision_seq'),
  unique (environment_id, captured_at)
);

alter sequence burn.machine_metric_revision_seq owned by burn.machine_metrics.revision;
create index if not exists machine_metrics_env_time_idx
  on burn.machine_metrics (environment_id, captured_at desc);
alter table burn.machine_metrics enable row level security;
revoke all on burn.machine_metrics from anon, authenticated;

create or replace function public.burn_push_machine_metrics(p_ingest_token text, p_metrics jsonb)
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
  if jsonb_typeof(p_metrics) <> 'array' then
    raise exception 'p_metrics must be a JSON array' using errcode = 'P0001';
  end if;

  with incoming as (
    select
      to_timestamp((m->>'captured_at_ms')::double precision / 1000) as captured_at,
      (m->>'cpu_load_pct')::numeric(5, 1) as cpu_load_pct,
      (m->>'cpu_temp_c')::numeric(5, 1) as cpu_temp_c,
      (m->>'ram_used_pct')::numeric(5, 1) as ram_used_pct,
      (m->>'ram_temp_c')::numeric(5, 1) as ram_temp_c,
      (m->>'gpu_util_pct')::numeric(5, 1) as gpu_util_pct,
      (m->>'gpu_temp_c')::numeric(5, 1) as gpu_temp_c
    from jsonb_array_elements(p_metrics) m
  )
  insert into burn.machine_metrics
    (id, environment_id, captured_at, cpu_load_pct, cpu_temp_c, ram_used_pct, ram_temp_c, gpu_util_pct, gpu_temp_c)
  select encode(sha256(convert_to(v_env.id::text || '|' || ((extract(epoch from captured_at) * 1000)::bigint)::text, 'utf8')), 'hex'),
         v_env.id, captured_at, cpu_load_pct, cpu_temp_c, ram_used_pct, ram_temp_c, gpu_util_pct, gpu_temp_c
  from incoming
  on conflict (environment_id, captured_at) do update set
    cpu_load_pct = excluded.cpu_load_pct, cpu_temp_c = excluded.cpu_temp_c,
    ram_used_pct = excluded.ram_used_pct, ram_temp_c = excluded.ram_temp_c,
    gpu_util_pct = excluded.gpu_util_pct, gpu_temp_c = excluded.gpu_temp_c,
    revision = nextval('burn.machine_metric_revision_seq');

  delete from burn.machine_metrics where captured_at < now() - interval '7 days';
  update burn.environments set last_heartbeat_at = now(), last_success_at = now(), last_error = null
   where id = v_env.id;
  return jsonb_build_object('environment_id', v_env.id, 'samples', jsonb_array_length(p_metrics));
end;
$$;

create or replace function public.burn_fetch_machine_metrics(
  p_read_token text,
  p_since timestamptz default now() - interval '24 hours'
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform burn_api._assert_read_token(p_read_token);
  return (
    select coalesce(jsonb_agg(to_jsonb(m) order by m.captured_at), '[]'::jsonb)
    from (
      select id, environment_id, captured_at, cpu_load_pct, cpu_temp_c,
             ram_used_pct, ram_temp_c, gpu_util_pct, gpu_temp_c, revision
      from burn.machine_metrics
      where captured_at >= p_since
      order by captured_at
    ) m
  );
end;
$$;

grant execute on function public.burn_push_machine_metrics(text, jsonb) to anon, authenticated;
grant execute on function public.burn_fetch_machine_metrics(text, timestamptz) to anon, authenticated;
