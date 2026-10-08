import {
  liveEventId,
  machineMetricId,
  quotaMirrorKey,
  type MachineEventInput,
  type MachineQuotaInput,
  type UsageEvent,
} from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";

const columns = [
  "event_id",
  "environment_id",
  "client",
  "provider_id",
  "model_id",
  "session_id",
  "session_title",
  "workspace_key",
  "workspace_label",
  "agent",
  "occurred_at_ms",
  "source_offset_minutes",
  "source_timezone",
  "source_local_date",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "message_count",
  "is_turn_start",
  "duration_ms",
  "cost",
  "cost_source",
  "cost_is_complete",
  "model_attribution_conflicted",
  "parser_version",
];
const contentColumns = columns.slice(1);
/** Caller owns transaction and write lock. Changed count excludes overlap
 * duplicates. Machine corrections replace existing content in place. */
export async function mergePeerEvents(
  db: SQLiteDatabase,
  environmentId: string,
  slug: string,
  events: MachineEventInput[],
  assertActive: () => void,
): Promise<number> {
  return writeEvents(
    db,
    events.map((event) => ({
      ...event,
      eventId: liveEventId(slug, event.client, event.dedupKey),
      environmentId,
    })),
    assertActive,
  );
}

function eventBindings(e: UsageEvent) {
  return [
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
  ];
}

async function writeEvents(
  db: SQLiteDatabase,
  events: UsageEvent[],
  assertActive: () => void,
): Promise<number> {
  let changed = 0;
  // 32 × 27 bindings stays below the classic 999-parameter SQLite limit.
  for (let i = 0; i < events.length; i += 32) {
    assertActive();
    const chunk = events.slice(i, i + 32);
    const conflict = `
      on conflict(event_id) do update set ${contentColumns
        .map((c) => `${c}=excluded.${c}`)
        .join(",")}
      where (${contentColumns.join(",")}) is not (${contentColumns.map((c) => `excluded.${c}`).join(",")})`;
    const result = await db.runAsync(
      `insert into usage_events (${columns.join(",")})
      values ${chunk.map(() => `(${Array(columns.length).fill("?").join(",")})`).join(",")}${conflict}`,
      chunk.flatMap(eventBindings),
    );
    changed += result.changes;
  }
  assertActive();
  return changed;
}

/** Last success survives failed attempts; stale responses never replace newer
 * state. Collection time belongs to the source, never to the phone merge. */
export async function mergeQuota(
  db: SQLiteDatabase,
  environmentId: string | null,
  q: MachineQuotaInput,
  fetchedAt: string,
): Promise<void> {
  await db.runAsync(
    `insert into quota_snapshots
    (row_key,environment_id,provider,account_key,account_label,plan,metric,used_percent,remaining_percent,remaining_label,resets_at,credit_status,spend_control,status,error,fetched_at)
    values (${Array(16).fill("?").join(",")})
    on conflict(row_key) do update set account_label=excluded.account_label,plan=excluded.plan,
      used_percent=excluded.used_percent,remaining_percent=excluded.remaining_percent,
      remaining_label=excluded.remaining_label,resets_at=excluded.resets_at,
      credit_status=excluded.credit_status,spend_control=excluded.spend_control,
      error=excluded.error,fetched_at=excluded.fetched_at
    where julianday(excluded.fetched_at)>=julianday(quota_snapshots.fetched_at)`,
    [
      quotaMirrorKey(
        environmentId,
        q.provider,
        q.accountKey,
        q.metric,
        q.status,
      ),
      environmentId,
      q.provider,
      q.accountKey,
      q.accountLabel,
      q.plan,
      q.metric,
      q.usedPercent,
      q.remainingPercent,
      q.remainingLabel,
      q.resetsAt,
      q.creditStatus ? JSON.stringify(q.creditStatus) : null,
      q.spendControl ? JSON.stringify(q.spendControl) : null,
      q.status,
      q.error,
      fetchedAt,
    ],
  );
}

/** Caller holds the mirror write lock and transaction. Keep 24 hours locally;
 * overlapping peer histories do not create duplicate samples. */
export async function mergeMetrics(
  db: SQLiteDatabase,
  environmentId: string,
  metrics: import("@burn/sync-api").MachineMetricInput[],
  now: number,
  assertActive: () => void,
): Promise<number> {
  const columns = ["id", "environment_id", "captured_at_ms", "cpu_load_pct", "cpu_temp_c",
    "ram_used_pct", "ram_temp_c", "gpu_util_pct", "gpu_temp_c"];
  const content = columns.slice(3);
  let changed = 0;
  for (let start = 0; start < metrics.length; start += 32) {
    assertActive();
    const chunk = metrics.slice(start, start + 32);
    const result = await db.runAsync(
      `insert into machine_metrics (${columns.join(",")}) values
       ${chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}
       on conflict(id) do update set ${content.map((c) => `${c}=excluded.${c}`).join(",")}
       where (${content.join(",")}) is not (${content.map((c) => `excluded.${c}`).join(",")})`,
      chunk.flatMap((m) => [machineMetricId(environmentId, m.capturedAtMs), environmentId,
        m.capturedAtMs, m.cpuLoadPct, m.cpuTempC, m.ramUsedPct, m.ramTempC, m.gpuUtilPct, m.gpuTempC]),
    );
    changed += result.changes;
  }
  assertActive();
  const removed = await db.runAsync("delete from machine_metrics where environment_id=? and captured_at_ms<?",
    [environmentId, now - 86_400_000]);
  return changed + removed.changes;
}
