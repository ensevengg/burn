/**
 * Read layer: pure db → view-model functions. All screens render from these;
 * TanStack Query just wraps them. Aggregation happens in JS because buckets
 * are computed in the reporting timezone (D8). Shared window reads and
 * cooperative reducers keep large histories from monopolizing the UI thread.
 */
import type { SQLiteDatabase } from "expo-sqlite";
import { bucketKey, bucketLabel, type Granularity } from "../lib/format";
import { createYieldBudget, runCooperatively, runImmediately } from "../lib/cooperative";
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
  latestRevision: number;
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

const eventCache = new WeakMap<SQLiteDatabase, Map<string, Promise<EventRow[]>>>();
export function invalidateEventCache(db: SQLiteDatabase): void {
  eventCache.delete(db);
}

function loadEvents(
  db: SQLiteDatabase,
  fromMs: number,
  toMs: number,
  environmentId: string | null,
): Promise<EventRow[]> {
  let cache = eventCache.get(db);
  if (!cache) {
    cache = new Map();
    eventCache.set(db, cache);
  }
  // Queries in one minute share a window; rolling ranges revalidate each minute.
  const key = JSON.stringify([Math.floor(fromMs / 60_000), Math.floor(toMs / 60_000), environmentId]);
  let pending = cache.get(key);
  if (!pending) {
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    pending = loadEventsUncached(db, fromMs, toMs, environmentId);
    cache.set(key, pending);
    const current = cache;
    void pending.catch(() => {
      if (current.get(key) === pending) current.delete(key);
    });
  }
  return pending;
}

const bucketCache = new WeakMap<EventRow[], Map<string, Promise<Map<string, DayAgg>>>>();
function cachedBuckets(events: EventRow[], timeZone: string, granularity: Granularity) {
  let cache = bucketCache.get(events);
  if (!cache) {
    cache = new Map();
    bucketCache.set(events, cache);
  }
  const key = JSON.stringify([timeZone, granularity]);
  let pending = cache.get(key);
  if (!pending) {
    pending = runCooperatively(bucketEventsWork(events, timeZone, granularity));
    if (cache.size >= 6) cache.delete(cache.keys().next().value!);
    cache.set(key, pending);
  }
  return pending;
}

async function loadEventsUncached(
  db: SQLiteDatabase,
  fromMs: number,
  toMs: number,
  environmentId: string | null,
  sessionLimit?: number,
): Promise<EventRow[]> {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `${
      sessionLimit === undefined
        ? ""
        : `with recent_sessions as (
       select environment_id, client, session_id from usage_events
       where occurred_at_ms >= ? and occurred_at_ms < ? ${environmentId !== null ? "and environment_id = ?" : ""}
       group by environment_id, client, session_id
       order by max(occurred_at_ms) desc, environment_id, client, session_id limit ?
     )`
    }
     select event_id, environment_id, client, provider_id, model_id, session_id, session_title,
            workspace_label, occurred_at_ms, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, reasoning_tokens, message_count, duration_ms, cost, cost_source,
            cost_is_complete
       from usage_events
      where occurred_at_ms >= ? and occurred_at_ms < ? ${environmentId !== null ? "and environment_id = ?" : ""}
      ${sessionLimit === undefined ? "" : "and (environment_id, client, session_id) in (select environment_id, client, session_id from recent_sessions)"}
      order by occurred_at_ms asc`,
    [
      ...(sessionLimit === undefined
        ? []
        : [...(environmentId !== null ? [fromMs, toMs, environmentId] : [fromMs, toMs]), sessionLimit]),
      ...(environmentId !== null ? [fromMs, toMs, environmentId] : [fromMs, toMs]),
    ],
  );
  const events: EventRow[] = [];
  const yieldIfNeeded = createYieldBudget();
  for (let i = 0; i < rows.length; i += 256) {
    const pause = yieldIfNeeded();
    if (pause) await pause;
    events.push(
      ...rows.slice(i, i + 256).map((r) => ({
        eventId: String(r["event_id"]),
        environmentId: String(r["environment_id"]),
        client: String(r["client"]),
        providerId: String(r["provider_id"]),
        modelId: String(r["model_id"]),
        sessionId: String(r["session_id"]),
        sessionTitle: (r["session_title"] as string | null) ?? null,
        workspaceLabel: (r["workspace_label"] as string | null) ?? null,
        occurredAtMs: Number(r["occurred_at_ms"]),
        inputTokens: Number(r["input_tokens"] ?? 0),
        outputTokens: Number(r["output_tokens"] ?? 0),
        cacheReadTokens: Number(r["cache_read_tokens"] ?? 0),
        cacheWriteTokens: Number(r["cache_write_tokens"] ?? 0),
        reasoningTokens: Number(r["reasoning_tokens"] ?? 0),
        messageCount: Number(r["message_count"] ?? 1),
        durationMs: r["duration_ms"] === null ? null : Number(r["duration_ms"]),
        cost: Number(r["cost"] ?? 0),
        costSource: String(r["cost_source"] ?? "unknown"),
        costIsComplete: Number(r["cost_is_complete"] ?? 0) === 1,
      })),
    );
  }
  return events;
}

function* summarizeEventsWork(events: EventRow[]): Generator<void, Totals> {
  let processed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let messages = 0;
  let cost = 0;
  let costed = 0;
  for (const e of events) {
    if (++processed % 256 === 0) yield;
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    cacheReadTokens += e.cacheReadTokens;
    cacheWriteTokens += e.cacheWriteTokens;
    reasoningTokens += e.reasoningTokens;
    messages += e.messageCount;
    cost += e.cost;
    if (e.costIsComplete) costed += 1;
  }
  const cacheTotal = cacheReadTokens + inputTokens + cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    messages,
    cost,
    hitRate: cacheTotal === 0 ? 0 : cacheReadTokens / cacheTotal,
    costCoverage: events.length === 0 ? 0 : costed / events.length,
  };
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
 * The one day-bucketing implementation (first-check: was written 4×). Buckets
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

/**
 * Cache savings: what the cache-read discount saved vs paying uncached input
 * prices. Null when no price reference is loaded (cloud pricing payload is a
 * spec'd follow-up — AGENTS.md).
 */
export function computeCacheSavings(
  events: EventRow[],
  prices: Record<string, { input: number; cacheRead: number }>,
): number {
  let savings = 0;
  for (const e of events) {
    const price = prices[e.modelId];
    if (price === undefined) continue;
    savings += (e.cacheReadTokens / 1e6) * Math.max(0, price.input - price.cacheRead);
  }
  return savings;
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

export async function queryGranularityMax(
  db: SQLiteDatabase,
  timeZone: string,
  granularity: Granularity,
  metric: "cost" | "tokens" = "tokens",
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, 0, Date.now() + DAY_MS, null);
  if (signal?.aborted) throw new Error("Query cancelled");
  const buckets = await cachedBuckets(events, timeZone, granularity);
  return Math.max(0, ...[...buckets.values()].map((b) => (metric === "cost" ? b.cost : b.tokens)));
}

/** Local mirror deletion for machine removal (server row is deleted separately). */
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

function* breakdownWork(
  events: EventRow[],
  keyFn: (e: EventRow) => { key: string; title: string; subtitle: string | null },
): Generator<void, BreakdownRow[]> {
  let processed = 0;
  const groups = new Map<string, Totals & { title: string; subtitle: string | null; providers: Set<string>; clients: Set<string>; sessions: Set<string>; events: number; costed: number }>();
  for (const e of events) {
    if (++processed % 256 === 0) yield;
    const meta = keyFn(e);
    let row = groups.get(meta.key);
    if (row === undefined) {
      row = { title: meta.title, subtitle: meta.subtitle, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, messages: 0, cost: 0, hitRate: 0, costCoverage: 0, providers: new Set(), clients: new Set(), sessions: new Set(), events: 0, costed: 0 };
      groups.set(meta.key, row);
    }
    row.inputTokens += e.inputTokens; row.outputTokens += e.outputTokens;
    row.cacheReadTokens += e.cacheReadTokens; row.cacheWriteTokens += e.cacheWriteTokens;
    row.reasoningTokens += e.reasoningTokens; row.messages += e.messageCount; row.cost += e.cost;
    row.providers.add(e.providerId); row.clients.add(e.client); row.sessions.add(sessionKey(e));
    row.events += 1; if (e.costIsComplete) row.costed += 1;
  }
  const rows: BreakdownRow[] = [];
  for (const [key, row] of groups) {
    yield;
    const cacheTotal = row.cacheReadTokens + row.inputTokens + row.cacheWriteTokens;
    rows.push({ ...row, key, providers: [...row.providers].sort(), clients: [...row.clients].sort(), sessions: row.sessions.size, hitRate: cacheTotal === 0 ? 0 : row.cacheReadTokens / cacheTotal, costCoverage: row.events === 0 ? 0 : row.costed / row.events });
  }
  return rows.sort((a, b) => eventTokens(b) - eventTokens(a) || b.cost - a.cost);
}

export async function queryModels(
  db: SQLiteDatabase,
  days: UsageWindowDays,
  environmentId: string | null,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, usageWindowStart(days), Date.now() + DAY_MS, environmentId);
  if (signal?.aborted) throw new Error("Query cancelled");
  return runCooperatively(
    breakdownWork(events, (e) => ({
      key: e.modelId,
      title: e.modelId,
      subtitle: null,
    })),
    signal,
  );
}

export async function queryClients(
  db: SQLiteDatabase,
  days: UsageWindowDays,
  environmentId: string | null,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, usageWindowStart(days), Date.now() + DAY_MS, environmentId);
  if (signal?.aborted) throw new Error("Query cancelled");
  return runCooperatively(
    breakdownWork(events, (e) => ({ key: e.client, title: e.client, subtitle: null })),
    signal,
  );
}

export async function queryWorkspaces(
  db: SQLiteDatabase,
  days: UsageWindowDays,
  environmentId: string | null,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, usageWindowStart(days), Date.now() + DAY_MS, environmentId);
  if (signal?.aborted) throw new Error("Query cancelled");
  return runCooperatively(
    breakdownWork(events, (e) => ({
      key: e.workspaceLabel ?? "(no workspace)",
      title: e.workspaceLabel ?? "(no workspace)",
      subtitle: null,
    })),
    signal,
  );
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

export async function querySessions(
  db: SQLiteDatabase,
  days: UsageWindowDays,
  environmentId: string | null,
  limit = 60,
  signal?: AbortSignal,
): Promise<SessionRow[]> {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEventsUncached(
    db,
    usageWindowStart(days),
    Date.now() + DAY_MS,
    environmentId,
    Math.max(0, Math.floor(limit)),
  );
  if (signal?.aborted) throw new Error("Query cancelled");
  const bySession = new Map<string, SessionRow>();
  const yieldIfNeeded = createYieldBudget(signal);
  for (let i = 0; i < events.length; i++) {
    if (i % 256 === 0) {
      const pause = yieldIfNeeded();
      if (pause) await pause;
    }
    if (signal?.aborted) throw new Error("Query cancelled");
    const e = events[i]!;
    const key = sessionKey(e);
    let row = bySession.get(key);
    if (!row) {
      row = {
        key,
        environmentId: e.environmentId,
        sessionId: e.sessionId,
        title: null,
        lastActivityMs: e.occurredAtMs,
        client: e.client,
        models: [],
        tokens: 0,
        cost: 0,
        messages: 0,
      };
      bySession.set(key, row);
    }
    row.title ??= e.sessionTitle;
    row.lastActivityMs = e.occurredAtMs;
    if (!row.models.includes(e.modelId)) row.models.push(e.modelId);
    row.tokens += eventTokens(e);
    row.cost += e.cost;
    row.messages += e.messageCount;
  }
  return [...bySession.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
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
  /** Null when no model price reference exists (cloud pricing payload pending). */
  cacheSavings: number | null;
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
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, usageWindowStart(days, now), now + DAY_MS, null);
  if (signal?.aborted) throw new Error("Query cancelled");
  const totals = await runCooperatively(summarizeEventsWork(events), signal);
  const sessionKeys = new Set<string>();
  const series = await runCooperatively(buildSeriesWork(events, timeZone, granularity, "none"), signal);

  const byClientMap = new Map<string, { tokens: number; cost: number; sessions: Set<string> }>();
  const yieldIfNeeded = createYieldBudget(signal);
  for (let i = 0; i < events.length; i++) {
    if (i % 256 === 0) {
      const pause = yieldIfNeeded();
      if (pause) await pause;
    }
    if (signal?.aborted) throw new Error("Query cancelled");
    const e = events[i]!;
    sessionKeys.add(sessionKey(e));
    const entry = byClientMap.get(e.client) ?? {
      tokens: 0,
      cost: 0,
      sessions: new Set<string>(),
    };
    entry.tokens += eventTokens(e);
    entry.cost += e.cost;
    entry.sessions.add(sessionKey(e));
    byClientMap.set(e.client, entry);
  }
  const byClient: ClientShare[] = [...byClientMap.entries()]
    .map(([key, value]) => ({ key, tokens: value.tokens, cost: value.cost, sessions: value.sessions.size }))
    .sort((a, b) => (metric === "cost" ? b.cost - a.cost : b.tokens - a.tokens));

  const priceRows = await db.getAllAsync<{
    model_id: string;
    input_cost_per_m: number;
    cache_read_cost_per_m: number;
  }>("select model_id, input_cost_per_m, cache_read_cost_per_m from model_prices");
  const prices: Record<string, { input: number; cacheRead: number }> = {};
  for (const row of priceRows) {
    prices[row.model_id] = { input: row.input_cost_per_m, cacheRead: row.cache_read_cost_per_m };
  }
  const cacheSavings = priceRows.length === 0 ? null : computeCacheSavings(events, prices);

  return { totals, sessions: sessionKeys.size, series, byClient, cacheSavings };
}

export async function queryQuotas(db: SQLiteDatabase): Promise<QuotaCard[]> {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "select provider, account_key, account_label, plan, metric, used_percent, remaining_percent, remaining_label, resets_at, fetched_at from quota_snapshots where status = 'ok' order by provider, metric, fetched_at desc",
  );
  const seen = new Set<string>();
  const cards: QuotaCard[] = [];
  for (const r of rows) {
    const provider = String(r["provider"]);
    const metric = String(r["metric"]);
    const dedupKey = JSON.stringify([provider, String(r["account_key"]), metric]);
    if (seen.has(dedupKey)) continue; // freshest row wins (server pre-selects; demo rows may tie)
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
            e.last_heartbeat_at, e.last_success_at, e.last_error, e.latest_revision,
            case when d.id is null then null else exists(
              select 1 from kv where key = 'direct_since_v2_' || e.id
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
    latestRevision: Number(r["latest_revision"] ?? 0),
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
  return environments.map((environment) => ({
    ...environment,
    metrics: byEnvironment.get(environment.id) ?? [],
  }));
}
