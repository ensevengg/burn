/** The SQL-side aggregates must equal aggregating every event in JS. */
import { expect, test } from "bun:test";
import type { MachineEventInput } from "@burn/sync-api";
import {
  bucketEvents, buildSeries, eventTokens, invalidateEventCache, queryClients, queryGranularityMax,
  queryModels, querySessions, queryWindowOverview, queryWorkspaces, sessionKey, type EventRow,
} from "../src/data/repository";
import { mergePeerEvents } from "../src/lib/mirror-writes";
import { mirrorFixture } from "./mirror-fixture";

/** Deterministic spread over two DST changes, with awkward identifiers. */
function history(count: number): MachineEventInput[] {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const models = ["gpt-5.2", "claude-opus,4", "glm-4.7", "x|y"];
  const clients = ["codex", "claude", "open,code"];
  const workspaces = [null, "burn", "a, b", "dotfiles"];
  const start = Date.parse("2026-02-20T00:00:00Z");
  const span = Date.parse("2026-11-10T00:00:00Z") - start;
  return Array.from({ length: count }, (_, i) => {
    const model = models[Math.floor(rand() * models.length)]!;
    return {
      client: clients[Math.floor(rand() * clients.length)]!,
      providerId: rand() < 0.5 ? "openai" : "anthropic",
      modelId: model,
      sessionId: `s${Math.floor(rand() * 40)}`,
      sessionTitle: null,
      workspaceKey: null,
      workspaceLabel: workspaces[Math.floor(rand() * workspaces.length)]!,
      agent: null,
      occurredAtMs: start + Math.floor(rand() * span),
      sourceOffsetMinutes: 330,
      sourceTimezone: "Asia/Kolkata",
      sourceLocalDate: "2026-01-01",
      inputTokens: Math.floor(rand() * 5000),
      outputTokens: Math.floor(rand() * 900),
      cacheReadTokens: Math.floor(rand() * 40_000),
      cacheWriteTokens: Math.floor(rand() * 3000),
      reasoningTokens: rand() < 0.3 ? Math.floor(rand() * 500) : 0,
      messageCount: 1 + Math.floor(rand() * 3),
      isTurnStart: false,
      durationMs: null,
      cost: (rand() * 0.4).toFixed(6),
      costSource: "estimated",
      costIsComplete: rand() < 0.9,
      modelAttributionConflicted: false,
      parserVersion: "tokscale-4.21.0",
      dedupKey: `k${i}`,
    } satisfies MachineEventInput;
  });
}

async function seeded() {
  const fx = mirrorFixture();
  const events = history(4000);
  for (const [environmentId, slug] of [["direct-a", "a"], ["direct-b", "b"]] as const)
    await mergePeerEvents(fx.db, environmentId, slug, events, () => {});
  const rows: EventRow[] = (fx.native.query("select * from usage_events").all() as Record<string, unknown>[]).map((r) => ({
    eventId: String(r["event_id"]), environmentId: String(r["environment_id"]), client: String(r["client"]),
    providerId: String(r["provider_id"]), modelId: String(r["model_id"]), sessionId: String(r["session_id"]),
    sessionTitle: null, workspaceLabel: (r["workspace_label"] as string | null) ?? null,
    occurredAtMs: Number(r["occurred_at_ms"]), inputTokens: Number(r["input_tokens"]),
    outputTokens: Number(r["output_tokens"]), cacheReadTokens: Number(r["cache_read_tokens"]),
    cacheWriteTokens: Number(r["cache_write_tokens"]), reasoningTokens: Number(r["reasoning_tokens"]),
    messageCount: Number(r["message_count"]), durationMs: null, cost: Number(r["cost"]),
    costSource: "estimated", costIsComplete: Number(r["cost_is_complete"]) === 1,
  }));
  return { fx, rows };
}

test("Explore's grouped queries match a per-event aggregation", async () => {
  const { fx, rows } = await seeded();
  const cases = [
    [queryModels, (e: EventRow) => e.modelId],
    [queryClients, (e: EventRow) => e.client],
    [queryWorkspaces, (e: EventRow) => e.workspaceLabel ?? "(no workspace)"],
  ] as const;
  for (const environmentId of [null, "direct-b"]) {
    const scoped = rows.filter((e) => environmentId === null || e.environmentId === environmentId);
    for (const [query, keyOf] of cases) {
      const actual = await query(fx.db, null, environmentId);
      const keys = [...new Set(scoped.map(keyOf))];
      expect(actual.map((row) => row.key).sort()).toEqual(keys.sort());
      for (const row of actual) {
        const own = scoped.filter((e) => keyOf(e) === row.key);
        expect(eventTokens(row)).toBe(own.reduce((sum, e) => sum + eventTokens(e), 0));
        expect(row.inputTokens).toBe(own.reduce((sum, e) => sum + e.inputTokens, 0));
        expect(row.messages).toBe(own.reduce((sum, e) => sum + e.messageCount, 0));
        expect(row.cost).toBeCloseTo(own.reduce((sum, e) => sum + e.cost, 0), 6);
        expect(row.sessions).toBe(new Set(own.map(sessionKey)).size);
        expect(row.providers).toEqual([...new Set(own.map((e) => e.providerId))].sort());
        expect(row.clients).toEqual([...new Set(own.map((e) => e.client))].sort());
        expect(row.costCoverage).toBeCloseTo(own.filter((e) => e.costIsComplete).length / own.length, 12);
        const cache = own.reduce((sum, e) => sum + e.cacheReadTokens + e.inputTokens + e.cacheWriteTokens, 0);
        expect(row.hitRate).toBeCloseTo(own.reduce((sum, e) => sum + e.cacheReadTokens, 0) / cache, 12);
      }
      // Ranked by tokens, as before.
      expect(actual.map(eventTokens)).toEqual([...actual.map(eventTokens)].sort((a, b) => b - a));
    }
  }
  // A window bound and an empty window behave.
  expect(await queryModels(fx.db, 1, null)).toEqual([]);
  // One row per group reaches JS, not one per event.
  const before = fx.readRows;
  await queryModels(fx.db, null, null);
  expect(fx.readRows - before).toBeLessThan(40);
});

test("the historical peak from 15-minute slots equals bucketing every event, in any zone", async () => {
  const { fx, rows } = await seeded();
  for (const zone of ["Asia/Kolkata", "America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Chatham", "UTC"]) {
    for (const granularity of ["hourly", "daily", "monthly", "yearly"] as const) {
      const expected = bucketEvents(rows, zone, granularity);
      const tokens = Math.max(...[...expected.values()].map((b) => b.tokens));
      const cost = Math.max(...[...expected.values()].map((b) => b.cost));
      expect(await queryGranularityMax(fx.db, zone, granularity, "tokens")).toBe(tokens);
      expect(await queryGranularityMax(fx.db, zone, granularity, "cost")).toBeCloseTo(cost, 6);
    }
  }
  const empty = mirrorFixture();
  expect(await queryGranularityMax(empty.db, "UTC", "daily", "cost")).toBe(0);
});

test("the SQL-side overview equals aggregating every event, in any zone", async () => {
  const { fx, rows } = await seeded();
  for (const zone of ["Asia/Kolkata", "America/New_York", "Asia/Kathmandu", "Pacific/Chatham"]) {
    for (const granularity of ["hourly", "daily", "monthly"] as const) {
      const overview = await queryWindowOverview(fx.db, zone, null, "tokens", granularity);
      const expected = buildSeries(rows, zone, granularity, "none");
      expect(overview.series.map((b) => [b.key, b.label, b.tokens, b.inputTokens, b.cacheReadTokens, b.cacheWriteTokens]))
        .toEqual(expected.map((b) => [b.key, b.label, b.tokens, b.inputTokens, b.cacheReadTokens, b.cacheWriteTokens]));
      overview.series.forEach((b, i) => {
        expect(b.cost).toBeCloseTo(expected[i]!.cost, 6);
        expect(b.stacks).toEqual(expected[i]!.stacks);
      });
    }
  }
  const { totals, sessions, byClient, cacheSavings } = await queryWindowOverview(fx.db, "UTC", null, "cost");
  expect(eventTokens(totals)).toBe(rows.reduce((sum, e) => sum + eventTokens(e), 0));
  expect(totals.messages).toBe(rows.reduce((sum, e) => sum + e.messageCount, 0));
  expect(totals.cost).toBeCloseTo(rows.reduce((sum, e) => sum + e.cost, 0), 6);
  expect(totals.costCoverage).toBeCloseTo(rows.filter((e) => e.costIsComplete).length / rows.length, 12);
  expect(sessions).toBe(new Set(rows.map(sessionKey)).size);
  expect(cacheSavings).toBeNull();
  for (const share of byClient) {
    const own = rows.filter((e) => e.client === share.key);
    expect(share.tokens).toBe(own.reduce((sum, e) => sum + eventTokens(e), 0));
    expect(share.sessions).toBe(new Set(own.map(sessionKey)).size);
  }
  expect(byClient.map((c) => c.cost)).toEqual([...byClient.map((c) => c.cost)].sort((a, b) => b - a));

  // Savings use per-model cache reads.
  fx.native.exec("insert into model_prices (model_id, input_cost_per_m, cache_read_cost_per_m) values ('glm-4.7', 1, 0.25)");
  invalidateEventCache(fx.db);
  const priced = await queryWindowOverview(fx.db, "UTC", null, "cost");
  const reads = rows.filter((e) => e.modelId === "glm-4.7").reduce((sum, e) => sum + e.cacheReadTokens, 0);
  expect(priced.cacheSavings).toBeCloseTo((reads / 1e6) * 0.75, 9);

  // Far fewer rows than events reach JS, and a second metric reuses the window.
  invalidateEventCache(fx.db);
  const before = fx.readRows;
  await queryWindowOverview(fx.db, "UTC", null, "tokens", "daily");
  const read = fx.readRows - before;
  expect(read).toBeLessThan(rows.length / 2);
  await queryWindowOverview(fx.db, "Asia/Kolkata", null, "cost", "monthly");
  expect(fx.readRows - before).toBe(read);
});

test("SQL-grouped sessions match grouping every event", async () => {
  const { fx, rows } = await seeded();
  fx.native.exec("update usage_events set session_title = 'T ' || session_id where rowid % 7 = 0");
  const titled = (fx.native.query("select * from usage_events").all() as Record<string, unknown>[]);
  const titles = new Map<string, { at: number; title: string }>();
  for (const r of titled) {
    if (r["session_title"] === null) continue;
    const key = sessionKey({ environmentId: String(r["environment_id"]), client: String(r["client"]), sessionId: String(r["session_id"]) });
    const at = Number(r["occurred_at_ms"]);
    if (!titles.has(key) || titles.get(key)!.at > at) titles.set(key, { at, title: String(r["session_title"]) });
  }
  for (const environmentId of [null, "direct-a"]) {
    const scoped = rows.filter((e) => environmentId === null || e.environmentId === environmentId);
    const actual = await querySessions(fx.db, null, environmentId, 25);
    const grouped = new Map<string, EventRow[]>();
    for (const e of scoped) grouped.set(sessionKey(e), [...(grouped.get(sessionKey(e)) ?? []), e]);
    const expected = [...grouped.entries()]
      .map(([key, own]) => ({ key, last: Math.max(...own.map((e) => e.occurredAtMs)), own }))
      .sort((a, b) => b.last - a.last)
      .slice(0, 25);
    expect(actual.map((row) => row.key)).toEqual(expected.map((row) => row.key));
    for (const [i, row] of actual.entries()) {
      const { own, last } = expected[i]!;
      const ordered = [...own].sort((a, b) => a.occurredAtMs - b.occurredAtMs);
      expect(row.lastActivityMs).toBe(last);
      expect(row.tokens).toBe(own.reduce((sum, e) => sum + eventTokens(e), 0));
      expect(row.messages).toBe(own.reduce((sum, e) => sum + e.messageCount, 0));
      expect(row.cost).toBeCloseTo(own.reduce((sum, e) => sum + e.cost, 0), 6);
      expect(row.models).toEqual([...new Set(ordered.map((e) => e.modelId))]);
      expect(row.title).toBe(titles.get(row.key)?.title ?? null);
    }
  }
  expect(await querySessions(fx.db, 1, null)).toEqual([]);
});

test("the prior window sums the same length just before the selected one", async () => {
  const { periodChange, queryPreviousWindowTotal } = await import("../src/data/repository");
  const fx = mirrorFixture();
  const now = Date.now();
  const day = 86_400_000;
  const rows = [
    { at: now - 2 * day, tokens: 100, cost: "0.10" }, // current 7d
    { at: now - 8 * day, tokens: 40, cost: "0.04" }, // prior 7d
    { at: now - 13.9 * day, tokens: 10, cost: "0.01" }, // prior 7d
    { at: now - 15 * day, tokens: 999, cost: "9" }, // older than both
  ];
  const base = history(1)[0]!;
  await mergePeerEvents(fx.db, "direct-a", "a",
    rows.map((r, i) => ({ ...base, occurredAtMs: r.at, inputTokens: r.tokens, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, cost: r.cost, dedupKey: `p${i}` })), () => {});
  expect(await queryPreviousWindowTotal(fx.db, 7, "tokens")).toBe(50);
  expect(await queryPreviousWindowTotal(fx.db, 7, "cost")).toBeCloseTo(0.05, 9);
  expect(await queryPreviousWindowTotal(fx.db, null, "cost")).toBeNull();
  expect(periodChange(100, 50)).toBe(1);
  expect(periodChange(25, 50)).toBe(-0.5);
  expect(periodChange(5, 0)).toBeNull();
  expect(periodChange(5, null)).toBeNull();
});
