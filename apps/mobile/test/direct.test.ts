import { describe, expect, test } from "bun:test";
import { LIVE_OVERLAP_MS, liveEventId, LiveUnreachableError, type IngestEventInput, type LiveApi, type LiveEventsPage, type LivePing } from "@burn/sync-api";
import { mirrorFixture } from "./mirror-fixture";
import { subscribeMirrorChanges } from "../src/lib/sync-state";
import {
  addDirectMachine,
  directEnvId,
  listDirectMachines,
  pullDirectFromMachines,
  removeDirectMachine,
  type DirectPullOptions,
} from "../src/lib/direct";

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
    sinceMs: null,
    serverNowMs: Date.now(),
    ...over,
  };
}

interface FakeEntry {
  ping?: LivePing;
  failPing?: Error;
  page?: LiveEventsPage;
  failEvents?: Error;
  quotas?: { generatedAt: string; quotas: Record<string, unknown>[] };
  seenSince: (number | null)[];
  seenPingSignal: AbortSignal | null;
}

function directApiFor(map: Record<string, FakeEntry>): NonNullable<DirectPullOptions["apiFor"]> {
  return (endpoint: string) => {
    const entry = map[endpoint] ?? (map[endpoint] = { seenSince: [], seenPingSignal: null });
    return {
      ping: async (signal) => {
        entry.seenPingSignal = signal ?? null;
        if (signal?.aborted) throw new LiveUnreachableError("aborted");
        if (entry.failPing) throw entry.failPing;
        return entry.ping ?? ping();
      },
      events: async (sinceMs, signal) => {
        if (signal?.aborted) throw new LiveUnreachableError("aborted");
        entry.seenSince.push(sinceMs);
        if (entry.failEvents) throw entry.failEvents;
        if (!entry.page) return { sinceMs, generatedAt: "2026-09-07T10:00:00.000Z", events: [] };
        return entry.page;
      },
      quotas: async (signal) => {
        if (signal?.aborted) throw new LiveUnreachableError("aborted");
        if (!entry.quotas) throw new Error("no quotas configured");
        return entry.quotas as never;
      },
    } satisfies LiveApi;
  };
}

async function seedCloudEnvironment(fx: { db: import("expo-sqlite").SQLiteDatabase }, slug: string, id: string) {
  await fx.db.runAsync(
    `insert into environments (id, slug, display_name, os_kind, reporting_timezone, latest_revision)
     values (?, ?, ?, 'windows', 'Asia/Kolkata', 3)`,
    [id, slug, slug],
  );
}

async function seedServerEvent(
  fx: { db: import("expo-sqlite").SQLiteDatabase },
  envId: string,
  slug: string,
  row: IngestEventInput,
  revision: number,
) {
  await fx.db.runAsync(
    `insert or replace into usage_events
     (event_id, environment_id, client, provider_id, model_id, session_id, session_title,
      workspace_key, workspace_label, agent, occurred_at_ms, source_offset_minutes, source_timezone,
      source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source,
      cost_is_complete, model_attribution_conflicted, parser_version, revision)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      liveEventId(slug, row.client, row.dedupKey), envId, row.client, row.providerId, row.modelId,
      row.sessionId, row.sessionTitle, row.workspaceKey, row.workspaceLabel, row.agent,
      row.occurredAtMs, row.sourceOffsetMinutes, row.sourceTimezone, row.sourceLocalDate,
      row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens,
      row.reasoningTokens, row.messageCount, row.isTurnStart ? 1 : 0, row.durationMs, row.cost,
      row.costSource, row.costIsComplete ? 1 : 0, row.modelAttributionConflicted ? 1 : 0,
      row.parserVersion, revision,
    ],
  );
}

describe("direct mode registry", () => {
  test("add validates via /ping, registers, and mints a direct env row", async () => {
    const fx = mirrorFixture();
    const api = directApiFor({ "http://win:8787": { ping: ping() } });
    const added = await addDirectMachine(fx.db, "http://win:8787/", { apiFor: api, now: () => 1000 });
    expect(added).toEqual({ id: directEnvId("win"), slug: "win", displayName: "Win" });
    const machines = await listDirectMachines(fx.db);
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({ slug: "win", baseUrl: "http://win:8787" });
    const env = await fx.db.getFirstAsync<Record<string, unknown>>("select * from environments where id = ?", [directEnvId("win")]);
    expect(env!.slug).toBe("win");
    expect(env!.live_endpoint).toBe("http://win:8787");
  });

  test("adding reuses an existing cloud environment id with the same slug", async () => {
    const fx = mirrorFixture();
    await seedCloudEnvironment(fx, "win", "cloud-uuid-win");
    const api = directApiFor({ "http://win:8787": { ping: ping() } });
    const added = await addDirectMachine(fx.db, "http://win:8787", { apiFor: api });
    expect(added.id).toBe("cloud-uuid-win");
  });

  test("an unreachable endpoint is refused at add time", async () => {
    const fx = mirrorFixture();
    const api = directApiFor({ "http://win:8787": { failPing: new LiveUnreachableError("timeout") } });
    await expect(addDirectMachine(fx.db, "http://win:8787", { apiFor: api })).rejects.toThrow(/no answer/);
    expect(await listDirectMachines(fx.db)).toHaveLength(0);
  });
});

describe("direct pull", () => {
  test("first pull takes full history, commits revision 0, and sets the cursor", async () => {
    const fx = mirrorFixture();
    const seen: FakeEntry = { seenSince: [], seenPingSignal: null, page: { sinceMs: null, generatedAt: "2026-09-07T10:00:00.000Z", events: [ingestRow()] } };
    await addDirectMachine(fx.db, "http://win:8787", { apiFor: directApiFor({ "http://win:8787": seen }), now: () => 5_000 });
    const statuses = await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": seen }),
      now: () => 10_000,
    });
    expect(statuses[0]).toMatchObject({ state: "live", slug: "win", pulledEvents: 1, error: null });
    expect(seen.seenSince[0]).toBeNull(); // first pull: full history
    const row = await fx.db.getFirstAsync<Record<string, unknown>>(
      "select * from usage_events where event_id = ?",
      [liveEventId("win", "codex", "v1:codex:s1:1725599000000:1")],
    );
    expect(row).not.toBeNull();
    expect(row!.revision).toBe(0);
    expect(row!.environment_id).toBe(directEnvId("win"));
    const cursor = await fx.db.getFirstAsync<{ value: string }>("select value from kv where key = 'direct_since_" + directEnvId("win") + "'");
    expect(cursor!.value).toBe("10000");
  });

  test("the second pull passes cursor-minus-overlap and merges the fresh tail", async () => {
    const fx = mirrorFixture();
    const seen: FakeEntry = { seenSince: [], page: { sinceMs: null, generatedAt: "2026-09-07T10:00:00.000Z", events: [ingestRow()] } };
    await addDirectMachine(fx.db, "http://win:8787", { apiFor: directApiFor({ "http://win:8787": seen }), now: () => 10_000_000 });
    await pullDirectFromMachines(fx.db, { apiFor: directApiFor({ "http://win:8787": seen }), now: () => 10_000_000 });
    const newer = ingestRow({
      sessionId: "s2",
      occurredAtMs: 1725599500000,
      dedupKey: "v1:codex:s2:1725599500000:1",
    });
    seen.page = { sinceMs: 1000, generatedAt: "2026-09-07T10:05:00.000Z", events: [newer] };
    let clock = 11_000_000;
    const statuses = await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": seen }),
      now: () => clock,
    });
    expect(statuses[0]!.pulledEvents).toBe(1);
    expect(seen.seenSince[1]).toBe(10_000_000 - LIVE_OVERLAP_MS);
    const row = await fx.db.getFirstAsync<Record<string, unknown>>("select * from usage_events where event_id = ?", [
      liveEventId("win", "codex", "v1:codex:s2:1725599500000:1"),
    ]);
    expect(row).not.toBeNull();
    const first = await fx.db.getFirstAsync<{ n: number }>("select count(*) as n from usage_events");
    expect(first!.n).toBe(2);
  });

  test("concurrent callers share one machine scan", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }),
    });
    let eventCalls = 0;
    let started!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apiFor: NonNullable<DirectPullOptions["apiFor"]> = () => ({
      ping: async () => ping(),
      events: async (sinceMs) => {
        eventCalls += 1;
        started();
        await gate;
        return { sinceMs, generatedAt: "2026-09-07T10:00:00.000Z", events: [ingestRow()] };
      },
      quotas: async () => {
        throw new Error("no quotas configured");
      },
    });

    const first = pullDirectFromMachines(fx.db, { apiFor, now: () => 10_000 });
    await scanStarted;
    const second = pullDirectFromMachines(fx.db, { apiFor, now: () => 10_000 });
    release();

    expect(second).toBe(first);
    await expect(first).resolves.toHaveLength(1);
    expect(eventCalls).toBe(1);
  });

  test("an identical overlap does not announce an event change", async () => {
    const fx = mirrorFixture();
    const entry: FakeEntry = {
      seenSince: [],
      page: {
        sinceMs: null,
        generatedAt: "2026-09-07T10:00:00.000Z",
        events: [ingestRow()],
      },
    };
    const apiFor = directApiFor({ "http://win:8787": entry });
    await addDirectMachine(fx.db, "http://win:8787", { apiFor });
    const changes: string[] = [];
    const unsubscribe = subscribeMirrorChanges((changedDb, kind) => {
      if (changedDb === fx.db) changes.push(kind);
    });
    try {
      await pullDirectFromMachines(fx.db, { apiFor, now: () => 10_000_000 });
      await pullDirectFromMachines(fx.db, { apiFor, now: () => 11_000_000 });
      expect(changes.filter((kind) => kind === "events")).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  test("quotas upsert per-environment and never clobber other machines", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", { apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }) });
    // Another machine's quota row must survive a win pull.
    await fx.db.runAsync(
      `insert into quota_snapshots (row_key, environment_id, provider, account_key, metric, status, fetched_at)
       values ('other-env|codex|acc|5h', 'other-env', 'codex', 'acc', '5h', 'ok', '2026-09-01T00:00:00.000Z')`,
    );
    const quotas = {
      generatedAt: "2026-09-07T11:00:00.000Z",
      quotas: [
        {
          provider: "codex",
          accountKey: "shared",
          accountLabel: "Personal",
          plan: null,
          metric: "5h",
          usedPercent: 40,
          remainingPercent: 60,
          remainingLabel: null,
          resetsAt: null,
          status: "ok",
          error: null,
          sourceOffsetMinutes: 330,
        },
      ],
    };
    const statuses = await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [], quotas } }),
      now: () => 10_000_000,
    });
    expect(statuses[0]!.pulledQuotas).toBe(1);
    const rows = await fx.db.getAllAsync<Record<string, unknown>>("select row_key, environment_id from quota_snapshots order by row_key");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.row_key)).toContain(`${directEnvId("win")}|codex|shared|5h`);
    expect(rows.map((r) => r.row_key)).toContain("other-env|codex|acc|5h");
  });

  test("direct merge never overwrites cloud-authoritative rows", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", { apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }), now: () => 1_000 });
    const shared = ingestRow({ inputTokens: 777 });
    await seedServerEvent(fx, directEnvId("win"), "win", shared, 6);
    const statuses = await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [], page: { sinceMs: null, generatedAt: "x", events: [ingestRow({ inputTokens: 12345 })] } } }),
      now: () => 2_000,
    });
    expect(statuses[0]!.state).toBe("live");
    const row = await fx.db.getFirstAsync<Record<string, unknown>>("select * from usage_events where event_id = ?", [
      liveEventId("win", "codex", "v1:codex:s1:1725599000000:1"),
    ]);
    expect(row!.revision).toBe(6);
    expect(row!.input_tokens).toBe(777);
  });

  test("remove cascades registry, env, events, quotas, and cursor", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", { apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }), now: () => 1_000 });
    await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [], page: { sinceMs: null, generatedAt: "x", events: [ingestRow()] } } }),
      now: () => 2_000,
    });
    await removeDirectMachine(fx.db, directEnvId("win"));
    expect(await listDirectMachines(fx.db)).toHaveLength(0);
    for (const table of ["direct_machines", "usage_events", "quota_snapshots", "environments"]) {
      const r = await fx.db.getFirstAsync<{ n: number }>(`select count(*) as n from ${table}`);
      expect(r!.n).toBe(0);
    }
    const cursor = await fx.db.getFirstAsync<{ value: string }>("select value from kv where key = 'direct_since_" + directEnvId("win") + "'");
    expect(cursor).toBeNull();
  });

  test("offline and slug-mismatch machines report without writing", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", { apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }), now: () => 1_000 });
    await addDirectMachine(fx.db, "http://cachyos:8787", {
      apiFor: directApiFor({
        "http://win:8787": { seenSince: [] },
        "http://cachyos:8787": {
          seenSince: [],
          ping: ping({ slug: "cachyos" }),
          failEvents: new Error("boom"),
        },
      }),
      now: () => 1_000,
    });
    const statuses = await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({
        "http://win:8787": { seenSince: [] },
        "http://cachyos:8787": {
          seenSince: [],
          ping: ping({ slug: "cachyos" }),
          failEvents: new Error("boom"),
        },
      }),
      now: () => 2_000,
    });
    const byslug = Object.fromEntries(statuses.map((s) => [s.slug, s]));
    expect(byslug["win"]!.state).toBe("live");
    expect(byslug["cachyos"]!.state).toBe("error");
    const winEnv = await fx.db.getFirstAsync<{ n: number }>("select count(*) as n from usage_events where environment_id = ?", [directEnvId("win")]);
    expect(winEnv!.n).toBe(0);
  });

  test("an aborted direct pull never commits", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", { apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }), now: () => 1_000 });
    const controller = new AbortController();
    controller.abort();
    const statuses = await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [], page: { sinceMs: null, generatedAt: "x", events: [ingestRow()] } } }),
      signal: controller.signal,
      now: () => 2_000,
    });
    expect(["offline", "error", "skipped"]).toContain(statuses[0]!.state);
    const cursor = await fx.db.getFirstAsync<{ value: string }>("select value from kv where key = 'direct_since_" + directEnvId("win") + "'");
    expect(cursor).toBeNull();
  });
});
