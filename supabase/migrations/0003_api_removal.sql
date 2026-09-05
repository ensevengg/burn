-- burn · 0003_api_removal.sql
-- Machine removal from the phone (app-side "−" button, confirmation required
-- in the UI). Gated by the read token — same trust level as burn_request_sync.
-- Deleting the environment row cascades its usage_events and quota_snapshots.
-- If the machine still exists it will fail its next push (its ingest token row
-- is gone) and must re-run `npx burn-report init` to re-pair.
-- Run after 0002_api.sql.

create or replace function public.burn_remove_environment(p_read_token text, p_environment uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_slug text;
begin
  perform burn_api._assert_read_token(p_read_token);
  if p_environment is null then
    raise exception 'p_environment is required' using errcode = 'P0001';
  end if;

  delete from burn.environments
  where id = p_environment
  returning slug into v_slug;

  if v_slug is null then
    raise exception 'environment not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object('removed', v_slug);
end;
$$;

grant execute on function public.burn_remove_environment(text, uuid) to anon, authenticated;
