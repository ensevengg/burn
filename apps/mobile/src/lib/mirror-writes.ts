import {
  liveEventId,
  quotaMirrorKey,
  type IngestEventInput,
  type IngestQuotaInput,
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
  "revision",
];
const contentColumns = columns.slice(1, -1);
/** Caller owns transaction and write lock. Changed count excludes overlap
 * duplicates and peer rows blocked by cloud authority. */
export async function mergePeerEvents(
  db: SQLiteDatabase,
  environmentId: string,
  slug: string,
  events: IngestEventInput[],
  assertActive: () => void,
  authoritative = false,
): Promise<number> {
  return writeEvents(
    db,
    events.map((event) => ({
      ...event,
      eventId: liveEventId(slug, event.client, event.dedupKey),
      environmentId,
      revision: 0,
    })),
    assertActive,
    authoritative ? "direct" : "live",
  );
}

/** Cloud and peer writers share the column/binding contract. Caller owns the
 * transaction and lock; cloud revisions remain authoritative in cloud mode. */
export async function mergeCloudEvents(
  db: SQLiteDatabase,
  events: UsageEvent[],
  assertActive: () => void,
): Promise<number> {
  return writeEvents(db, events, assertActive, "cloud");
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
    e.revision,
  ];
}

async function writeEvents(
  db: SQLiteDatabase,
  events: UsageEvent[],
  assertActive: () => void,
  mode: "cloud" | "direct" | "live",
): Promise<number> {
  let changed = 0;
  // 32 × 28 bindings stays below the classic 999-parameter SQLite limit.
  for (let i = 0; i < events.length; i += 32) {
    assertActive();
    const chunk = events.slice(i, i + 32);
    const conflict =
      mode === "cloud"
        ? ""
        : `
      on conflict(event_id) do update set ${columns
        .slice(1)
        .map((c) => `${c}=excluded.${c}`)
        .join(",")}
      where (${mode === "direct" ? "1" : "usage_events.revision=0"})
        and (${contentColumns.join(",")}) is not (${contentColumns.map((c) => `excluded.${c}`).join(",")})`;
    const result = await db.runAsync(
      `insert ${mode === "cloud" ? "or replace " : ""}into usage_events (${columns.join(",")})
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
  q: IngestQuotaInput,
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
