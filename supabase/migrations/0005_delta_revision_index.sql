-- burn · 0005_delta_revision_index.sql
-- Phone delta pulls (burn_fetch_delta) filter revision > watermark and order
-- by (revision, event_id) globally. The only existing index on revision
-- (usage_events_env_rev_idx) leads with environment_id, so the global scan
-- degraded toward a full sort as usage_events grew, and phone pulls slowed
-- with history. This index serves the delta's filter + order directly.
-- Run after 0004_quota_freshness.sql.

create index if not exists usage_events_rev_idx on burn.usage_events (revision, event_id);
