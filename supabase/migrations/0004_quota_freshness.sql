-- burn · 0004_quota_freshness.sql
-- B1 fix (first-check review): the display channel must never let a failed
-- vendor fetch evict the last good numbers. distinct-on is restricted to
-- status = 'ok'; error rows stay in burn.quota_snapshots as diagnostics
-- (queryable directly) instead of being surfaced as freshest state.
-- Run after 0003_api_removal.sql.

create or replace function public.burn_fetch_quota_latest(p_read_token text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
  from (
    select distinct on (provider, account_key, metric)
           q.provider, q.account_key, q.account_label, q.plan, q.metric,
           q.used_percent, q.remaining_percent, q.remaining_label, q.resets_at,
           q.credit_status, q.spend_control, q.status, q.error,
           q.fetched_at, q.source_offset_minutes, q.environment_id
    from burn.quota_snapshots q
    where q.status = 'ok'
    order by provider, account_key, metric, fetched_at desc
  ) q;
$$;

grant execute on function public.burn_fetch_quota_latest(text) to anon, authenticated;
