/**
 * Read layer: pure db → view-model functions. All screens render from these;
 * TanStack Query just wraps them. Aggregation happens in JS because buckets
 * are computed in the reporting timezone (D8) — at demo scale this is instant;
 * server-side/SQLite rollups are the post-profiling optimization.
 */
import type { SQLiteDatabase } from "expo-sqlite";
import { bucketKey, bucketLabel, type Granularity } from "../lib/format";

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

async function loadEvents(
  db: SQLiteDatabase,
  fromMs: number,
  toMs: number,
  environmentId: string | null,
): Promise<EventRow[]> {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `select event_id, environment_id, client, provider_id, model_id, session_id, session_title,
            workspace_label, occurred_at_ms, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, reasoning_tokens, message_count, duration_ms, cost, cost_source,
            cost_is_complete
       from usage_events
      where occurred_at_ms >= ? and occurred_at_ms < ? ${environmentId !== null ? "and environment_id = ?" : ""}
      order by occurred_at_ms asc`,
    environmentId !== null ? [fromMs, toMs, environmentId] : [fromMs, toMs],
  );
  return rows.map((r) => ({
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
  }));
}

function summarizeEvents(events: EventRow[]): Totals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let messages = 0;
  let cost = 0;
  let costed = 0;
  for (const e of events) {
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

export function buildSeries(
  events: EventRow[],
  timeZone: string,
  granularity: Granularity,
  groupBy: "model" | "client" | "none",
): SeriesBucket[] {
  const byKey = new Map<string, SeriesBucket>();
  for (const e of events) {
    const key = bucketKey(e.occurredAtMs, timeZone, granularity);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = { key, label: bucketLabel(key, granularity), tokens: 0, cost: 0, stacks: {}, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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

/**
 * Largest bucket total across ALL history at this granularity (user direction:
 * the Y axis stays pinned to the historical peak so every window compares
 * against the same ceiling — only X moves).
 */
export async function queryGranularityMax(
  db: SQLiteDatabase,
  timeZone: string,
  granularity: Granularity,
): Promise<number> {
  const events = await loadEvents(db, 0, Date.now() + DAY_MS, null);
  const perBucket = new Map<string, number>();
  for (const e of events) {
    const key = bucketKey(e.occurredAtMs, timeZone, granularity);
    const tokens =
      e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens + e.reasoningTokens;
    perBucket.set(key, (perBucket.get(key) ?? 0) + tokens);
  }
  return Math.max(0, ...perBucket.values());
}

/** Local mirror deletion for machine removal (server row is deleted separately). */
export async function removeEnvironmentLocal(db: SQLiteDatabase, environmentId: string): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync("delete from usage_events where environment_id = ?", [environmentId]);
    await db.runAsync("delete from quota_snapshots where environment_id = ?", [environmentId]);
    await db.runAsync("delete from environments where id = ?", [environmentId]);
  });
}

export interface DailyTotals {
  /** Day key (reporting-tz "YYYY-MM-DD") → tokens/cost. Missing key = no usage. */
  byKey: Record<string, { tokens: number; cost: number }>;
  max: number;
}

/** Per-day totals over the trailing `days` window — the contribution grid's feed. */
export async function queryDailyTotals(
  db: SQLiteDatabase,
  timeZone: string,
  days: number,
): Promise<DailyTotals> {
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, null);
  const byKey: Record<string, { tokens: number; cost: number }> = {};
  let max = 0;
  for (const e of events) {
    const key = bucketKey(e.occurredAtMs, timeZone, "daily");
    const entry = byKey[key] ?? { tokens: 0, cost: 0 };
    entry.tokens +=
      e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens + e.reasoningTokens;
    entry.cost += e.cost;
    byKey[key] = entry;
    if (entry.tokens > max) max = entry.tokens;
  }
  return { byKey, max };
}

export interface RecordStats {
  biggestDay: { key: string; tokens: number; cost: number } | null;
  longestStreak: number;
  currentStreak: number;
  topSession: { sessionId: string; title: string | null; client: string; cost: number; tokens: number } | null;
}

/** All-time records: biggest day, longest + current streak, priciest session. */
export async function queryRecords(db: SQLiteDatabase, timeZone: string): Promise<RecordStats> {
  const events = await loadEvents(db, 0, Date.now() + DAY_MS, null);
  const perDay = new Map<string, { tokens: number; cost: number }>();
  const perSession = new Map<string, { title: string | null; cost: number; tokens: number; client: string }>();
  for (const e of events) {
    const key = bucketKey(e.occurredAtMs, timeZone, "daily");
    const day = perDay.get(key) ?? { tokens: 0, cost: 0 };
    day.tokens +=
      e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens + e.reasoningTokens;
    day.cost += e.cost;
    perDay.set(key, day);

    const session =
      perSession.get(e.sessionId) ??
      { title: e.sessionTitle, cost: 0, tokens: 0, client: e.client };
    session.cost += e.cost;
    session.tokens +=
      e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens + e.reasoningTokens;
    if (session.title === null && e.sessionTitle !== null) session.title = e.sessionTitle;
    perSession.set(e.sessionId, session);
  }

  let biggestDay: RecordStats["biggestDay"] = null;
  for (const [key, day] of perDay) {
    if (biggestDay === null || day.tokens > biggestDay.tokens) {
      biggestDay = { key, tokens: day.tokens, cost: day.cost };
    }
  }

  // Streaks walk real calendar ordinals so gaps break them correctly.
  const activeOrdinals = new Set(
    [...perDay.keys()].map((key) => Math.floor(Date.parse(`${key}T12:00:00Z`) / DAY_MS)),
  );
  let longestStreak = 0;
  let run = 0;
  let cursor = Math.floor(Date.parse("2000-01-01T12:00:00Z") / DAY_MS);
  const lastOrdinal = Math.floor(Date.now() / DAY_MS);
  let currentStreak = 0;
  for (let ordinal = cursor; ordinal <= lastOrdinal; ordinal++) {
    if (activeOrdinals.has(ordinal)) {
      run += 1;
      if (run > longestStreak) longestStreak = run;
    } else {
      run = 0;
    }
  }
  // Current streak counts back from today; an inactive today doesn't break it
  // until tomorrow (GitHub convention).
  cursor = lastOrdinal;
  if (!activeOrdinals.has(cursor)) cursor -= 1;
  while (activeOrdinals.has(cursor)) {
    currentStreak += 1;
    cursor -= 1;
  }

  let topSession: RecordStats["topSession"] = null;
  for (const [sessionId, session] of perSession) {
    if (topSession === null || session.cost > topSession.cost) {
      topSession = {
        sessionId,
        title: session.title,
        client: session.client,
        cost: session.cost,
        tokens: session.tokens,
      };
    }
  }

  return { biggestDay, longestStreak, currentStreak, topSession };
}

export interface BreakdownRow extends Totals {
  key: string;
  title: string;
  subtitle: string | null;
}

function breakdownFrom(
  events: EventRow[],
  keyFn: (e: EventRow) => { key: string; title: string; subtitle: string | null },
): BreakdownRow[] {
  const groups = new Map<string, EventRow[]>();
  for (const e of events) {
    const { key } = keyFn(e);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [e]);
    else list.push(e);
  }
  const rows: BreakdownRow[] = [];
  for (const [key, list] of groups) {
    const meta = keyFn(list[0]!);
    rows.push({ key, title: meta.title, subtitle: meta.subtitle, ...summarizeEvents(list) });
  }
  return rows.sort((a, b) => b.cost - a.cost || b.outputTokens - a.outputTokens);
}

export async function queryDashboard(
  db: SQLiteDatabase,
  timeZone: string,
  environmentId: string | null,
): Promise<{
  today: Totals;
  week: Totals;
  series: SeriesBucket[];
  hitRateYesterday: number | null;
}> {
  const now = Date.now();
  const events48h = await loadEvents(db, now - 2 * DAY_MS, now + DAY_MS, environmentId);
  const todayKey = bucketKey(now, timeZone, "daily");
  const todayEvents = events48h.filter((e) => bucketKey(e.occurredAtMs, timeZone, "daily") === todayKey);
  const yesterdayEvents = events48h.filter((e) => {
    const key = bucketKey(e.occurredAtMs, timeZone, "daily");
    return key !== todayKey && key === bucketKey(now - DAY_MS, timeZone, "daily");
  });
  const events7d = await loadEvents(db, now - 7 * DAY_MS, now + DAY_MS, environmentId);
  return {
    today: summarizeEvents(todayEvents),
    week: summarizeEvents(events7d),
    series: buildSeries(events7d, timeZone, "daily", "none"),
    hitRateYesterday:
      yesterdayEvents.length === 0 ? null : summarizeEvents(yesterdayEvents).hitRate,
  };
}

export async function queryHistory(
  db: SQLiteDatabase,
  timeZone: string,
  granularity: Granularity,
  groupBy: "model" | "client" | "none",
  days: number,
  environmentId: string | null,
): Promise<{ series: SeriesBucket[]; totals: Totals }> {
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, environmentId);
  return { series: buildSeries(events, timeZone, granularity, groupBy), totals: summarizeEvents(events) };
}

export async function queryModels(db: SQLiteDatabase, days: number, environmentId: string | null) {
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, environmentId);
  return breakdownFrom(events, (e) => ({ key: `${e.providerId}/${e.modelId}`, title: e.modelId, subtitle: e.providerId }));
}

export async function queryClients(db: SQLiteDatabase, days: number, environmentId: string | null) {
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, environmentId);
  return breakdownFrom(events, (e) => ({ key: e.client, title: e.client, subtitle: null }));
}

export async function queryWorkspaces(db: SQLiteDatabase, days: number, environmentId: string | null) {
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, environmentId);
  return breakdownFrom(events, (e) => ({
    key: e.workspaceLabel ?? "(no workspace)",
    title: e.workspaceLabel ?? "(no workspace)",
    subtitle: null,
  }));
}

export interface SessionRow {
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
): Promise<SessionRow[]> {
  const events = await loadEvents(db, Date.now() - days * DAY_MS, Date.now() + DAY_MS, environmentId);
  const bySession = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = bySession.get(e.sessionId);
    if (list === undefined) bySession.set(e.sessionId, [e]);
    else list.push(e);
  }
  const rows: SessionRow[] = [];
  for (const [sessionId, list] of bySession) {
    const first = list[0]!;
    const last = list[list.length - 1]!;
    rows.push({
      sessionId,
      title: list.find((e) => e.sessionTitle !== null)?.sessionTitle ?? null,
      lastActivityMs: last.occurredAtMs,
      client: first.client,
      models: [...new Set(list.map((e) => e.modelId))],
      tokens: list.reduce(
        (sum, e) => sum + e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens + e.reasoningTokens,
        0,
      ),
      cost: list.reduce((sum, e) => sum + e.cost, 0),
      messages: list.reduce((sum, e) => sum + e.messageCount, 0),
    });
  }
  return rows.sort((a, b) => b.lastActivityMs - a.lastActivityMs).slice(0, limit);
}

export interface QuotaCard {
  provider: string;
  accountLabel: string | null;
  plan: string | null;
  metric: string;
  usedPercent: number | null;
  remainingLabel: string | null;
  resetsAt: string | null;
  fetchedAt: string;
}

export async function queryQuotas(db: SQLiteDatabase): Promise<QuotaCard[]> {
  const rows = await db.getAllAsync<Record<string, unknown>>(
    "select provider, account_label, plan, metric, used_percent, remaining_label, resets_at, fetched_at from quota_snapshots where status = 'ok' order by provider, metric, fetched_at desc",
  );
  const seen = new Set<string>();
  const cards: QuotaCard[] = [];
  for (const r of rows) {
    const provider = String(r["provider"]);
    const metric = String(r["metric"]);
    const dedupKey = `${provider}|${String(r["account_label"] ?? "")}|${metric}`;
    if (seen.has(dedupKey)) continue; // freshest row wins (server pre-selects; demo rows may tie)
    seen.add(dedupKey);
    cards.push({
      provider,
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
