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

export interface DailyTotals {
  /** Day key (reporting-tz "YYYY-MM-DD") → tokens/cost. Missing key = no usage. */
  byKey: Record<string, { tokens: number; cost: number }>;
  max: number;
}

/** Per-day totals over the given events — the contribution grid's feed. */
export function computeDailyTotals(events: EventRow[], timeZone: string): DailyTotals {
  const byKey: Record<string, { tokens: number; cost: number }> = {};
  let max = 0;
  for (const [key, agg] of bucketEvents(events, timeZone, "daily")) {
    byKey[key] = { tokens: agg.tokens, cost: agg.cost };
    if (agg.tokens > max) max = agg.tokens;
  }
  return { byKey, max };
}

export interface RecordStats {
  biggestDay: { key: string; tokens: number; cost: number } | null;
  longestStreak: number;
  currentStreak: number;
  topSession: {
    sessionId: string;
    title: string | null;
    client: string;
    cost: number;
    tokens: number;
  } | null;
}

/** Streaks walk real calendar ordinals so gaps break them correctly. */
function computeStreaks(
  activeOrdinals: Set<number>,
  now: number,
): { longestStreak: number; currentStreak: number } {
  // Walk the active days themselves — not every calendar day since the epoch —
  // so cost scales with history, not with years since 2000.
  let longestStreak = 0;
  let run = 0;
  let previous = -Infinity;
  for (const ordinal of [...activeOrdinals].sort((a, b) => a - b)) {
    run = ordinal === previous + 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    previous = ordinal;
  }
  // Current streak counts back from today; an inactive today doesn't break it
  // until tomorrow (GitHub convention).
  let currentStreak = 0;
  const lastOrdinal = Math.floor(now / DAY_MS);
  let cursor = activeOrdinals.has(lastOrdinal) ? lastOrdinal : lastOrdinal - 1;
  while (activeOrdinals.has(cursor)) {
    currentStreak += 1;
    cursor -= 1;
  }
  return { longestStreak, currentStreak };
}

/** All-time records: biggest day, longest + current streak, priciest session. */
export function computeRecords(events: EventRow[], timeZone: string, now = Date.now()): RecordStats {
  return runImmediately(computeRecordsWork(events, timeZone, now));
}

function* computeRecordsWork(
  events: EventRow[],
  timeZone: string,
  now = Date.now(),
): Generator<void, RecordStats> {
  let processed = 0;
  const perDay = yield* bucketEventsWork(events, timeZone, "daily");
  const perSession = new Map<
    string,
    { sessionId: string; title: string | null; client: string; cost: number; tokens: number }
  >();
  for (const e of events) {
    if (++processed % 256 === 0) yield;
    const session = perSession.get(sessionKey(e)) ?? {
      sessionId: e.sessionId,
      title: e.sessionTitle,
      client: e.client,
      cost: 0,
      tokens: 0,
    };
    session.cost += e.cost;
    session.tokens += eventTokens(e);
    if (session.title === null && e.sessionTitle !== null) session.title = e.sessionTitle;
    perSession.set(sessionKey(e), session);
  }

  let biggestDay: RecordStats["biggestDay"] = null;
  for (const [key, agg] of perDay) {
    if (biggestDay === null || agg.tokens > biggestDay.tokens) {
      biggestDay = { key, tokens: agg.tokens, cost: agg.cost };
    }
  }

  const activeOrdinals = new Set(
    [...perDay.keys()].map((key) => Math.floor(Date.parse(`${key}T12:00:00Z`) / DAY_MS)),
  );
  const { longestStreak, currentStreak } = computeStreaks(activeOrdinals, now);

  let topSession: RecordStats["topSession"] = null;
  for (const session of perSession.values()) {
    if (topSession === null || session.cost > topSession.cost) {
      topSession = {
        sessionId: session.sessionId,
        title: session.title,
        client: session.client,
        cost: session.cost,
        tokens: session.tokens,
      };
    }
  }

  return { biggestDay, longestStreak, currentStreak, topSession };
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

/** Cumulative per-layer series for stacked area charts (bottom-up by stack key). */
export function buildStackLayers(
  buckets: SeriesBucket[],
  stackKeys: string[],
): { key: string; values: number[] }[] {
  const running = buckets.map(() => 0);
  return stackKeys.map((key) => {
    const values = buckets.map((bucket, i) => {
      running[i] = running[i]! + (bucket.stacks[key] ?? 0);
      return running[i]!;
    });
    return { key, values };
  });
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
      await db.runAsync("delete from environments where id = ?", [environmentId]);
    });
    // Post-commit eviction: a read racing the delete can cache pre-delete rows,
    // so the cache must be cleared only after the writes are durable.
    invalidateEventCache(db);
  });
}

/** Per-day totals over the trailing `days` window — the contribution grid's feed. */
export async function queryDailyTotals(
  db: SQLiteDatabase,
  timeZone: string,
  days: number,
  signal?: AbortSignal,
): Promise<DailyTotals> {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, null);
  if (signal?.aborted) throw new Error("Query cancelled");
  const buckets = await cachedBuckets(events, timeZone, "daily");
  const byKey = Object.fromEntries([...buckets].map(([key, b]) => [key, { tokens: b.tokens, cost: b.cost }]));
  return { byKey, max: Math.max(0, ...[...buckets.values()].map((b) => b.tokens)) };
}

/** All-time records: biggest day, longest + current streak, priciest session. */
export async function queryRecords(
  db: SQLiteDatabase,
  timeZone: string,
  signal?: AbortSignal,
): Promise<RecordStats> {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, 0, Date.now() + DAY_MS, null);
  if (signal?.aborted) throw new Error("Query cancelled");
  return runCooperatively(computeRecordsWork(events, timeZone), signal);
}

export interface BreakdownRow extends Totals {
  key: string;
  title: string;
  subtitle: string | null;
}

function* breakdownWork(
  events: EventRow[],
  keyFn: (e: EventRow) => { key: string; title: string; subtitle: string | null },
): Generator<void, BreakdownRow[]> {
  let processed = 0;
  const groups = new Map<string, EventRow[]>();
  for (const e of events) {
    if (++processed % 256 === 0) yield;
    const { key } = keyFn(e);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [e]);
    else list.push(e);
  }
  const rows: BreakdownRow[] = [];
  for (const [key, list] of groups) {
    yield;
    const meta = keyFn(list[0]!);
    rows.push({ key, title: meta.title, subtitle: meta.subtitle, ...(yield* summarizeEventsWork(list)) });
  }
  return rows.sort((a, b) => b.cost - a.cost || b.outputTokens - a.outputTokens);
}

export async function queryHistory(
  db: SQLiteDatabase,
  timeZone: string,
  granularity: Granularity,
  groupBy: "model" | "client" | "none",
  days: number,
  environmentId: string | null,
  signal?: AbortSignal,
): Promise<{ series: SeriesBucket[]; totals: Totals }> {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, environmentId);
  if (signal?.aborted) throw new Error("Query cancelled");
  return {
    series: await runCooperatively(buildSeriesWork(events, timeZone, granularity, groupBy), signal),
    totals: await runCooperatively(summarizeEventsWork(events), signal),
  };
}

export async function queryModels(
  db: SQLiteDatabase,
  days: number,
  environmentId: string | null,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, environmentId);
  if (signal?.aborted) throw new Error("Query cancelled");
  return runCooperatively(
    breakdownWork(events, (e) => ({
      key: `${e.providerId}/${e.modelId}`,
      title: e.modelId,
      subtitle: e.providerId,
    })),
    signal,
  );
}

export async function queryClients(
  db: SQLiteDatabase,
  days: number,
  environmentId: string | null,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, environmentId);
  if (signal?.aborted) throw new Error("Query cancelled");
  return runCooperatively(
    breakdownWork(events, (e) => ({ key: e.client, title: e.client, subtitle: null })),
    signal,
  );
}

export async function queryWorkspaces(
  db: SQLiteDatabase,
  days: number,
  environmentId: string | null,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, environmentId);
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
  days: number,
  environmentId: string | null,
  limit = 60,
  signal?: AbortSignal,
): Promise<SessionRow[]> {
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEventsUncached(
    db,
    Date.now() - days * DAY_MS,
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
  days: number,
  metric: "cost" | "tokens",
  signal?: AbortSignal,
): Promise<WindowOverview> {
  const now = Date.now();
  if (signal?.aborted) throw new Error("Query cancelled");
  const events = await loadEvents(db, now - days * DAY_MS, now + DAY_MS, null);
  if (signal?.aborted) throw new Error("Query cancelled");
  const totals = await runCooperatively(summarizeEventsWork(events), signal);
  const sessionKeys = new Set<string>();
  const series = await runCooperatively(buildSeriesWork(events, timeZone, "daily", "none"), signal);

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
    "select provider, account_key, account_label, plan, metric, used_percent, remaining_label, resets_at, fetched_at from quota_snapshots where status = 'ok' order by provider, metric, fetched_at desc",
  );
  const seen = new Set<string>();
  const cards: QuotaCard[] = [];
  for (const r of rows) {
    const provider = String(r["provider"]);
    const metric = String(r["metric"]);
    const dedupKey = JSON.stringify([provider, String(r["account_key"]), metric]);
    if (seen.has(dedupKey)) continue; // freshest row wins (server pre-selects; demo rows may tie)
    seen.add(dedupKey);
    cards.push({
      provider,
      accountKey: String(r["account_key"]),
      accountLabel: (r["account_label"] as string | null) ?? null,
      plan: (r["plan"] as string | null) ?? null,
      metric,
      usedPercent: r["used_percent"] === null ? null : Number(r["used_percent"]),
      remainingLabel: (r["remaining_label"] as string | null) ?? null,
      resetsAt: (r["resets_at"] as string | null) ?? null,
      fetchedAt: String(r["fetched_at"]),
    });
  }
  return cards;
}

export async function queryEnvironments(db: SQLiteDatabase): Promise<EnvironmentRow[]> {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `select id, slug, display_name, host_group, os_kind, tokscale_version, reporter_version,
            last_heartbeat_at, last_success_at, last_error, latest_revision
       from environments order by slug`,
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
  }));
}
