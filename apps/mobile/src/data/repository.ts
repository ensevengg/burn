/**
 * Read layer: pure db → view-model functions. All screens render from these;
 * TanStack Query just wraps them. SQLite does the summing; JS only maps its
 * groups into reporting-timezone buckets (D8), so no screen reads one row per
 * event. Pure per-event reducers remain as the reference the tests compare
 * against.
 */
import type { SQLiteDatabase } from "expo-sqlite";
import { bucketKey, bucketLabel, constantZoneOffset, type Granularity } from "../lib/format";
import { createYieldBudget, runImmediately } from "../lib/cooperative";
import { withWriteLock } from "../lib/writelock";
import { usageWindowStart, type UsageWindowDays } from "../lib/usage-range";

export const DAY_MS = 86_400_000;

export interface EventRow {
  eventId: string;
  environmentId: string;
  client: string;
  providerId: string;
  modelId: string;
  sessionId: string;
  sessionTitle: string | null;
  workspaceLabel: string | null;
  occurredAtMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  messageCount: number;
  durationMs: number | null;
  cost: number;
  costSource: string;
  costIsComplete: boolean;
}

export interface EnvironmentRow {
  id: string;
  slug: string;
  displayName: string;
  hostGroup: string | null;
  osKind: string;
  tokscaleVersion: string | null;
  reporterVersion: string | null;
  lastHeartbeatAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  directInitialSyncComplete: boolean | null;
}

export interface MachineMetricRow {
  id: string;
  capturedAtMs: number;
  cpuLoadPct: number;
  cpuTempC: number | null;
  ramUsedPct: number;
  ramTempC: number | null;
  gpuUtilPct: number | null;
  gpuTempC: number | null;
}

export interface SystemRow extends EnvironmentRow {
  metrics: MachineMetricRow[];
  /** Registered endpoint and last advertised capabilities (null/[] for demo
   * or never-pinged machines); live probes supersede them. */
  endpoint: string | null;
  capabilities: string[];
}

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  messages: number;
  cost: number;
  /** cacheRead / (cacheRead + input + cacheWrite) */
  hitRate: number;
  /** Fraction of cost rows with complete pricing. */
  costCoverage: number;
}

export interface SeriesBucket {
  key: string;
  label: string;
  tokens: number;
  cost: number;
  stacks: Record<string, number>;
  /** Token-bucket split per bucket — powers the cache-hit-rate line. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function sessionKey(e: Pick<EventRow, "environmentId" | "client" | "sessionId">): string {
  return JSON.stringify([e.environmentId, e.client, e.sessionId]);
}

/** Window reads keyed by window; evicted whenever mirrored events change. */
const windowReadCache = new WeakMap<SQLiteDatabase, Map<string, Promise<unknown>>>();
export function invalidateEventCache(db: SQLiteDatabase): void {
  windowReadCache.delete(db);
}

export function groupKeyFor(event: EventRow, groupBy: "model" | "client" | "none"): string {
  if (groupBy === "model") return event.modelId;
  if (groupBy === "client") return event.client;
  return "All";
}

/** Total tokens across the five buckets — the single source of that sum. */
export function eventTokens(
  e: Pick<
    EventRow,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens"
  >,
): number {
  return e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens + e.reasoningTokens;
}

export interface DayAgg {
  tokens: number;
  cost: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * The one day-bucketing implementation (it used to be written four times). Buckets
 * events by calendar key in the reporting timezone at the given granularity.
 * Pure — tests feed it synthetic rows directly.
 */
export function bucketEvents(
  events: EventRow[],
  timeZone: string,
  granularity: Granularity,
): Map<string, DayAgg> {
  return runImmediately(bucketEventsWork(events, timeZone, granularity));
}

function* bucketEventsWork(
  events: EventRow[],
  timeZone: string,
  granularity: Granularity,
): Generator<void, Map<string, DayAgg>> {
  let processed = 0;
  const byKey = new Map<string, DayAgg>();
  for (const e of events) {
    if (++processed % 256 === 0) yield;
    const key = bucketKey(e.occurredAtMs, timeZone, granularity);
    const agg = byKey.get(key) ?? {
      tokens: 0,
      cost: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    agg.tokens += eventTokens(e);
    agg.cost += e.cost;
    agg.inputTokens += e.inputTokens;
    agg.cacheReadTokens += e.cacheReadTokens;
    agg.cacheWriteTokens += e.cacheWriteTokens;
    byKey.set(key, agg);
  }
  return byKey;
}

/**
 * Fixed Y ceiling: the largest bucket total across ALL history (user direction:
 * the Y axis stays pinned to the historical peak so every window compares
 * against the same ceiling — only X moves).
 */
export function computeGranularityMax(
  events: EventRow[],
  timeZone: string,
  granularity: Granularity,
  metric: "cost" | "tokens" = "tokens",
): number {
  let max = 0;
  for (const agg of bucketEvents(events, timeZone, granularity).values()) {
    const value = metric === "cost" ? agg.cost : agg.tokens;
    if (value > max) max = value;
  }
  return max;
}

export function buildSeries(
  events: EventRow[],
  timeZone: string,
  granularity: Granularity,
  groupBy: "model" | "client" | "none",
): SeriesBucket[] {
  return runImmediately(buildSeriesWork(events, timeZone, granularity, groupBy));
}

function* buildSeriesWork(
  events: EventRow[],
  timeZone: string,
  granularity: Granularity,
  groupBy: "model" | "client" | "none",
): Generator<void, SeriesBucket[]> {
  let processed = 0;
  const byKey = new Map<string, SeriesBucket>();
  for (const e of events) {
    if (++processed % 256 === 0) yield;
    const key = bucketKey(e.occurredAtMs, timeZone, granularity);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = {
        key,
        label: bucketLabel(key, granularity),
        tokens: 0,
        cost: 0,
        stacks: {},
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      byKey.set(key, bucket);
    }
    const tokens =
      e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens + e.reasoningTokens;
    bucket.tokens += tokens;
    bucket.cost += e.cost;
    bucket.inputTokens += e.inputTokens;
    bucket.cacheReadTokens += e.cacheReadTokens;
    bucket.cacheWriteTokens += e.cacheWriteTokens;
    const group = groupKeyFor(e, groupBy);
    bucket.stacks[group] = (bucket.stacks[group] ?? 0) + tokens;
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Width of the UTC slots SQL aggregates into before JS re-buckets them. Every
 * zone's offset is a multiple of 15 minutes, so all events in one slot share
 * a calendar hour, day, month and year in any reporting timezone (D8): the
 * re-bucketed totals equal bucketing each event, without reading each event. */
const SLOT_MS = 900_000;
const TOKEN_SUM = "input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens";

export async function queryGranularityMax(
  db: SQLiteDatabase,
  timeZone: string,
  granularity: Granularity,
  metric: "cost" | "tokens" = "tokens",
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) throw new Error("Query cancelled");
  // All history's buckets; both metrics share one read.
  const toMs = Date.now() + DAY_MS;
  const buckets = await cachedRead(db, windowKey("series", 0, toMs, timeZone, granularity), () =>
    windowSeriesUncached(db, 0, toMs, timeZone, granularity),
  );
  if (signal?.aborted) throw new Error("Query cancelled");
  let max = 0;
  for (const bucket of buckets) {
    const value = metric === "cost" ? bucket.cost : bucket.tokens;
    if (value > max) max = value;
  }
  return max;
}

/** Local mirror deletion for machine removal (machine registry is removed separately). */
export function removeEnvironmentLocal(db: SQLiteDatabase, environmentId: string): Promise<void> {
  return withWriteLock(async () => {
    await db.withTransactionAsync(async () => {
      await db.runAsync("delete from usage_events where environment_id = ?", [environmentId]);
      await db.runAsync("delete from quota_snapshots where environment_id = ?", [environmentId]);
      await db.runAsync("delete from machine_metrics where environment_id = ?", [environmentId]);
      await db.runAsync("delete from environments where id = ?", [environmentId]);
    });
    // Post-commit eviction: a read racing the delete can cache pre-delete rows,
    // so the cache must be cleared only after the writes are durable.
    invalidateEventCache(db);
  });
}

export interface BreakdownRow extends Totals {
  key: string;
  title: string;
  subtitle: string | null;
  providers: string[];
  clients: string[];
  sessions: number;
}

/**
 * Explore's ranked lists. Nothing here depends on the reporting timezone, so
 * SQLite groups the window and returns one row per model, agent or workspace
 * instead of every event in it.
 */
async function queryBreakdown(
  db: SQLiteDatabase,
  keySql: string,
  days: UsageWindowDays,
  environmentId: string | null,
  signal?: AbortSignal,
): Promise<BreakdownRow[]> {
  if (signal?.aborted) throw new Error("Query cancelled");
  const where = `occurred_at_ms >= ? and occurred_at_ms < ?${environmentId !== null ? " and environment_id = ?" : ""}`;
  const bindings = [usageWindowStart(days), Date.now() + DAY_MS, ...(environmentId !== null ? [environmentId] : [])];
  const groups = await db.getAllAsync<Record<string, unknown>>(
    `select ${keySql} as key,
            sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
            sum(cache_read_tokens) as cache_read_tokens, sum(cache_write_tokens) as cache_write_tokens,
            sum(reasoning_tokens) as reasoning_tokens, sum(message_count) as messages,
            sum(cast(cost as real)) as cost, count(*) as events, sum(cost_is_complete) as costed,
            count(distinct environment_id || char(31) || client || char(31) || session_id) as sessions
       from usage_events where ${where} group by 1`,
    bindings,
  );
  if (signal?.aborted) throw new Error("Query cancelled");
  // Which providers and agents contributed, as rows rather than a joined
  // string: identifiers are machine-supplied and may contain any separator.
  const sources = await db.getAllAsync<{ key: string; provider_id: string; client: string }>(
    `select ${keySql} as key, provider_id, client from usage_events where ${where} group by 1, 2, 3`,
    bindings,
  );
  if (signal?.aborted) throw new Error("Query cancelled");
  const providers = new Map<string, Set<string>>();
  const clients = new Map<string, Set<string>>();
  for (const source of sources) {
    const key = String(source.key);
    if (!providers.has(key)) providers.set(key, new Set());
    if (!clients.has(key)) clients.set(key, new Set());
    providers.get(key)!.add(String(source.provider_id));
    clients.get(key)!.add(String(source.client));
  }
  const rows: BreakdownRow[] = groups.map((r) => {
    const key = String(r["key"]);
    const inputTokens = Number(r["input_tokens"] ?? 0);
    const cacheReadTokens = Number(r["cache_read_tokens"] ?? 0);
    const cacheWriteTokens = Number(r["cache_write_tokens"] ?? 0);
    const events = Number(r["events"] ?? 0);
    const cacheTotal = cacheReadTokens + inputTokens + cacheWriteTokens;
    return {
      key,
      title: key,
      subtitle: null,
      inputTokens,
      outputTokens: Number(r["output_tokens"] ?? 0),
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: Number(r["reasoning_tokens"] ?? 0),
      messages: Number(r["messages"] ?? 0),
      cost: Number(r["cost"] ?? 0),
      hitRate: cacheTotal === 0 ? 0 : cacheReadTokens / cacheTotal,
      costCoverage: events === 0 ? 0 : Number(r["costed"] ?? 0) / events,
      providers: [...(providers.get(key) ?? [])].sort(),
      clients: [...(clients.get(key) ?? [])].sort(),
      sessions: Number(r["sessions"] ?? 0),
    };
  });
  return rows.sort((a, b) => eventTokens(b) - eventTokens(a) || b.cost - a.cost || (a.key < b.key ? -1 : 1));
}

export function queryModels(
  db: SQLiteDatabase,
  days: UsageWindowDays,
  environmentId: string | null,
  signal?: AbortSignal,
) {
  return queryBreakdown(db, "model_id", days, environmentId, signal);
}

export function queryClients(
  db: SQLiteDatabase,
  days: UsageWindowDays,
  environmentId: string | null,
  signal?: AbortSignal,
) {
  return queryBreakdown(db, "client", days, environmentId, signal);
}

export function queryWorkspaces(
  db: SQLiteDatabase,
  days: UsageWindowDays,
  environmentId: string | null,
  signal?: AbortSignal,
) {
  return queryBreakdown(db, "coalesce(workspace_label, '(no workspace)')", days, environmentId, signal);
}

export interface SessionRow {
  key: string;
  environmentId: string;
  sessionId: string;
  title: string | null;
  lastActivityMs: number;
  client: string;
  models: string[];
  tokens: number;
  cost: number;
  messages: number;
}

/** The window's most recent sessions, grouped by SQLite in one pass: one row
 * per (session, model) for the newest `limit` sessions, however long each ran. */
export async function querySessions(
  db: SQLiteDatabase,
  days: UsageWindowDays,
  environmentId: string | null,
  limit = 60,
  signal?: AbortSignal,
): Promise<SessionRow[]> {
  if (signal?.aborted) throw new Error("Query cancelled");
  const scope = environmentId !== null ? " and environment_id = ?" : "";
  const window = [usageWindowStart(days), Date.now() + DAY_MS, ...(environmentId !== null ? [environmentId] : [])];
  // The earliest title wins: zero-padded instants sort as numbers, so the
  // smallest "<instant><title>" string is the earliest titled row's.
  const groups = await db.getAllAsync<Record<string, unknown>>(
    `with recent as (
       select environment_id, client, session_id from usage_events
        where occurred_at_ms >= ? and occurred_at_ms < ?${scope}
        group by environment_id, client, session_id
        order by max(occurred_at_ms) desc, environment_id, client, session_id limit ?
     )
     select u.environment_id, u.client, u.session_id, u.model_id,
            min(u.occurred_at_ms) as first_ms, max(u.occurred_at_ms) as last_ms,
            sum(${TOKEN_SUM.replace(/(\w+_tokens)/g, "u.$1")}) as tokens, sum(cast(u.cost as real)) as cost,
            sum(u.message_count) as messages,
            min(case when u.session_title is not null then printf('%020d', u.occurred_at_ms) || u.session_title end) as title
       from recent r join usage_events u
         on u.environment_id = r.environment_id and u.client = r.client and u.session_id = r.session_id
      where u.occurred_at_ms >= ? and u.occurred_at_ms < ?${scope.replace("environment_id", "u.environment_id")}
      group by u.environment_id, u.client, u.session_id, u.model_id
      order by first_ms, u.model_id`,
    [...window, Math.max(0, Math.floor(limit)), ...window],
  );
  if (signal?.aborted) throw new Error("Query cancelled");
  const bySession = new Map<string, SessionRow & { titleKey: string | null }>();
  for (const g of groups) {
    const ids = { environmentId: String(g["environment_id"]), client: String(g["client"]), sessionId: String(g["session_id"]) };
    const key = sessionKey(ids);
    let row = bySession.get(key);
    if (!row) {
      row = { key, ...ids, title: null, titleKey: null, lastActivityMs: 0, models: [], tokens: 0, cost: 0, messages: 0 };
      bySession.set(key, row);
    }
    row.models.push(String(g["model_id"]));
    row.lastActivityMs = Math.max(row.lastActivityMs, Number(g["last_ms"]));
    row.tokens += Number(g["tokens"] ?? 0);
    row.cost += Number(g["cost"] ?? 0);
    row.messages += Number(g["messages"] ?? 0);
    const titleKey = (g["title"] as string | null) ?? null;
    if (titleKey !== null && (row.titleKey === null || titleKey < row.titleKey)) row.titleKey = titleKey;
  }
  return [...bySession.values()]
    .map(({ titleKey, ...row }) => ({ ...row, title: titleKey === null ? null : titleKey.slice(20) }))
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export interface QuotaCard {
  provider: string;
  accountKey: string;
  accountLabel: string | null;
  plan: string | null;
  metric: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  remainingLabel: string | null;
  resetsAt: string | null;
  fetchedAt: string;
}

export interface ClientShare {
  key: string;
  tokens: number;
  cost: number;
  sessions: number;
}

export interface WindowOverview {
  totals: Totals;
  /** Distinct sessions in the window. */
  sessions: number;
  series: SeriesBucket[];
  byClient: ClientShare[];
  /** Null when no model price reference exists (machine pricing payload pending). */
  cacheSavings: number | null;
}

interface WindowAggregates {
  totals: Totals;
  sessions: number;
  byClient: ClientShare[];
  cacheSavings: number | null;
}

/** Caches one minute's window reads. */
function cachedRead<T>(db: SQLiteDatabase, key: string, load: () => Promise<T>): Promise<T> {
  let cache = windowReadCache.get(db);
  if (!cache) {
    cache = new Map();
    windowReadCache.set(db, cache);
  }
  let pending = cache.get(key) as Promise<T> | undefined;
  if (!pending) {
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    pending = load();
    cache.set(key, pending);
    const current = cache;
    const entry = pending;
    void entry.catch(() => {
      if (current.get(key) === entry) current.delete(key);
    });
  }
  return pending;
}

/** Rolling ranges move each minute, so reads in one minute share a window. */
const windowKey = (kind: string, fromMs: number, toMs: number, ...rest: string[]) =>
  JSON.stringify([kind, Math.floor(fromMs / 60_000), Math.floor(toMs / 60_000), ...rest]);

/**
 * One window's sums, computed by SQLite: one row per agent for totals and
 * shares, and per-model cache reads for savings. Independent of the metric,
 * granularity and reporting timezone.
 */
async function aggregateWindowUncached(db: SQLiteDatabase, fromMs: number, toMs: number): Promise<WindowAggregates> {
  const where = "occurred_at_ms >= ? and occurred_at_ms < ?";
  const bindings = [fromMs, toMs];
  // A session key includes its agent, so per-agent session counts are disjoint
  // and their sum is the window's distinct session count.
  const clientRows = await db.getAllAsync<Record<string, unknown>>(
    `select client, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
            sum(cache_read_tokens) as cache_read_tokens, sum(cache_write_tokens) as cache_write_tokens,
            sum(reasoning_tokens) as reasoning_tokens, sum(message_count) as messages,
            sum(cast(cost as real)) as cost, count(*) as events, sum(cost_is_complete) as costed,
            count(distinct environment_id || char(31) || session_id) as sessions
       from usage_events where ${where} group by client`,
    bindings,
  );
  const totals: Totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    messages: 0,
    cost: 0,
    hitRate: 0,
    costCoverage: 0,
  };
  let events = 0;
  let costed = 0;
  let sessions = 0;
  const byClient: ClientShare[] = [];
  for (const r of clientRows) {
    const row = {
      inputTokens: Number(r["input_tokens"] ?? 0),
      outputTokens: Number(r["output_tokens"] ?? 0),
      cacheReadTokens: Number(r["cache_read_tokens"] ?? 0),
      cacheWriteTokens: Number(r["cache_write_tokens"] ?? 0),
      reasoningTokens: Number(r["reasoning_tokens"] ?? 0),
    };
    const cost = Number(r["cost"] ?? 0);
    const clientSessions = Number(r["sessions"] ?? 0);
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.cacheWriteTokens += row.cacheWriteTokens;
    totals.reasoningTokens += row.reasoningTokens;
    totals.messages += Number(r["messages"] ?? 0);
    totals.cost += cost;
    events += Number(r["events"] ?? 0);
    costed += Number(r["costed"] ?? 0);
    sessions += clientSessions;
    byClient.push({ key: String(r["client"]), tokens: eventTokens(row), cost, sessions: clientSessions });
  }
  const cacheTotal = totals.cacheReadTokens + totals.inputTokens + totals.cacheWriteTokens;
  totals.hitRate = cacheTotal === 0 ? 0 : totals.cacheReadTokens / cacheTotal;
  totals.costCoverage = events === 0 ? 0 : costed / events;

  const priceRows = await db.getAllAsync<{
    model_id: string;
    input_cost_per_m: number;
    cache_read_cost_per_m: number;
  }>("select model_id, input_cost_per_m, cache_read_cost_per_m from model_prices");
  let cacheSavings: number | null = null;
  if (priceRows.length > 0) {
    const prices = new Map(priceRows.map((row) => [row.model_id, row]));
    const reads = await db.getAllAsync<{ model_id: string; cache_read_tokens: number }>(
      `select model_id, sum(cache_read_tokens) as cache_read_tokens from usage_events where ${where} group by model_id`,
      bindings,
    );
    cacheSavings = 0;
    for (const read of reads) {
      const price = prices.get(String(read.model_id));
      if (price === undefined) continue;
      cacheSavings +=
        (Number(read.cache_read_tokens) / 1e6) * Math.max(0, price.input_cost_per_m - price.cache_read_cost_per_m);
    }
  }
  return { totals, sessions, byClient, cacheSavings };
}

/**
 * The window's chart buckets in the reporting timezone. When the zone keeps
 * one offset across the days that hold data (no DST, e.g. the default
 * Asia/Kolkata), SQLite groups straight into local hours or days. Otherwise it
 * groups into 15-minute UTC slots, which every zone's offsets respect (D8).
 * Either way JS sees a few rows per bucket, never one per event.
 */
async function windowSeriesUncached(
  db: SQLiteDatabase,
  fromMs: number,
  toMs: number,
  timeZone: string,
  granularity: Granularity,
): Promise<SeriesBucket[]> {
  const where = "occurred_at_ms >= ? and occurred_at_ms < ?";
  const span = await db.getFirstAsync<{ lo: number | null; hi: number | null }>(
    `select min(occurred_at_ms) as lo, max(occurred_at_ms) as hi from usage_events where ${where}`,
    [fromMs, toMs],
  );
  if (span?.lo === null || span?.lo === undefined || span.hi === null) return [];
  const offset = constantZoneOffset(timeZone, Number(span.lo), Number(span.hi));
  const local = offset !== null && Number(span.lo) + offset >= 0;
  const width = local ? (granularity === "hourly" ? 3_600_000 : DAY_MS) : SLOT_MS;
  const shift = local ? offset : 0;
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `select (occurred_at_ms + ?) / ? as slot, sum(${TOKEN_SUM}) as tokens, sum(cast(cost as real)) as cost,
            sum(input_tokens) as input_tokens, sum(cache_read_tokens) as cache_read_tokens,
            sum(cache_write_tokens) as cache_write_tokens
       from usage_events where ${where} group by slot order by slot`,
    [shift, width, fromMs, toMs],
  );
  const byKey = new Map<string, SeriesBucket>();
  // Shared through the cache, so no single caller's signal may cancel it.
  const yieldIfNeeded = createYieldBudget();
  for (let i = 0; i < rows.length; i++) {
    if (i % 256 === 0) {
      const pause = yieldIfNeeded();
      if (pause) await pause;
    }
    const r = rows[i]!;
    const key = bucketKey(Number(r["slot"]) * width - shift, timeZone, granularity);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = {
        key,
        label: bucketLabel(key, granularity),
        tokens: 0,
        cost: 0,
        stacks: {},
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      byKey.set(key, bucket);
    }
    bucket.tokens += Number(r["tokens"] ?? 0);
    bucket.cost += Number(r["cost"] ?? 0);
    bucket.inputTokens += Number(r["input_tokens"] ?? 0);
    bucket.cacheReadTokens += Number(r["cache_read_tokens"] ?? 0);
    bucket.cacheWriteTokens += Number(r["cache_write_tokens"] ?? 0);
  }
  return [...byKey.values()]
    .map((bucket) => ({ ...bucket, stacks: { All: bucket.tokens } }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Everything the restructured dashboard headline/strip/table needs, per window. */
export async function queryWindowOverview(
  db: SQLiteDatabase,
  timeZone: string,
  days: UsageWindowDays,
  metric: "cost" | "tokens",
  granularity: Granularity = "daily",
  signal?: AbortSignal,
): Promise<WindowOverview> {
  const now = Date.now();
  const fromMs = usageWindowStart(days, now);
  const toMs = now + DAY_MS;
  if (signal?.aborted) throw new Error("Query cancelled");
  // Switching Cost/Tokens reuses both reads; only the share order changes.
  const [window, series] = await Promise.all([
    cachedRead(db, windowKey("totals", fromMs, toMs), () => aggregateWindowUncached(db, fromMs, toMs)),
    cachedRead(db, windowKey("series", fromMs, toMs, timeZone, granularity), () =>
      windowSeriesUncached(db, fromMs, toMs, timeZone, granularity),
    ),
  ]);
  if (signal?.aborted) throw new Error("Query cancelled");
  const byClient = [...window.byClient].sort((a, b) =>
    metric === "cost" ? b.cost - a.cost : b.tokens - a.tokens,
  );
  return {
    totals: { ...window.totals },
    sessions: window.sessions,
    series: series.map((bucket) => ({ ...bucket, stacks: { ...bucket.stacks } })),
    byClient,
    cacheSavings: window.cacheSavings,
  };
}

/** The metric's total over the window just before `days` (same length);
 * null for All, which has nothing before it. One SQL sum, no rows. */
export async function queryPreviousWindowTotal(
  db: SQLiteDatabase,
  days: UsageWindowDays,
  metric: "cost" | "tokens",
  signal?: AbortSignal,
): Promise<number | null> {
  if (days === null) return null;
  if (signal?.aborted) throw new Error("Query cancelled");
  const now = Date.now();
  const row = await db.getFirstAsync<{ value: number | null }>(
    `select ${metric === "cost" ? "sum(cast(cost as real))" : `sum(${TOKEN_SUM})`} as value
       from usage_events where occurred_at_ms >= ? and occurred_at_ms < ?`,
    [usageWindowStart(days * 2, now), usageWindowStart(days, now)],
  );
  return Number(row?.value ?? 0);
}

/** Relative change; null when there is no earlier usage to compare with. */
export function periodChange(current: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null;
  return (current - previous) / previous;
}

export async function queryQuotas(db: SQLiteDatabase): Promise<QuotaCard[]> {
  // A reading stamped later than now cannot be the freshest; it was written by
  // a machine whose clock ran ahead. It ranks behind every plausible reading
  // and is shown only when nothing else exists.
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "select provider, account_key, account_label, plan, metric, used_percent, remaining_percent, remaining_label, resets_at, fetched_at from quota_snapshots where status = 'ok' order by provider, metric, julianday(fetched_at) > julianday(?), julianday(fetched_at) desc",
    [new Date(Date.now() + 5 * 60_000).toISOString()],
  );
  const seen = new Set<string>();
  const cards: QuotaCard[] = [];
  for (const r of rows) {
    const provider = String(r["provider"]);
    const metric = String(r["metric"]);
    const dedupKey = JSON.stringify([provider, String(r["account_key"]), metric]);
    if (seen.has(dedupKey)) continue; // freshest row wins (rows are ordered by collection time; demo rows may tie)
    seen.add(dedupKey);
    const usedPercent = r["used_percent"] === null ? null : Number(r["used_percent"]);
    const reportedRemaining = r["remaining_percent"] === null ? null : Number(r["remaining_percent"]);
    const remainingPercent = reportedRemaining ?? (usedPercent === null ? null : 100 - usedPercent);
    cards.push({
      provider,
      accountKey: String(r["account_key"]),
      accountLabel: (r["account_label"] as string | null) ?? null,
      plan: (r["plan"] as string | null) ?? null,
      metric,
      usedPercent,
      remainingPercent:
        remainingPercent === null ? null : Math.max(0, Math.min(100, remainingPercent)),
      remainingLabel: (r["remaining_label"] as string | null) ?? null,
      resetsAt: (r["resets_at"] as string | null) ?? null,
      fetchedAt: String(r["fetched_at"]),
    });
  }
  return cards;
}

export async function queryEnvironments(db: SQLiteDatabase): Promise<EnvironmentRow[]> {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `select e.id, e.slug, e.display_name, e.host_group, e.os_kind, e.tokscale_version, e.reporter_version,
            e.last_heartbeat_at, e.last_success_at, e.last_error,
            case when d.id is null then null else exists(
              select 1 from kv where key = 'direct_since_v3_' || e.id
            ) end as direct_initial_sync_complete
       from environments e left join direct_machines d on d.id = e.id order by e.slug`,
  );
  return rows.map((r) => ({
    id: String(r["id"]),
    slug: String(r["slug"]),
    displayName: String(r["display_name"]),
    hostGroup: (r["host_group"] as string | null) ?? null,
    osKind: String(r["os_kind"]),
    tokscaleVersion: (r["tokscale_version"] as string | null) ?? null,
    reporterVersion: (r["reporter_version"] as string | null) ?? null,
    lastHeartbeatAt: (r["last_heartbeat_at"] as string | null) ?? null,
    lastSuccessAt: (r["last_success_at"] as string | null) ?? null,
    lastError: (r["last_error"] as string | null) ?? null,
    directInitialSyncComplete: r["direct_initial_sync_complete"] === null ? null : Number(r["direct_initial_sync_complete"]) === 1,
  }));
}

/** Physical machine vitals only: WSL shares its Windows host's hardware. */
export async function querySystems(db: SQLiteDatabase): Promise<SystemRow[]> {
  const environments = (await queryEnvironments(db)).filter((environment) => environment.osKind !== "wsl");
  const since = Date.now() - DAY_MS;
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `select id, environment_id, captured_at_ms, cpu_load_pct, cpu_temp_c,
            ram_used_pct, ram_temp_c, gpu_util_pct, gpu_temp_c
       from machine_metrics where captured_at_ms >= ? order by captured_at_ms`,
    [since],
  );
  const byEnvironment = new Map<string, MachineMetricRow[]>();
  for (const row of rows) {
    const environmentId = String(row["environment_id"]);
    const metrics = byEnvironment.get(environmentId) ?? [];
    metrics.push({
      id: String(row["id"]),
      capturedAtMs: Number(row["captured_at_ms"]),
      cpuLoadPct: Number(row["cpu_load_pct"]),
      cpuTempC: row["cpu_temp_c"] === null ? null : Number(row["cpu_temp_c"]),
      ramUsedPct: Number(row["ram_used_pct"]),
      ramTempC: row["ram_temp_c"] === null ? null : Number(row["ram_temp_c"]),
      gpuUtilPct: row["gpu_util_pct"] === null ? null : Number(row["gpu_util_pct"]),
      gpuTempC: row["gpu_temp_c"] === null ? null : Number(row["gpu_temp_c"]),
    });
    byEnvironment.set(environmentId, metrics);
  }
  const registrations = await db.getAllAsync<{ id: string; base_url: string; caps: string | null }>(
    `select m.id, m.base_url, kv.value as caps
       from direct_machines m left join kv on kv.key = 'direct_caps_' || m.id`,
  );
  const registered = new Map(registrations.map((row) => [row.id, row]));
  const capabilities = (raw: string | null | undefined): string[] => {
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  };
  return environments.map((environment) => ({
    ...environment,
    metrics: byEnvironment.get(environment.id) ?? [],
    endpoint: registered.get(environment.id)?.base_url ?? null,
    capabilities: capabilities(registered.get(environment.id)?.caps),
  }));
}
