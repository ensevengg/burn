import type { MobileSyncApi } from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";
import { withWriteLock } from "./writelock";

export type MirrorChange = "events" | "machines" | "quotas";
export interface SyncResult {
  pulledEvents: number;
  pages: number;
  watermark: number;
  hasMore: boolean;
}
const WATERMARK_KEY = "watermark_revision";
const MAX_PAGES = 8;
async function kvGet(db: SQLiteDatabase, key: string): Promise<string | null> {
  return (
    (await db.getFirstAsync<{ value: string }>("select value from kv where key = ?", [key]))?.value ?? null
  );
}
async function kvSet(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync("insert or replace into kv (key, value) values (?, ?)", [key, value]);
}

/** Independent network channels; only local commits share the SQLite write lock. */
export async function pullCloud(
  db: SQLiteDatabase,
  phone: MobileSyncApi,
  assertActive: () => void = () => {},
  onChange: (kind: MirrorChange) => void = () => {},
): Promise<SyncResult> {
  const pullEvents = async (): Promise<SyncResult> => {
    const sinceRevision = Number((await kvGet(db, WATERMARK_KEY)) ?? 0);
    let watermark = sinceRevision;
    let pulledEvents = 0;
    let pages = 0;
    let hasMore = false;

    // Loop until the backend reports everything below the watermark shipped.
    // Each page commits atomically before the watermark advances.
    for (let page = 0; page < MAX_PAGES; page++) {
      assertActive();
      const delta = await phone.fetchDelta(watermark);
      hasMore = delta.hasMore;
      await withWriteLock(async () => {
        assertActive();
        await db.withTransactionAsync(async () => {
          for (const env of delta.environments) {
            await db.runAsync(
              `insert into environments
             (id, slug, display_name, host_group, os_kind, reporter_version, tokscale_version,
              export_schema, reporting_timezone, last_heartbeat_at, last_success_at, last_error, latest_revision)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (id) do update set
             slug = excluded.slug, display_name = excluded.display_name,
             host_group = excluded.host_group, os_kind = excluded.os_kind,
             reporter_version = excluded.reporter_version, tokscale_version = excluded.tokscale_version,
             export_schema = excluded.export_schema,
             reporting_timezone = excluded.reporting_timezone,
             last_heartbeat_at = excluded.last_heartbeat_at, last_success_at = excluded.last_success_at,
             last_error = excluded.last_error, latest_revision = excluded.latest_revision`,
              [
                env.id,
                env.slug,
                env.displayName,
                env.hostGroup,
                env.osKind,
                env.reporterVersion,
                env.tokscaleVersion,
                env.exportSchema,
                env.reportingTimezone,
                env.lastHeartbeatAt,
                env.lastSuccessAt,
                env.lastError,
                env.latestRevision,
              ],
            );
          }
          // 32 rows × 28 bindings = 896 parameters, deliberately under the
          // classic 999 SQLITE_MAX_VARIABLE_NUMBER cap of older system SQLite
          // builds (expo-sqlite's bundled build allows far more). If a column
          // is added, recheck the product or shrink the chunk.
          for (let i = 0; i < delta.events.length; i += 32) {
            const chunk = delta.events.slice(i, i + 32);
            await db.runAsync(
              `insert or replace into usage_events
             (event_id, environment_id, client, provider_id, model_id, session_id, session_title,
              workspace_key, workspace_label, agent, occurred_at_ms, source_offset_minutes, source_timezone,
              source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source,
              cost_is_complete, model_attribution_conflicted, parser_version, revision)
           values ${chunk.map(() => "(" + Array(28).fill("?").join(",") + ")").join(",")}`,
              chunk.flatMap((e) => [
                e.eventId,
                e.environmentId,
                e.client,
                e.providerId,
                e.modelId,
                e.sessionId,
                e.sessionTitle,
                e.workspaceKey,
                e.workspaceLabel,
                e.agent,
                e.occurredAtMs,
                e.sourceOffsetMinutes,
                e.sourceTimezone,
                e.sourceLocalDate,
                e.inputTokens,
                e.outputTokens,
                e.cacheReadTokens,
                e.cacheWriteTokens,
                e.reasoningTokens,
                e.messageCount,
                e.isTurnStart ? 1 : 0,
                e.durationMs,
                e.cost,
                e.costSource,
                e.costIsComplete ? 1 : 0,
                e.modelAttributionConflicted ? 1 : 0,
                e.parserVersion,
                e.revision,
              ]),
            );
          }
          await kvSet(db, WATERMARK_KEY, String(delta.maxRevision));
        });
        if (delta.events.length > 0) onChange("events");
        onChange("machines");
      });
      watermark = Math.max(watermark, delta.maxRevision);
      pulledEvents += delta.events.length;
      pages++;
      if (!delta.hasMore || delta.events.length === 0) break;
    }

    return { pulledEvents, pages, watermark, hasMore };
  };
  const pullQuotas = async (): Promise<void> => {
    // Env-scoped row keys (C2): same scheme as the demo mirror, so a future
    // per-environment quota stream can't silently collide.
    const quotas = await phone.fetchQuotaLatest();
    await withWriteLock(async () => {
      assertActive();
      await db.withTransactionAsync(async () => {
        await db.runAsync("delete from quota_snapshots");
        for (const q of quotas) {
          await db.runAsync(
            `insert into quota_snapshots
             (row_key, environment_id, provider, account_key, account_label, plan, metric,
              used_percent, remaining_percent, remaining_label, resets_at, status, error, fetched_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              `${q.environmentId ?? "no-env"}|${q.provider}|${q.accountKey}|${q.metric}`,
              q.environmentId,
              q.provider,
              q.accountKey,
              q.accountLabel,
              q.plan,
              q.metric,
              q.usedPercent,
              q.remainingPercent,
              q.remainingLabel,
              q.resetsAt,
              q.status,
              q.error,
              q.fetchedAt,
            ],
          );
        }
      });

      onChange("quotas");
    });
  };
  const results = await Promise.allSettled([pullEvents(), pullQuotas()]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  const events = results[0];
  if (events.status !== "fulfilled") throw new Error("Event sync failed");
  return events.value;
}
