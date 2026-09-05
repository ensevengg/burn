/**
 * Sync engine. Cloud mode: revision-keyed delta pull (D5) applied in one
 * SQLite transaction per page, watermark advanced only after commit. Demo
 * mode: the bundled generator writes the same mirror schema locally.
 */
import { createBurnBackend } from "@burn/sync-api";
import { kvGet, kvSet, resetDb, type SQLiteDatabase } from "./db";
import { loadConnection } from "./settings";
import { generateDemoDataset } from "../data/demo-generator";

const WATERMARK_KEY = "watermark_revision";
const MAX_PAGES = 8;

/** Demo data is generator-controlled, so literal interpolation is safe here. */
function sqlStr(value: string | null): string {
  return value === null ? "null" : `'${value.replace(/'/g, "''")}'`;
}
function sqlNum(decimalString: string): string {
  return Number.isFinite(Number(decimalString)) ? decimalString : "0";
}

export interface SyncResult {
  pulledEvents: number;
  pages: number;
  watermark: number;
}

export async function seedDemoData(db: SQLiteDatabase): Promise<void> {
  const dataset = generateDemoDataset();
  await resetDb(db);
  const envId: Record<string, string> = {};
  await db.withTransactionAsync(async () => {
    for (const env of dataset.environments) {
      const id = `demo-${env.slug}`;
      envId[env.slug] = id;
      await db.runAsync(
        `insert or replace into environments
           (id, slug, display_name, host_group, os_kind, tokscale_version, reporting_timezone, last_heartbeat_at, last_success_at, latest_revision)
         values (?, ?, ?, ?, ?, '4.15.1', ?, ?, ?, 1)`,
        [
          id,
          env.slug,
          env.displayName,
          env.hostGroup,
          env.osKind,
          env.reportingTimezone,
          new Date(dataset.now - 5 * 60_000).toISOString(),
          new Date(dataset.now - 5 * 60_000).toISOString(),
        ],
      );
    }

    // One multi-row INSERT per chunk — per-row bridge calls made seeding take
    // ~20s on device; batched it is well under a second.
    const chunkSize = 400;
    for (let i = 0; i < dataset.events.length; i += chunkSize) {
      const chunk = dataset.events.slice(i, i + chunkSize);
      const rows = chunk.map((e) => {
        const env = envId[e.environmentSlug] ?? e.environmentSlug;
        return `(${sqlStr(e.eventId)}, ${sqlStr(env)}, ${sqlStr(e.client)}, ${sqlStr(e.providerId)}, ${sqlStr(e.modelId)}, ${sqlStr(e.sessionId)}, ${sqlStr(e.sessionTitle)}, ${sqlStr(e.workspaceKey)}, ${sqlStr(e.workspaceLabel)}, ${sqlStr(e.agent)}, ${e.occurredAtMs}, ${e.sourceOffsetMinutes}, ${sqlStr(e.sourceTimezone)}, ${sqlStr(e.sourceLocalDate)}, ${e.inputTokens}, ${e.outputTokens}, ${e.cacheReadTokens}, ${e.cacheWriteTokens}, ${e.reasoningTokens}, ${e.messageCount}, ${e.isTurnStart ? 1 : 0}, ${e.durationMs}, ${sqlNum(e.cost)}, ${sqlStr(e.costSource)}, ${e.costIsComplete ? 1 : 0}, ${e.modelAttributionConflicted ? 1 : 0}, ${sqlStr(e.parserVersion)}, ${e.revision})`;
      });
      await db.execAsync(
        `insert or replace into usage_events
           (event_id, environment_id, client, provider_id, model_id, session_id, session_title,
            workspace_key, workspace_label, agent, occurred_at_ms, source_offset_minutes, source_timezone,
            source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source,
            cost_is_complete, model_attribution_conflicted, parser_version, revision)
         values ${rows.join(",")};`,
      );
    }

    for (const quota of dataset.quotas) {
      const rowKey = `${quota.environmentSlug}|${quota.provider}|${quota.accountKey}|${quota.metric}`;
      await db.runAsync(
        `insert or replace into quota_snapshots
           (row_key, environment_id, provider, account_key, account_label, plan, metric,
            used_percent, remaining_percent, remaining_label, resets_at, status, error, fetched_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rowKey,
          envId[quota.environmentSlug] ?? quota.environmentSlug,
          quota.provider,
          quota.accountKey,
          quota.accountLabel,
          quota.plan,
          quota.metric,
          quota.usedPercent,
          quota.remainingPercent,
          quota.remainingLabel,
          quota.resetsAt,
          quota.status,
          quota.error,
          new Date(dataset.now - quota.ageMinutes * 60_000).toISOString(),
        ],
      );
    }

    await kvSet(db, "mode", "demo");
  });
}

export async function syncFromCloud(db: SQLiteDatabase): Promise<SyncResult> {
  const connection = await loadConnection();
  if (connection === null) throw new Error("Not connected to a backend");
  const phone = createBurnBackend(connection).phone(connection.readToken);

  const sinceRevision = Number((await kvGet(db, WATERMARK_KEY)) ?? 0);
  let watermark = sinceRevision;
  let pulledEvents = 0;
  let pages = 0;

  // Loop until the backend reports everything below the watermark shipped.
  // Each page commits atomically before the watermark advances.
  for (let page = 0; page < MAX_PAGES; page++) {
    const delta = await phone.fetchDelta(watermark);
    await db.withTransactionAsync(async () => {
      for (const env of delta.environments) {
        await db.runAsync(
          `insert into environments
             (id, slug, display_name, host_group, os_kind, reporter_version, tokscale_version,
              reporting_timezone, last_heartbeat_at, last_success_at, last_error, latest_revision)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (id) do update set
             slug = excluded.slug, display_name = excluded.display_name,
             host_group = excluded.host_group, os_kind = excluded.os_kind,
             reporter_version = excluded.reporter_version, tokscale_version = excluded.tokscale_version,
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
            env.reportingTimezone,
            env.lastHeartbeatAt,
            env.lastSuccessAt,
            env.lastError,
            env.latestRevision,
          ],
        );
      }
      for (const e of delta.events) {
        await db.runAsync(
          `insert or replace into usage_events
             (event_id, environment_id, client, provider_id, model_id, session_id, session_title,
              workspace_key, workspace_label, agent, occurred_at_ms, source_offset_minutes, source_timezone,
              source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source,
              cost_is_complete, model_attribution_conflicted, parser_version, revision)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
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
          ],
        );
      }
      await kvSet(db, WATERMARK_KEY, String(delta.maxRevision));
    });
    watermark = Math.max(watermark, delta.maxRevision);
    pulledEvents += delta.events.length;
    pages++;
    if (!delta.hasMore || delta.events.length === 0) break;
  }

  // Quotas are freshness-selected server-side; mirror replaces wholesale.
  const quotas = await phone.fetchQuotaLatest();
  await db.withTransactionAsync(async () => {
    await db.runAsync("delete from quota_snapshots");
    for (const q of quotas) {
      await db.runAsync(
        `insert into quota_snapshots
           (row_key, environment_id, provider, account_key, account_label, plan, metric,
            used_percent, remaining_percent, remaining_label, resets_at, status, error, fetched_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `${q.provider}|${q.accountKey}|${q.metric}`,
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

  return { pulledEvents, pages, watermark };
}

export async function requestMachineSync(db: SQLiteDatabase, environmentId: string | null): Promise<void> {
  const connection = await loadConnection();
  if (connection === null) throw new Error("Not connected to a backend");
  const phone = createBurnBackend(connection).phone(connection.readToken);
  await phone.requestSync(environmentId ?? undefined);
}
