import {
  liveEventId,
  machineMetricId,
  type IngestEventInput,
  type IngestMachineMetricInput,
  type MachineMetric,
} from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";

/**
 * Bound-row batch shared by every usage-event mirror writer.
 * 400 rows × 28 columns = 11,200 bindings, below Expo SQLite's 32,766 limit.
 */
export const EVENT_WRITE_BATCH_SIZE = 400;

export async function upsertMachineMetrics(
  db: SQLiteDatabase,
  environmentId: string,
  metrics: (IngestMachineMetricInput | MachineMetric)[],
): Promise<number> {
  let changed = 0;
  for (const metric of metrics) {
    const cloud = "id" in metric;
    const result = await db.runAsync(
      `insert into machine_metrics
         (id, environment_id, captured_at_ms, cpu_load_pct, cpu_temp_c, ram_used_pct,
          ram_temp_c, gpu_util_pct, gpu_temp_c, revision)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set
         cpu_load_pct = excluded.cpu_load_pct, cpu_temp_c = excluded.cpu_temp_c,
         ram_used_pct = excluded.ram_used_pct, ram_temp_c = excluded.ram_temp_c,
         gpu_util_pct = excluded.gpu_util_pct, gpu_temp_c = excluded.gpu_temp_c,
         revision = excluded.revision
       where machine_metrics.revision = 0 or excluded.revision > machine_metrics.revision`,
      [
        cloud ? metric.id : machineMetricId(environmentId, metric.capturedAtMs),
        environmentId,
        metric.capturedAtMs,
        metric.cpuLoadPct,
        metric.cpuTempC,
        metric.ramUsedPct,
        metric.ramTempC,
        metric.gpuUtilPct,
        metric.gpuTempC,
        cloud ? metric.revision : 0,
      ],
    );
    changed += result.changes;
  }
  return changed;
}

/**
 * Merge machine-served rows into the phone mirror without letting a
 * provisional revision-0 row overwrite a cloud-authoritative row.
 * The caller owns the surrounding transaction and post-commit invalidation.
 */
export async function upsertProvisionalEvents(
  db: SQLiteDatabase,
  environment: { id: string; slug: string },
  events: IngestEventInput[],
): Promise<number> {
  let changed = 0;
  for (let i = 0; i < events.length; i += EVENT_WRITE_BATCH_SIZE) {
    const chunk = events.slice(i, i + EVENT_WRITE_BATCH_SIZE);
    const result = await db.runAsync(
      `insert into usage_events
         (event_id, environment_id, client, provider_id, model_id, session_id, session_title,
          workspace_key, workspace_label, agent, occurred_at_ms, source_offset_minutes, source_timezone,
          source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source,
          cost_is_complete, model_attribution_conflicted, parser_version, revision)
       values ${chunk.map(() => "(" + Array(28).fill("?").join(",") + ")").join(",")}
       on conflict (event_id) do update set
         client = excluded.client, provider_id = excluded.provider_id,
         model_id = excluded.model_id, session_id = excluded.session_id,
         session_title = excluded.session_title, workspace_key = excluded.workspace_key,
         workspace_label = excluded.workspace_label, agent = excluded.agent,
         occurred_at_ms = excluded.occurred_at_ms,
         source_offset_minutes = excluded.source_offset_minutes,
         source_timezone = excluded.source_timezone,
         source_local_date = excluded.source_local_date,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         reasoning_tokens = excluded.reasoning_tokens,
         message_count = excluded.message_count, is_turn_start = excluded.is_turn_start,
         duration_ms = excluded.duration_ms, cost = excluded.cost,
         cost_source = excluded.cost_source, cost_is_complete = excluded.cost_is_complete,
         model_attribution_conflicted = excluded.model_attribution_conflicted,
         parser_version = excluded.parser_version, revision = excluded.revision
       where usage_events.revision = 0 and (
         usage_events.client is not excluded.client or
         usage_events.provider_id is not excluded.provider_id or
         usage_events.model_id is not excluded.model_id or
         usage_events.session_id is not excluded.session_id or
         usage_events.session_title is not excluded.session_title or
         usage_events.workspace_key is not excluded.workspace_key or
         usage_events.workspace_label is not excluded.workspace_label or
         usage_events.agent is not excluded.agent or
         usage_events.occurred_at_ms is not excluded.occurred_at_ms or
         usage_events.source_offset_minutes is not excluded.source_offset_minutes or
         usage_events.source_timezone is not excluded.source_timezone or
         usage_events.source_local_date is not excluded.source_local_date or
         usage_events.input_tokens is not excluded.input_tokens or
         usage_events.output_tokens is not excluded.output_tokens or
         usage_events.cache_read_tokens is not excluded.cache_read_tokens or
         usage_events.cache_write_tokens is not excluded.cache_write_tokens or
         usage_events.reasoning_tokens is not excluded.reasoning_tokens or
         usage_events.message_count is not excluded.message_count or
         usage_events.is_turn_start is not excluded.is_turn_start or
         usage_events.duration_ms is not excluded.duration_ms or
         usage_events.cost is not excluded.cost or
         usage_events.cost_source is not excluded.cost_source or
         usage_events.cost_is_complete is not excluded.cost_is_complete or
         usage_events.model_attribution_conflicted is not excluded.model_attribution_conflicted or
         usage_events.parser_version is not excluded.parser_version
       )`,
      chunk.flatMap((event) => [
        liveEventId(environment.slug, event.client, event.dedupKey),
        environment.id,
        event.client,
        event.providerId,
        event.modelId,
        event.sessionId,
        event.sessionTitle,
        event.workspaceKey,
        event.workspaceLabel,
        event.agent,
        event.occurredAtMs,
        event.sourceOffsetMinutes,
        event.sourceTimezone,
        event.sourceLocalDate,
        event.inputTokens,
        event.outputTokens,
        event.cacheReadTokens,
        event.cacheWriteTokens,
        event.reasoningTokens,
        event.messageCount,
        event.isTurnStart ? 1 : 0,
        event.durationMs,
        event.cost,
        event.costSource,
        event.costIsComplete ? 1 : 0,
        event.modelAttributionConflicted ? 1 : 0,
        event.parserVersion,
        0,
      ]),
    );
    changed += result.changes;
  }
  return changed;
}
