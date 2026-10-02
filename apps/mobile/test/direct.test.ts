import { describe, expect, test } from "bun:test";
import {
  LIVE_OVERLAP_MS,
  liveEventId,
  LiveUnreachableError,
  type MachineEventInput,
  type LiveApi,
  type LiveEventsPage,
  type LivePing,
} from "@burn/sync-api";
import { queryWindowOverview } from "../src/data/repository";
import { mirrorFixture } from "./mirror-fixture";
import {
  addDirectMachine,
  directEnvId,
  listDirectMachines,
  pullDirectFromMachines,
  removeDirectMachine,
  type DirectPullOptions,
} from "../src/lib/direct";

function ingestRow(over: Partial<MachineEventInput> = {}): MachineEventInput {
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

function directApiFor(
  map: Record<string, FakeEntry>,
): NonNullable<DirectPullOptions["apiFor"]> {
  return (endpoint: string) => {
    const entry =
      map[endpoint] ??
      (map[endpoint] = { seenSince: [], seenPingSignal: null });
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
        if (!entry.page)
          return {
            sinceMs,
            generatedAt: "2026-09-07T10:00:00.000Z",
            events: [],
          };
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

async function seedEnvironment(
  fx: { db: import("expo-sqlite").SQLiteDatabase },
  slug: string,
  id: string,
) {
  await fx.db.runAsync(
    `insert into environments (id, slug, display_name, os_kind, reporting_timezone)
     values (?, ?, ?, 'windows', 'Asia/Kolkata')`,
    [id, slug, slug],
  );
}

async function seedCachedEvent(
  fx: { db: import("expo-sqlite").SQLiteDatabase },
  envId: string,
  slug: string,
  row: MachineEventInput,
) {
  await fx.db.runAsync(
    `insert or replace into usage_events
     (event_id, environment_id, client, provider_id, model_id, session_id, session_title,
      workspace_key, workspace_label, agent, occurred_at_ms, source_offset_minutes, source_timezone,
      source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source,
      cost_is_complete, model_attribution_conflicted, parser_version)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      liveEventId(slug, row.client, row.dedupKey),
      envId,
      row.client,
      row.providerId,
      row.modelId,
      row.sessionId,
      row.sessionTitle,
      row.workspaceKey,
      row.workspaceLabel,
      row.agent,
      row.occurredAtMs,
      row.sourceOffsetMinutes,
      row.sourceTimezone,
      row.sourceLocalDate,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.reasoningTokens,
      row.messageCount,
      row.isTurnStart ? 1 : 0,
      row.durationMs,
      row.cost,
      row.costSource,
      row.costIsComplete ? 1 : 0,
      row.modelAttributionConflicted ? 1 : 0,
      row.parserVersion,
    ],
  );
}

describe("direct mode registry", () => {
  test("add validates via /ping, registers, and mints a direct env row", async () => {
    const fx = mirrorFixture();
    const api = directApiFor({ "http://win:8787": { ping: ping() } });
    const added = await addDirectMachine(fx.db, "http://win:8787/", {
      apiFor: api,
      now: () => 1000,
    });
    expect(added).toEqual({
      id: directEnvId("win"),
      slug: "win",
      displayName: "Win",
    });
    const machines = await listDirectMachines(fx.db);
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      slug: "win",
      baseUrl: "http://win:8787",
    });
    const env = await fx.db.getFirstAsync<Record<string, unknown>>(
      "select * from environments where id = ?",
      [directEnvId("win")],
    );
    expect(env!.slug).toBe("win");
    expect(env!.live_endpoint).toBe("http://win:8787");
  });

  test("adding reuses an existing cached environment id with the same slug", async () => {
    const fx = mirrorFixture();
    await seedEnvironment(fx, "win", "existing-uuid-win");
    const api = directApiFor({ "http://win:8787": { ping: ping() } });
    const added = await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: api,
    });
    expect(added.id).toBe("existing-uuid-win");
  });

  test("an unreachable endpoint is refused at add time", async () => {
    const fx = mirrorFixture();
    const api = directApiFor({
      "http://win:8787": { failPing: new LiveUnreachableError("timeout") },
    });
    await expect(
      addDirectMachine(fx.db, "http://win:8787", { apiFor: api }),
    ).rejects.toThrow(/no answer/);
    expect(await listDirectMachines(fx.db)).toHaveLength(0);
  });
});

describe("direct pull", () => {
  test("first pull takes full history and atomically sets the cursor", async () => {
    const fx = mirrorFixture();
    const seen: FakeEntry = {
      seenSince: [],
      seenPingSignal: null,
      page: {
        sinceMs: null,
        generatedAt: "2026-09-07T10:00:00.000Z",
        events: [ingestRow()],
      },
    };
    await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: directApiFor({ "http://win:8787": seen }),
      now: () => 5_000,
    });
    const statuses = await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": seen }),
      now: () => 10_000,
    });
    expect(statuses[0]).toMatchObject({
      state: "live",
      slug: "win",
      pulledEvents: 1,
      error: null,
    });
    // A new phone starts with full machine history.
    expect(seen.seenSince[0]).toBe(0); // first pull: full history
    const row = await fx.db.getFirstAsync<Record<string, unknown>>(
      "select * from usage_events where event_id = ?",
      [liveEventId("win", "codex", "v1:codex:s1:1725599000000:1")],
    );
    expect(row).not.toBeNull();
    expect(row!.environment_id).toBe(directEnvId("win"));
    const cursor = await fx.db.getFirstAsync<{ value: string }>(
      "select value from kv where key = 'direct_since_v3_" +
        directEnvId("win") +
        "'",
    );
    expect(Number(cursor!.value)).toBe(Date.parse("2026-09-07T10:00:00Z"));
  });

  test("the second pull passes cursor-minus-overlap and merges the fresh tail", async () => {
    const fx = mirrorFixture();
    const seen: FakeEntry = {
      seenSince: [],
      page: {
        sinceMs: null,
        generatedAt: "2026-09-07T10:00:00.000Z",
        events: [ingestRow()],
      },
    };
    await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: directApiFor({ "http://win:8787": seen }),
      now: () => 10_000_000,
    });
    await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": seen }),
      now: () => 10_000_000,
    });
    const newer = ingestRow({
      sessionId: "s2",
      occurredAtMs: 1725599500000,
      dedupKey: "v1:codex:s2:1725599500000:1",
    });
    seen.page = {
      sinceMs: 1000,
      generatedAt: "2026-09-07T10:05:00.000Z",
      events: [newer],
    };
    let clock = 11_000_000;
    const statuses = await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": seen }),
      now: () => clock,
    });
    expect(statuses[0]!.pulledEvents).toBe(1);
    expect(seen.seenSince[1]).toBe(
      Date.parse("2026-09-07T10:00:00Z") - LIVE_OVERLAP_MS,
    );
    const row = await fx.db.getFirstAsync<Record<string, unknown>>(
      "select * from usage_events where event_id = ?",
      [liveEventId("win", "codex", "v1:codex:s2:1725599500000:1")],
    );
    expect(row).not.toBeNull();
    const first = await fx.db.getFirstAsync<{ n: number }>(
      "select count(*) as n from usage_events",
    );
    expect(first!.n).toBe(2);
  });

  test("the fixed cursor generation ignores a legacy tail-only first-pull cursor", async () => {
    const fx = mirrorFixture();
    const seen: FakeEntry = {
      seenSince: [],
      seenPingSignal: null,
      page: {
        sinceMs: 0,
        generatedAt: "2026-09-07T10:00:00.000Z",
        events: [ingestRow()],
      },
    };
    const id = directEnvId("win");
    await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: directApiFor({ "http://win:8787": seen }),
      now: () => 10_000_000,
    });
    // The original direct-mode release advanced this key after fetching only
    // the reporter's recent tail. It must not suppress the corrective backfill.
    await fx.db.runAsync("insert into kv (key, value) values (?, ?)", [
      `direct_since_${id}`,
      "10000000",
    ]);

    await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({ "http://win:8787": seen }),
      now: () => 11_000_000,
    });

    expect(seen.seenSince[0]).toBe(0);
  });

  test("quotas upsert per-environment and never clobber other machines", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }),
    });
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
    const rows = await fx.db.getAllAsync<Record<string, unknown>>(
      "select row_key, environment_id from quota_snapshots order by row_key",
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.row_key)).toContain(
      JSON.stringify([directEnvId("win"), "codex", "shared", "5h", "ok"]),
    );
    expect(rows.map((r) => r.row_key)).toContain("other-env|codex|acc|5h");
  });

  test("direct merge always applies machine corrections to cached rows", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }),
      now: () => 1_000,
    });
    const shared = ingestRow({ inputTokens: 777 });
    await seedCachedEvent(fx, directEnvId("win"), "win", shared);
    const statuses = await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({
        "http://win:8787": {
          seenSince: [],
          page: {
            sinceMs: null,
            generatedAt: "2026-09-07T10:00:00Z",
            events: [ingestRow({ inputTokens: 12345 })],
          },
        },
      }),
      now: () => 2_000,
    });
    expect(statuses[0]!.state).toBe("live");
    const row = await fx.db.getFirstAsync<Record<string, unknown>>(
      "select * from usage_events where event_id = ?",
      [liveEventId("win", "codex", "v1:codex:s1:1725599000000:1")],
    );
    expect(row!.input_tokens).toBe(12345);
  });

  test("remove cascades registry, env, events, quotas, and cursor", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }),
      now: () => 1_000,
    });
    await pullDirectFromMachines(fx.db, {
      apiFor: directApiFor({
        "http://win:8787": {
          seenSince: [],
          page: {
            sinceMs: null,
            generatedAt: "2026-09-07T10:00:00Z",
            events: [ingestRow()],
          },
        },
      }),
      now: () => 2_000,
    });
    await removeDirectMachine(fx.db, directEnvId("win"));
    expect(await listDirectMachines(fx.db)).toHaveLength(0);
    for (const table of [
      "direct_machines",
      "usage_events",
      "quota_snapshots",
      "environments",
    ]) {
      const r = await fx.db.getFirstAsync<{ n: number }>(
        `select count(*) as n from ${table}`,
      );
      expect(r!.n).toBe(0);
    }
    const cursor = await fx.db.getFirstAsync<{ value: string }>(
      "select value from kv where key = 'direct_since_v3_" +
        directEnvId("win") +
        "'",
    );
    expect(cursor).toBeNull();
  });

  test("offline and slug-mismatch machines report without writing", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }),
      now: () => 1_000,
    });
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
    const winEnv = await fx.db.getFirstAsync<{ n: number }>(
      "select count(*) as n from usage_events where environment_id = ?",
      [directEnvId("win")],
    );
    expect(winEnv!.n).toBe(0);
  });

  test("an aborted direct pull never commits", async () => {
    const fx = mirrorFixture();
    await addDirectMachine(fx.db, "http://win:8787", {
      apiFor: directApiFor({ "http://win:8787": { seenSince: [] } }),
      now: () => 1_000,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      pullDirectFromMachines(fx.db, {
        apiFor: directApiFor({
          "http://win:8787": {
            seenSince: [],
            page: {
              sinceMs: null,
              generatedAt: "2026-09-07T10:00:00Z",
              events: [ingestRow()],
            },
          },
        }),
        signal: controller.signal,
        now: () => 2_000,
      }),
    ).rejects.toThrow("cancelled");
    const cursor = await fx.db.getFirstAsync<{ value: string }>(
      "select value from kv where key = 'direct_since_v3_" +
        directEnvId("win") +
        "'",
    );
    expect(cursor).toBeNull();
  });
});

test("an aborted direct pull cannot commit a downloaded page queued behind another writer", async () => {
  const { withWriteLock } = await import("../src/lib/writelock");
  const fx = mirrorFixture();
  let downloaded!: () => void;
  const seen = new Promise<void>((resolve) => {
    downloaded = resolve;
  });
  let release!: () => void;
  let lock: Promise<void>;
  const api: LiveApi = {
    ping: async () => ping(),
    events: async () => {
      lock = withWriteLock(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      downloaded();
      return {
        sinceMs: 0,
        generatedAt: "2026-09-30T10:00:00Z",
        events: [ingestRow()],
      };
    },
    quotas: async () => ({ generatedAt: "2026-09-30T10:00:00Z", quotas: [] }),
  };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  const controller = new AbortController();
  const pending = pullDirectFromMachines(fx.db, {
    apiFor: () => api,
    signal: controller.signal,
  }).catch(() => []);
  await seen;
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  release();
  await lock!;
  await pending;
  expect(
    await fx.db.getFirstAsync("select count(*) as n from usage_events"),
  ).toEqual({ n: 0 });
});

test("older direct quotas and later errors cannot evict the last successful quota", async () => {
  const fx = mirrorFixture();
  const q = {
    provider: "codex",
    accountKey: "acc",
    accountLabel: "Personal",
    plan: "Plus",
    metric: "weekly",
    usedPercent: 40,
    remainingPercent: 60,
    remainingLabel: null,
    resetsAt: null,
    creditStatus: null,
    spendControl: null,
    sourceOffsetMinutes: null,
    status: "ok" as const,
    error: null,
  };
  let page = { generatedAt: "2026-09-30T10:00:00Z", quotas: [q] };
  const api: LiveApi = {
    ping: async () => ping(),
    events: async () => ({
      sinceMs: 0,
      generatedAt: page.generatedAt,
      events: [],
    }),
    quotas: async () => page,
  };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  await pullDirectFromMachines(fx.db, { apiFor: () => api });
  page = {
    generatedAt: "2026-09-30T09:00:00Z",
    quotas: [{ ...q, usedPercent: 20 }],
  };
  await pullDirectFromMachines(fx.db, { apiFor: () => api });
  expect(
    await fx.db.getFirstAsync(
      "select used_percent from quota_snapshots where status='ok'",
    ),
  ).toEqual({ used_percent: 40 });
  const errorApi: LiveApi = {
    ...api,
    quotas: async () => ({
      generatedAt: "2026-09-30T11:00:00Z",
      quotas: [{ ...q, status: "error", error: "vendor unavailable" }],
    }),
  };
  await pullDirectFromMachines(fx.db, { apiFor: () => errorApi });
  expect(
    await fx.db.getFirstAsync(
      "select used_percent from quota_snapshots where status='ok'",
    ),
  ).toEqual({ used_percent: 40 });
});

test("paged direct backfill publishes partial rows, resumes, and checkpoints the scan rather than phone time", async () => {
  const fx = mirrorFixture();
  const seen: (string | undefined)[] = [];
  const api: LiveApi = {
    ping: async () => ping({ serverNowMs: 100_000 }),
    quotas: async () => ({ generatedAt: "2026-09-30T10:00:00Z", quotas: [] }),
    events: async (since, signal, request) => {
      seen.push(request?.cursor);
      return {
        slug: "win",
        sinceMs: since,
        generatedAt: "2026-09-30T10:00:00Z",
        scanStartedAtMs: 50_000,
        snapshotId: "snapshot",
        contentHash: "hash",
        events: [ingestRow({ dedupKey: request?.cursor ?? "first" })],
        nextCursor: request?.cursor ? null : "second",
      };
    },
  };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  const options = { apiFor: () => api, maxPages: 1, now: () => 999_999 };
  expect((await pullDirectFromMachines(fx.db, options))[0]!.hasMore).toBe(true);
  expect(
    await fx.db.getFirstAsync("select count(*) as n from usage_events"),
  ).toEqual({ n: 1 });
  expect(
    await fx.db.getFirstAsync(
      "select value from kv where key='direct_since_v3_direct-win'",
    ),
  ).toBeNull();
  expect((await pullDirectFromMachines(fx.db, options))[0]!.hasMore).toBe(
    false,
  );
  expect(seen).toEqual([undefined, "second"]);
  expect(
    await fx.db.getFirstAsync(
      "select value from kv where key='direct_since_v3_direct-win'",
    ),
  ).toEqual({ value: "50000" });
  expect(
    await fx.db.getFirstAsync("select count(*) as n from usage_events"),
  ).toEqual({ n: 2 });
});

test("an expired partial snapshot restarts safely without duplicating committed rows", async () => {
  const { LiveError } = await import("@burn/sync-api");
  const fx = mirrorFixture();
  let expired = false;
  const api: LiveApi = {
    ping: async () => ping(),
    quotas: async () => ({ generatedAt: "2026-09-30T10:00:00Z", quotas: [] }),
    events: async (since, signal, request) => {
      if (request?.cursor && !expired) {
        expired = true;
        throw new LiveError("expired", 410);
      }
      return {
        sinceMs: since,
        generatedAt: "2026-09-30T10:00:00Z",
        scanStartedAtMs: 50_000,
        snapshotId: expired ? "new" : "old",
        events: [ingestRow({ dedupKey: request?.cursor ?? "first" })],
        nextCursor: request?.cursor ? null : "second",
      };
    },
  };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  await pullDirectFromMachines(fx.db, { apiFor: () => api, maxPages: 1 });
  const result = await pullDirectFromMachines(fx.db, {
    apiFor: () => api,
    maxPages: 3,
  });
  expect(result[0]!.state).toBe("live");
  expect(result[0]!.hasMore).toBe(false);
  expect(
    await fx.db.getFirstAsync("select count(*) as n from usage_events"),
  ).toEqual({ n: 2 });
});

test("machine corrections replace cached content and unchanged refreshes are no-ops", async () => {
  const fx = mirrorFixture();
  const row = ingestRow();
  const api: LiveApi = {
    ping: async () => ping(),
    quotas: async () => ({ generatedAt: "2026-09-30T10:00:00Z", quotas: [] }),
    events: async () => ({
      sinceMs: 0,
      generatedAt: "2026-09-30T10:00:00Z",
      events: [{ ...row, inputTokens: 123 }],
    }),
  };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  await seedCachedEvent(fx, directEnvId("win"), "win", row);
  await pullDirectFromMachines(fx.db, {
    apiFor: () => api,
  });
  expect(
    await fx.db.getFirstAsync("select input_tokens from usage_events"),
  ).toEqual({ input_tokens: 123 });
  expect(
    (
      await pullDirectFromMachines(fx.db, {
        apiFor: () => api,
      })
    )[0]!.pulledEvents,
  ).toBe(0);
});

test("machine clock rollback forces full reconciliation and resets the scan checkpoint", async () => {
  const fx = mirrorFixture();
  const seen: (number | null)[] = [];
  let serverClock = 500_000;
  const api: LiveApi = {
    ping: async () => ping({ serverNowMs: serverClock }),
    quotas: async () => ({
      generatedAt: new Date(serverClock).toISOString(),
      quotas: [],
    }),
    events: async (since) => {
      seen.push(since);
      return {
        sinceMs: since,
        scanStartedAtMs: serverClock,
        generatedAt: new Date(serverClock).toISOString(),
        events: [],
      };
    },
  };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  await pullDirectFromMachines(fx.db, { apiFor: () => api });
  serverClock = 100_000;
  await pullDirectFromMachines(fx.db, { apiFor: () => api });
  expect(seen).toEqual([0, 0]);
  expect(
    await fx.db.getFirstAsync(
      "select value from kv where key='direct_since_v3_direct-win'",
    ),
  ).toEqual({ value: "100000" });
});

test("an add-machine ping released after reset cannot recreate the registry", async () => {
  const fx = mirrorFixture();
  const { advanceSyncGeneration } = await import("../src/lib/sync-state");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const api: LiveApi = {
    ping: async () => {
      await gate;
      return ping();
    },
    events: async () => {
      throw new Error("unused");
    },
    quotas: async () => {
      throw new Error("unused");
    },
  };
  const pending = addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  const result = pending.catch((err: Error) => err);
  advanceSyncGeneration(fx.db);
  release();
  try {
    expect(await result).toBeInstanceOf(Error);
    expect(await listDirectMachines(fx.db)).toEqual([]);
    expect(await fx.db.getAllAsync("select id from environments")).toEqual([]);
  } finally {
    await result;
    fx.native.close();
  }
});

test("refreshes for different machines queue instead of silently dropping the second target", async () => {
  const fx = mirrorFixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let block = false;
  const calls: string[] = [];
  const apiFor = (url: string): LiveApi => ({
    ping: async () => {
      const slug = url.endsWith("/a") ? "a" : "b";
      if (block) {
        calls.push(slug);
        if (slug === "a") {
          entered();
          await gate;
        }
      }
      return ping({ slug });
    },
    events: async () => ({
      sinceMs: 0,
      generatedAt: new Date().toISOString(),
      events: [],
    }),
    quotas: async () => ({ generatedAt: new Date().toISOString(), quotas: [] }),
  });
  const a = await addDirectMachine(fx.db, "http://probe/a", { apiFor });
  const b = await addDirectMachine(fx.db, "http://probe/b", { apiFor });
  block = true;
  const first = pullDirectFromMachines(fx.db, { environmentId: a.id, apiFor });
  await started;
  const second = pullDirectFromMachines(fx.db, { environmentId: b.id, apiFor });
  release();
  try {
    expect((await second).map((s) => s.environmentId)).toEqual([b.id]);
    expect(calls).toEqual(["a", "b"]);
    await first;
  } finally {
    release();
    await Promise.allSettled([first, second]);
    fx.native.close();
  }
});

test("a queued targeted refresh is cancelled by reset before it can contact its machine", async () => {
  const { cancelDirectPull } = await import("../src/lib/direct");
  const { advanceSyncGeneration } = await import("../src/lib/sync-state");
  const fx = mirrorFixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let block = false;
  const calls: string[] = [];
  const apiFor = (url: string): LiveApi => ({
    ping: async () => {
      const slug = url.endsWith("/a") ? "a" : "b";
      if (block) {
        calls.push(slug);
        entered();
        await gate;
      }
      return ping({ slug });
    },
    events: async () => ({
      sinceMs: 0,
      generatedAt: new Date().toISOString(),
      events: [],
    }),
    quotas: async () => ({ generatedAt: new Date().toISOString(), quotas: [] }),
  });
  const a = await addDirectMachine(fx.db, "http://probe/a", { apiFor });
  const b = await addDirectMachine(fx.db, "http://probe/b", { apiFor });
  block = true;
  const first = pullDirectFromMachines(fx.db, { environmentId: a.id, apiFor });
  const firstError = first.catch((e: Error) => e);
  await started;
  const second = pullDirectFromMachines(fx.db, { environmentId: b.id, apiFor });
  const secondError = second.catch((e: Error) => e);
  advanceSyncGeneration(fx.db);
  cancelDirectPull(fx.db);
  release();
  try {
    expect(await firstError).toBeInstanceOf(Error);
    expect(await secondError).toBeInstanceOf(Error);
    expect(calls).toEqual(["a"]);
  } finally {
    await Promise.allSettled([first, second]);
    fx.native.close();
  }
});

test("health publishes before a blocked event scan, remains idempotent, and removes with its machine", async () => {
  const { querySystems } = await import("../src/data/repository");
  const { subscribeMirrorChanges } = await import("../src/lib/sync-state");
  const fx = mirrorFixture();
  const now = Date.now();
  const metric = { capturedAtMs: now, cpuLoadPct: 12, cpuTempC: null, ramUsedPct: 50,
    ramTempC: 43, gpuUtilPct: 75, gpuTempC: 60 };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const api: LiveApi = { ping: async () => ping(), quotas: async () => ({ generatedAt: new Date(now).toISOString(), quotas: [] }),
    metrics: async () => ({ generatedAt: new Date(now).toISOString(), metrics: [metric] }),
    events: async () => { await blocked; throw new Error("usage scan failed"); } };
  const { id } = await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  let healthPublished!: () => void;
  const published = new Promise<void>((resolve) => { healthPublished = resolve; });
  const unsubscribe = subscribeMirrorChanges((db, kind) => { if (db === fx.db && kind === "systems") healthPublished(); });
  const pending = pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => now });
  await published;
  expect((await querySystems(fx.db))[0]!.metrics[0]!.ramUsedPct).toBe(50);
  release();
  const status = (await pending)[0]!;
  expect(status.error).toContain("usage scan failed");
  expect(status.pulledMetrics).toBe(1);
  expect((await pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => now }))[0]!.pulledMetrics).toBe(0);
  await removeDirectMachine(fx.db, id);
  expect(fx.native.query("select count(*) as count from machine_metrics").get()).toEqual({ count: 0 });
  unsubscribe();
  fx.native.close();
});

test("old reporters without health remain usable and invalid health never reaches SQLite", async () => {
  const fx = mirrorFixture();
  const api: LiveApi = { ping: async () => ping(), events: async () => ({ sinceMs: 0, generatedAt: new Date().toISOString(), events: [] }),
    quotas: async () => ({ generatedAt: new Date().toISOString(), quotas: [] }) };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  expect((await pullDirectFromMachines(fx.db, { apiFor: () => api }))[0]!.metricsError).toBeNull();
  api.metrics = async () => ({ generatedAt: new Date().toISOString(), metrics: [{ capturedAtMs: 1, cpuLoadPct: 2,
    cpuTempC: null, ramUsedPct: 150, ramTempC: null, gpuUtilPct: null, gpuTempC: null }] });
  expect((await pullDirectFromMachines(fx.db, { apiFor: () => api }))[0]!.metricsError).toContain("0–100");
  expect(fx.native.query("select count(*) as count from machine_metrics").get()).toEqual({ count: 0 });
  fx.native.close();
});

test("health downloaded after reset cannot repopulate the mirror", async () => {
  const { advanceSyncGeneration } = await import("../src/lib/sync-state");
  const { cancelDirectPull } = await import("../src/lib/direct");
  const fx = mirrorFixture();
  const now = Date.now();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const api: LiveApi = { ping: async () => ping(),
    events: async () => ({ generatedAt: new Date(now).toISOString(), sinceMs: 0, events: [] }),
    quotas: async () => ({ generatedAt: new Date(now).toISOString(), quotas: [] }),
    metrics: async () => { entered(); await blocked; return { generatedAt: new Date(now).toISOString(), metrics: [
      { capturedAtMs: now, cpuLoadPct: 12, cpuTempC: null, ramUsedPct: 50, ramTempC: null, gpuUtilPct: null, gpuTempC: null },
    ] }; } };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  const pending = pullDirectFromMachines(fx.db, { apiFor: () => api });
  const outcome = pending.catch((err: Error) => err);
  await started;
  advanceSyncGeneration(fx.db);
  cancelDirectPull(fx.db);
  release();
  expect(await outcome).toBeInstanceOf(Error);
  expect((await outcome as Error).message).toContain("cancelled");
  expect(fx.native.query("select count(*) as count from machine_metrics").get()).toEqual({ count: 0 });
  fx.native.close();
});

  test("combines cost and every token bucket across direct machines", async () => {
    const fx = mirrorFixture();
    const apiFor = directApiFor({
      "http://win:8787": {
        ping: ping({ slug: "win", displayName: "Windows" }),
        seenSince: [],
        seenPingSignal: null,
        page: {
          sinceMs: 0,
          generatedAt: "2026-09-10T10:00:00.000Z",
          events: [ingestRow()],
        },
      },
      "http://cachyos:8787": {
        ping: ping({ slug: "cachyos", displayName: "CachyOS", osKind: "linux" }),
        seenSince: [],
        seenPingSignal: null,
        page: {
          sinceMs: 0,
          generatedAt: "2026-09-10T10:00:00.000Z",
          events: [ingestRow({
            inputTokens: 20,
            outputTokens: 4,
            cacheReadTokens: 6,
            cacheWriteTokens: 8,
            reasoningTokens: 10,
            cost: "0.000246",
          })],
        },
      },
    });
    await addDirectMachine(fx.db, "http://win:8787", { apiFor });
    await addDirectMachine(fx.db, "http://cachyos:8787", { apiFor });

    await pullDirectFromMachines(fx.db, { apiFor });

    const { totals } = await queryWindowOverview(fx.db, "UTC", null, "tokens", "yearly");
    expect(totals).toMatchObject({
      inputTokens: 30,
      outputTokens: 6,
      cacheReadTokens: 6,
      cacheWriteTokens: 8,
      reasoningTokens: 10,
      messages: 2,
    });
    expect(totals.cost).toBeCloseTo(0.000369, 9);
    fx.native.close();
  });
