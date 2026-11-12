/** The SQL-side aggregates must equal aggregating every event in JS. */
import { expect, test } from "bun:test";
import type { MachineEventInput } from "@burn/sync-api";
import {
  bucketEvents, eventTokens, queryClients, queryGranularityMax, queryModels, queryWorkspaces,
  sessionKey, type EventRow,
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
