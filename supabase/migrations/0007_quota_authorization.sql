-- Restore D7 authorization without changing the public RPC signature.
create or replace function public.burn_fetch_quota_latest(p_read_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform burn_api._assert_read_token(p_read_token);
  return (
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    from (
      select distinct on (provider, account_key, metric)
        q.provider, q.account_key, q.account_label, q.plan, q.metric,
        q.used_percent, q.remaining_percent, q.remaining_label, q.resets_at,
        q.credit_status, q.spend_control, q.status, q.error,
        q.fetched_at, q.source_offset_minutes, q.environment_id
      from burn.quota_snapshots q
      where q.status = 'ok'
      order by provider, account_key, metric, fetched_at desc, id desc
    ) q
  );
end;
$$;

revoke all on all functions in schema burn_api from public, anon, authenticated;
grant execute on function public.burn_fetch_quota_latest(text) to anon, authenticated;
