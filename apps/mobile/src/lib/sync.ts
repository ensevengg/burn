/**
 * Sync engine. Cloud mode: revision-keyed delta pull (D5) applied in one
 * SQLite transaction per page, watermark advanced only after commit. Demo
 * mode: the bundled generator writes the same mirror schema locally.
 */
import { machineMetricId, quotaMirrorRowKey } from "@burn/sync-api";
import { pullCloud, type SyncResult } from "./sync-cloud";
import { cloudGeneration, advanceCloudGeneration, publishMirrorChange } from "./sync-state";
import { invalidateEventCache } from "../data/repository";
import { kvSet, wipeForReseed, type SQLiteDatabase } from "./db";
import { withWriteLock } from "./writelock";
import { loadConnectedPhone } from "./connection";
import { generateDemoDataset, MODELS } from "../data/demo-generator";

/** Demo data is generator-controlled, so literal interpolation is safe here. */
function sqlStr(value: string | null): string {
  return value === null ? "null" : `'${value.replace(/'/g, "''")}'`;
}
function sqlNum(decimalString: string): string {
  return Number.isFinite(Number(decimalString)) ? decimalString : "0";
}

export function seedDemoData(db: SQLiteDatabase): Promise<void> {
  // The lock spans wipe + seed: a double-tap must not interleave two seeds.
  return withWriteLock(() => seedDemoDataUnlocked(db));
}

async function seedDemoDataUnlocked(db: SQLiteDatabase): Promise<void> {
  const dataset = generateDemoDataset();
  await wipeForReseed(db);
  const envId: Record<string, string> = {};
  await db.withTransactionAsync(async () => {
    for (const env of dataset.environments) {
      const id = `demo-${env.slug}`;
      envId[env.slug] = id;
      await db.runAsync(
        `insert or replace into environments
           (id, slug, display_name, host_group, os_kind, tokscale_version, export_schema, reporting_timezone, last_heartbeat_at, last_success_at, latest_revision)
         values (?, ?, ?, ?, ?, '4.15.1', 1, ?, ?, ?, 1)`,
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
      const rowKey = quotaMirrorRowKey(
        quota.environmentSlug,
        quota.provider,
        quota.accountKey,
        quota.metric,
      );
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

    for (const metric of dataset.metrics) {
      const environmentId = envId[metric.environmentSlug] ?? metric.environmentSlug;
      await db.runAsync(
        `insert or replace into machine_metrics
           (id, environment_id, captured_at_ms, cpu_load_pct, cpu_temp_c, ram_used_pct,
            ram_temp_c, gpu_util_pct, gpu_temp_c, revision)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          machineMetricId(environmentId, metric.capturedAtMs),
          environmentId,
          metric.capturedAtMs,
          metric.cpuLoadPct,
          metric.cpuTempC,
          metric.ramUsedPct,
          metric.ramTempC,
          metric.gpuUtilPct,
          metric.gpuTempC,
        ],
      );
    }

    // Unique-model price list (USD per million tokens) — cache savings math.
    // Already inside the seed transaction: no nested withTransactionAsync here
    // (expo-sqlite rejects nested transactions).
    const prices: Record<string, { input: number; output: number; cacheRead: number }> = {};
    for (const model of MODELS) {
      prices[model.modelId] = {
        input: model.input,
        output: model.output,
        cacheRead: model.cacheRead,
      };
    }
    for (const [modelId, price] of Object.entries(prices)) {
      await db.runAsync(
        "insert or replace into model_prices (model_id, input_cost_per_m, cache_read_cost_per_m, output_cost_per_m) values (?, ?, ?, ?)",
        [modelId, price.input, price.cacheRead, price.output],
      );
    }

    await kvSet(db, "mode", "demo");
  });
  // Post-commit eviction, still inside the seed's write lock — same contract
  // as resetDb and removeEnvironmentLocal.
  invalidateEventCache(db);
}

export { type SyncResult } from "./sync-cloud";

const inFlight = new WeakMap<SQLiteDatabase, Promise<SyncResult>>();
export function syncFromCloud(db: SQLiteDatabase): Promise<SyncResult> {
  const existing = inFlight.get(db);
  if (existing) return existing;
  const generation = cloudGeneration(db);
  const assertActive = () => {
    if (cloudGeneration(db) !== generation) throw new Error("Sync cancelled");
  };
  const pending = (async () => {
    const connected = await loadConnectedPhone();
    assertActive();
    if (connected === null) throw new Error("Not connected to a backend");
    return pullCloud(db, connected.phone, assertActive, (kind) => {
      if (kind === "events") invalidateEventCache(db);
      publishMirrorChange(db, kind);
    });
  })();
  inFlight.set(db, pending);
  void pending
    .finally(() => {
      if (inFlight.get(db) === pending) inFlight.delete(db);
    })
    .catch(() => {});
  return pending;
}

/** Called before a reset/backend change; old network responses cannot commit. */
export function cancelCloudSync(db: SQLiteDatabase): void {
  advanceCloudGeneration(db);
  inFlight.delete(db);
  invalidateEventCache(db);
}

export async function requestMachineSync(db: SQLiteDatabase, environmentId: string | null): Promise<void> {
  const generation = cloudGeneration(db);
  const connected = await loadConnectedPhone();
  if (cloudGeneration(db) !== generation) throw new Error("Sync cancelled");
  if (connected === null) throw new Error("Not connected to a backend");
  await connected.phone.requestSync(environmentId ?? undefined);
}
