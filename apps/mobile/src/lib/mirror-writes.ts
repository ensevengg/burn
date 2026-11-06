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
 * duplicates. Machine corrections replace existing content in place. During a
 * full reconciliation, `trackInserted` records rows whose event id is new. */
export async function mergePeerEvents(
  db: SQLiteDatabase,
  environmentId: string,
  slug: string,
  events: MachineEventInput[],
  assertActive: () => void,
  trackInserted = false,
): Promise<number> {
  return writeEvents(
    db,
    events.map((event) => ({
      ...event,
      eventId: liveEventId(slug, event.client, event.dedupKey),
      environmentId,
    })),
    assertActive,
    trackInserted ? environmentId : null,
  );
}

/** Caller owns transaction and write lock. The first page of a full
 * reconciliation snapshot (including one restarted after an expired cursor)
 * forgets the sessions an earlier snapshot reported. */
export async function resetReconciledSessions(
  db: SQLiteDatabase,
  environmentId: string,
): Promise<void> {
  await db.runAsync("delete from reconcile_sessions where environment_id = ?", [environmentId]);
}

/** Caller owns transaction and write lock. Forgets all reconciliation
 * tracking for a machine: after a completed pass, on removal and on reset.
 * Inserted rows survive a cursor-expiry restart on purpose: the replacement
 * snapshot only updates them, and they remain valid one-to-one replacements. */
export async function forgetReconciliation(
  db: SQLiteDatabase,
  environmentId: string,
): Promise<void> {
  await resetReconciledSessions(db, environmentId);
  await db.runAsync("delete from reconcile_new_events where environment_id = ?", [environmentId]);
}

/** Caller owns transaction and write lock; runs with the page's row merge so
 * the tracked set always matches committed pages of the current snapshot. */
export async function trackReconciledSessions(
  db: SQLiteDatabase,
  environmentId: string,
  events: MachineEventInput[],
): Promise<void> {
  const sessions = [...new Map(events.map((e) => [`${e.client}\u0000${e.sessionId}`, e])).values()];
  for (let i = 0; i < sessions.length; i += 32) {
    const chunk = sessions.slice(i, i + 32);
    await db.runAsync(
      `insert or ignore into reconcile_sessions (environment_id, client, session_id)
       values ${chunk.map(() => "(?, ?, ?)").join(",")}`,
      chunk.flatMap((e) => [environmentId, e.client, e.sessionId]),
    );
  }
}

/** Caller owns transaction and write lock, and calls this only after a
 * completed full-history pass whose rows all carry `parserVersion`. A parser
 * pin bump can re-key the same usage (tokscale replacing a derived dedup key
 * with a provider id), leaving the old-key rows orphaned and double-counted.
 * Rows from another parser version are dropped only inside sessions the
 * completed snapshot itself reported (not ones an expired partial snapshot
 * committed), and only one-to-one against rows the reconciliation inserted
 * with the same model and token buckets: each deletion consumes a distinct
 * content-equal replacement, preferring an old row at the replacement's instant. History whose source the machine pruned (whole
 * sessions, or messages a client removed or compacted) is kept, at the cost of
 * keeping rows whose model or tokens a new parser also changed. */
export async function dropSupersededEvents(
  db: SQLiteDatabase,
  environmentId: string,
  parserVersion: string,
): Promise<number> {
  const fields = [
    "client", "session_id", "model_id", "input_tokens", "output_tokens",
    "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
  ];
  const content = fields.join(", ");
  const same = (a: string, b: string) => fields.map((f) => `${a}.${f} = ${b}.${f}`).join(" and ");
  // Within a content group, old rows sharing an inserted row's instant are
  // paired first (re-keys that keep their timestamp), then the rest in time
  // order (re-keys that shift every timestamp alike), so the compacted sibling
  // is the one kept whichever order the two events had.
  const result = await db.runAsync(
    `with inserted as (
       select u.event_id, u.occurred_at_ms, ${fields.map((f) => `u.${f}`).join(", ")}
       from reconcile_new_events as tracked
       join usage_events as u on u.event_id = tracked.event_id
       where tracked.environment_id = ?1 and u.environment_id = ?1 and u.parser_version = ?2
     ),
     candidates as (
       select old.event_id, old.occurred_at_ms, ${fields.map((f) => `old.${f}`).join(", ")},
         exists (
           select 1 from inserted
           where ${same("inserted", "old")} and inserted.occurred_at_ms = old.occurred_at_ms
         ) as same_instant
       from usage_events as old
       where old.environment_id = ?1 and old.parser_version <> ?2
         and exists (
           select 1 from reconcile_sessions as reported
           where reported.environment_id = ?1
             and reported.client = old.client
             and reported.session_id = old.session_id)
     ),
     stale as (
       select event_id, ${content},
         row_number() over (
           partition by ${content}
           order by same_instant desc, occurred_at_ms, event_id) as nth
       from candidates
     ),
     replacements as (
       select ${content}, count(*) as available from inserted group by ${content}
     )
     delete from usage_events where event_id in (
       select stale.event_id from stale join replacements using (${content})
       where stale.nth <= replacements.available)`,
    [environmentId, parserVersion],
  );
  await forgetReconciliation(db, environmentId);
  return result.changes;
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
  trackInsertedFor: string | null = null,
): Promise<number> {
  let changed = 0;
  // 32 × 27 bindings stays below the classic 999-parameter SQLite limit.
  for (let i = 0; i < events.length; i += 32) {
    assertActive();
    const chunk = events.slice(i, i + 32);
    const known =
      trackInsertedFor === null
        ? null
        : new Set(
            (
              await db.getAllAsync<{ event_id: string }>(
                `select event_id from usage_events where event_id in (${chunk.map(() => "?").join(",")})`,
                chunk.map((e) => e.eventId),
              )
            ).map((row) => row.event_id),
          );
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
    const inserted = known === null ? [] : chunk.filter((e) => !known.has(e.eventId));
    if (inserted.length > 0)
      await db.runAsync(
        `insert or ignore into reconcile_new_events (environment_id, event_id)
         values ${inserted.map(() => "(?, ?)").join(",")}`,
        inserted.flatMap((e) => [trackInsertedFor, e.eventId]),
      );
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
