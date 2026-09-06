import { describe, expect, test } from "bun:test";
import { liveEventId, LiveUnreachableError } from "@burn/sync-api";
import { mirrorFixture } from "./mirror-fixture";
import { pullLiveFromMachines, type LivePullOptions } from "../src/lib/live";
import { queryDailyTotals } from "../src/data/repository";
import type { IngestEventInput, LiveApi, LiveEventsPage, LivePing } from "@burn/sync-api";

function ingestRow(over: Partial<IngestEventInput> = {}): IngestEventInput {
  return {
    client: "codex",
    providerId: "openai",
    modelId: "gpt-5.2",
    sessionId: "s1",
    sessionTitle: null,
    workspaceKey: null,
    workspaceLabel: null,
    agent: null,
    occurredAtMs: 1725599000000,
    sourceOffsetMinutes: 330,
    sourceTimezone: "Asia/Kolkata",
    sourceLocalDate: "2024-09-06",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    messageCount: 1,
    isTurnStart: true,
    durationMs: 100,
    cost: "0.000123",
    costSource: "provider_reported",
    costIsComplete: true,
    modelAttributionConflicted: false,
    parserVersion: "tokscale-4.15.1",
    dedupKey: "v1:codex:s1:1725599000000:1",
    ...over,
  };
}

function page(events: IngestEventInput[]): LiveEventsPage {
  return { sinceMs: 1000, generatedAt: "2026-09-07T10:00:00.000Z", events };
}

function ping(over: Partial<LivePing> = {}): LivePing {
  return {
    protocol: 1,
    slug: "win",
    displayName: "Win",
    hostGroup: null,
    osKind: "windows",
    reporterVersion: "0.1.0",
    tokscaleVersion: "4.15.1",
    exportSchema: 1,
    reportingTimezone: "Asia/Kolkata",
    sinceMs: 1000,
    serverNowMs: Date.now(),
    ...over,
  };
}

function apiForByEndpoint(map: Record<string, { page?: LiveEventsPage; ping?: LivePing; failPing?: Error; failEvents?: Error }>): LivePullOptions["apiFor"] {
  return (endpoint: string) =>
    ({
      ping: async (signal) => {
        if (signal?.aborted) throw new LiveUnreachableError("aborted");
        const entry = map[endpoint];
        if (entry?.failPing) throw entry.failPing;
        return entry?.ping ?? ping();
      },
      events: async (signal) => {
        if (signal?.aborted) throw new LiveUnreachableError("aborted");
        const entry = map[endpoint];
        if (entry?.failEvents) throw entry.failEvents;
        if (!entry?.page) throw new Error("no page configured");
        return entry.page;
      },
    }) satisfies LiveApi;
}

async function seedEnvironment(fx: { db: import("expo-sqlite").SQLiteDatabase }, over: Partial<{ slug: string; endpoint: string | null; latestRevision: number }> = {}) {
  const slug = over.slug ?? "win";
  const endpoint = over.endpoint === undefined ? "http://127.0.0.1:8787" : over.endpoint;
  await fx.db.runAsync(
    `insert into environments (id, slug, display_name, os_kind, reporting_timezone, latest_revision, live_endpoint)
     values (?, ?, ?, 'windows', 'Asia/Kolkata', ?, ?)`,
    [`env-${slug}`, slug, slug, over.latestRevision ?? 42, endpoint],
  );
  return `env-${slug}`;
}

async function seedServerEvent(fx: { db: import("expo-sqlite").SQLiteDatabase }, envId: string, slug: string, row: IngestEventInput, revision: number) {
  const eventId = liveEventId(slug, row.client, row.dedupKey);
  await fx.db.runAsync(
    `insert or replace into usage_events
     (event_id, environment_id, client, provider_id, model_id, session_id, session_title,
      workspace_key, workspace_label, agent, occurred_at_ms, source_offset_minutes, source_timezone,
      source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source,
      cost_is_complete, model_attribution_conflicted, parser_version, revision)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [eventId, envId, row.client, row.providerId, row.modelId, row.sessionId, row.sessionTitle, row.workspaceKey, row.workspaceLabel, row.agent, row.occurredAtMs, row.sourceOffsetMinutes, row.sourceTimezone, row.sourceLocalDate, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.reasoningTokens, row.messageCount, row.isTurnStart ? 1 : 0, row.durationMs, row.cost, row.costSource, row.costIsComplete ? 1 : 0, row.modelAttributionConflicted ? 1 : 0, row.parserVersion, revision],
  );
  return eventId;
}

async function eventRow(fx: { db: import("expo-sqlite").SQLiteDatabase }, eventId: string) {
  return fx.db.getFirstAsync<Record<string, unknown>>("select * from usage_events where event_id = ?", [eventId]);
}

describe("live pull merge", () => {
  test("live rows land with revision 0 under the right identity; watermark untouched", async () => {
    const fx = mirrorFixture();
    const envId = await seedEnvironment(fx, { slug: "win" });
    await fx.db.runAsync("insert or replace into kv (key, value) values ('watermark_revision', '7')");
    const api = apiForByEndpoint({
      "http://127.0.0.1:8787": { page: page([ingestRow(), ingestRow({ dedupKey: "v1:codex:s1:1725599000001:2", sessionId: "s1" })]) },
    });
    const statuses = await pullLiveFromMachines(fx.db, { apiFor: api });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ state: "live", slug: "win", pulledEvents: 2, error: null });

    const expectedId = liveEventId("win", "codex", "v1:codex:s1:1725599000000:1");
    const row = await eventRow(fx, expectedId);
    expect(row).not.toBeNull();
    expect(row!.revision).toBe(0);
    expect(row!.environment_id).toBe(envId);
    expect(row!.cost).toBe("0.000123");
    const second = await eventRow(fx, liveEventId("win", "codex", "v1:codex:s1:1725599000001:2"));
    expect(second).not.toBeNull();
    const watermark = await fx.db.getFirstAsync<{ value: string }>("select value from kv where key = 'watermark_revision'");
    expect(watermark!.value).toBe("7");
    const env = await fx.db.getFirstAsync<{ latest_revision: number }>("select latest_revision from environments where id = ?", [envId]);
    expect(env!.latest_revision).toBe(42);
  });

  test("live merge never overwrites a server-authoritative row", async () => {
    const fx = mirrorFixture();
    const envId = await seedEnvironment(fx, { slug: "win" });
    const serverRow = ingestRow({ inputTokens: 999, cost: "5.000000" });
    const eventId = await seedServerEvent(fx, envId, "win", serverRow, 5);
    const api = apiForByEndpoint({
      "http://127.0.0.1:8787": { page: page([ingestRow({ inputTokens: 12345, cost: "0.000123" })]) },
    });
    const statuses = await pullLiveFromMachines(fx.db, { apiFor: api });
    expect(statuses[0]!.state).toBe("live");
    expect(statuses[0]!.pulledEvents).toBe(1);
    const row = await eventRow(fx, eventId);
    expect(row!.revision).toBe(5);
    expect(row!.input_tokens).toBe(999);
    expect(row!.cost).toBe("5.000000");
  });

  test("a later server delta replaces the live copy (same event_id, revision wins)", async () => {
    const fx = mirrorFixture();
    const envId = await seedEnvironment(fx, { slug: "win" });
    const row0 = ingestRow();
    const api = apiForByEndpoint({ "http://127.0.0.1:8787": { page: page([row0]) } });
    await pullLiveFromMachines(fx.db, { apiFor: api });
    // The machine pushes; the server revises the row; the phone delta-applies
    // the same upsert SQL the cloud pull uses.
    const eventId = liveEventId("win", row0.client, row0.dedupKey);
    const corrected = ingestRow({ cost: "9.000000", parserVersion: "tokscale-4.16.0" });
    await seedServerEvent(fx, envId, "win", corrected, 8);
    const row = await eventRow(fx, eventId);
    expect(row!.revision).toBe(8);
    expect(row!.cost).toBe("9.000000");
  });

  test("live can refresh its own earlier (revision 0) rows", async () => {
    const fx = mirrorFixture();
    await seedEnvironment(fx, { slug: "win" });
    const first = apiForByEndpoint({ "http://127.0.0.1:8787": { page: page([ingestRow({ inputTokens: 100 })]) } });
    await pullLiveFromMachines(fx.db, { apiFor: first });
    const second = apiForByEndpoint({ "http://127.0.0.1:8787": { page: page([ingestRow({ inputTokens: 250, dedupKey: "v1:codex:s1:1725599000000:1" })]) } });
    await pullLiveFromMachines(fx.db, { apiFor: second });
    const row = await eventRow(fx, liveEventId("win", "codex", "v1:codex:s1:1725599000000:1"));
    expect(row!.input_tokens).toBe(250);
    expect(row!.revision).toBe(0);
  });

  test("slug mismatch is skipped and writes nothing", async () => {
    const fx = mirrorFixture();
    await seedEnvironment(fx, { slug: "win" });
    const api = apiForByEndpoint({ "http://127.0.0.1:8787": { ping: ping({ slug: "someone-else" }), page: page([ingestRow()]) } });
    const statuses = await pullLiveFromMachines(fx.db, { apiFor: api });
    expect(statuses[0]!.state).toBe("skipped");
    const count = await fx.db.getFirstAsync<{ n: number }>("select count(*) as n from usage_events");
    expect(count!.n).toBe(0);
  });

  test("unreachable machine reports offline; malformed page reports error; neither writes", async () => {
    const fx = mirrorFixture();
    await seedEnvironment(fx, { slug: "win", endpoint: "http://win:8787" });
    await seedEnvironment(fx, { slug: "cachyos", endpoint: "http://cachyos:8787" });
    const api = apiForByEndpoint({
      "http://win:8787": { failPing: new LiveUnreachableError("http://win:8787/ping: timeout") },
      "http://cachyos:8787": { ping: ping({ slug: "cachyos" }), failEvents: new Error("boom") },
    });
    const statuses = await pullLiveFromMachines(fx.db, { apiFor: api, pingTimeoutMs: 50, eventsTimeoutMs: 50 });
    const byslug = Object.fromEntries(statuses.map((s) => [s.slug, s]));
    expect(byslug["win"]!.state).toBe("offline");
    expect(byslug["cachyos"]!.state).toBe("error");
    const count = await fx.db.getFirstAsync<{ n: number }>("select count(*) as n from usage_events");
    expect(count!.n).toBe(0);
  });

  test("malformed rows reject the whole page before any write", async () => {
    const fx = mirrorFixture();
    await seedEnvironment(fx, { slug: "win" });
    const bad = page([ingestRow(), { ...ingestRow(), cost: 0.5, dedupKey: "v1:codex:s1:2:2" } as unknown as IngestEventInput]);
    const api = apiForByEndpoint({ "http://127.0.0.1:8787": { page: bad } });
    const statuses = await pullLiveFromMachines(fx.db, { apiFor: api });
    expect(statuses[0]!.state).toBe("error");
    const count = await fx.db.getFirstAsync<{ n: number }>("select count(*) as n from usage_events");
    expect(count!.n).toBe(0);
  });

  test("environments without an advertisement are simply not probed", async () => {
    const fx = mirrorFixture();
    await seedEnvironment(fx, { slug: "win", endpoint: null });
    const statuses = await pullLiveFromMachines(fx.db, { apiFor: apiForByEndpoint({}) });
    expect(statuses).toHaveLength(0);
  });

  test("the render pipeline sees live rows after the pull (cache evicted)", async () => {
    const fx = mirrorFixture();
    await seedEnvironment(fx, { slug: "win" });
    const recentTs = Date.now() - 3_600_000;
    const recent = ingestRow({
      occurredAtMs: recentTs,
      sessionId: "recent",
      dedupKey: "v1:codex:recent:1:1",
    });
    const api = apiForByEndpoint({ "http://127.0.0.1:8787": { page: page([recent]) } });
    const before = await queryDailyTotals(fx.db, "Asia/Kolkata", 30);
    expect(Object.keys(before.byKey)).toHaveLength(0);
    await pullLiveFromMachines(fx.db, { apiFor: api });
    const after = await queryDailyTotals(fx.db, "Asia/Kolkata", 30);
    expect(Object.keys(after.byKey).length).toBeGreaterThan(0);
    expect(after.max).toBeGreaterThan(0);
  });

  test("an aborted pull never commits", async () => {
    const fx = mirrorFixture();
    await seedEnvironment(fx, { slug: "win" });
    const controller = new AbortController();
    controller.abort();
    const api = apiForByEndpoint({ "http://127.0.0.1:8787": { page: page([ingestRow()]) } });
    const statuses = await pullLiveFromMachines(fx.db, { apiFor: api, signal: controller.signal });
    expect(["offline", "error", "skipped"]).toContain(statuses[0]!.state);
    const count = await fx.db.getFirstAsync<{ n: number }>("select count(*) as n from usage_events");
    expect(count!.n).toBe(0);
  });

  test("a superseded probe is abandoned and the fresh probe proceeds", async () => {
    const fx = mirrorFixture();
    await seedEnvironment(fx, { slug: "win" });
    let calls = 0;
    const apiFor: LivePullOptions["apiFor"] = () => ({
      ping: async (signal) => {
        if (signal?.aborted) throw new LiveUnreachableError("aborted");
        return ping();
      },
      events: async (signal) => {
        if (signal?.aborted) throw new LiveUnreachableError("aborted");
        calls += 1;
        if (calls === 1) {
          // The slow first probe is aborted by the superseding call; a real
          // fetch would reject here. Resolve late with the slow page to prove
          // the fresh probe doesn't wait on (or join) it.
          await new Promise((r) => setTimeout(r, 50));
          return page([ingestRow({ dedupKey: "v1:codex:slow:1:1", sessionId: "slow" })]);
        }
        return page([ingestRow({ dedupKey: "v1:codex:fast:1:1", sessionId: "fast" })]);
      },
    });
    const first = pullLiveFromMachines(fx.db, { apiFor });
    await new Promise((r) => setTimeout(r, 10));
    const second = await pullLiveFromMachines(fx.db, { apiFor });
    expect(second[0]!.state).toBe("live");
    const fastId = liveEventId("win", "codex", "v1:codex:fast:1:1");
    const fast = await eventRow(fx, fastId);
    expect(fast).not.toBeNull();
    await first;
  });
});
