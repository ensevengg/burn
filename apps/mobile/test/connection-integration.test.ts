import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startLiveServer } from "../../reporter/src/serve";
import { configSchema } from "../../reporter/src/config";
import { addDirectMachine, pullDirectFromMachines } from "../src/lib/direct";
import { mirrorFixture } from "./mirror-fixture";

test("27k-row direct history transfers through real HTTP into SQLite, resumes across passes and then returns unchanged", async () => {
  const config = configSchema.parse({
    environmentSlug: "integration",
    environmentName: "Integration",
  });
  const raw = readFileSync(
    join(import.meta.dir, "../../reporter/fixtures/tokscale-events.jsonl"),
    "utf8",
  ).split("\n")[0]!;
  const row = JSON.parse(raw);
  const history = Array.from({ length: 27_001 }, (_, i) =>
    JSON.stringify({
      ...row,
      dedup_key: `integration-${i}`,
      timestamp: row.timestamp + i,
      session_title: "Shared project 🔥 résumé ".repeat(8),
    }),
  ).join("\n");
  let scans = 0;
  let quotaScans = 0;
  const started = Date.now();
  const server = await startLiveServer(config, {
    bind: "127.0.0.1",
    port: 0,
    deps: {
      now: () => started,
      exporterCheck: async () => config.tokscalePin,
      exporterScan: async () => {
        scans++;
        return history;
      },
      usage: async () => {
        quotaScans++;
        return [];
      },
    },
  });
  const fx = mirrorFixture();
  try {
    const machine = await addDirectMachine(fx.db, server.url);
    let passes = 0;
    let changed = 0;
    while (true) {
      const statuses = await pullDirectFromMachines(fx.db, {
      });
      expect(statuses[0]!.state).toBe("live");
      changed += statuses[0]!.pulledEvents;
      passes++;
      if (!statuses[0]!.hasMore) break;
      expect(passes).toBeLessThan(5);
    }
    expect(passes).toBe(4);
    expect(changed).toBe(27_001);
    expect(scans).toBe(1);
    expect(quotaScans).toBe(1);
    expect(
      await fx.db.getFirstAsync("select count(*) as n from usage_events"),
    ).toEqual({ n: 27_001 });
    expect(
      await fx.db.getFirstAsync("select value from kv where key=?", [
        `direct_since_v3_${machine.id}`,
      ]),
    ).toEqual({ value: String(started) });
    const before = fx.writes.filter((write) =>
      write.sql.includes("insert into usage_events"),
    ).length;
    expect(
      (await pullDirectFromMachines(fx.db, {}))[0]!
        .pulledEvents,
    ).toBe(0);
    expect(
      fx.writes.filter((write) =>
        write.sql.includes("insert into usage_events"),
      ).length,
    ).toBe(before);
    expect(scans).toBe(1);
  } finally {
    server.stop();
    fx.native.close();
  }
}, 30_000);

test("automatic full reconciliation downloads late historical rows even after an incremental hash acknowledgement", async () => {
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const config = configSchema.parse({
    environmentSlug: "reconcile",
    environmentName: "Reconcile",
  });
  const row = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../reporter/fixtures/tokscale-events.jsonl"),
      "utf8",
    ).split("\n")[0]!,
  );
  let history = [
    { ...row, dedup_key: "old", timestamp: clock - 2 * 86_400_000, cost: 1 },
  ];
  const server = await startLiveServer(config, {
    bind: "127.0.0.1",
    port: 0,
    deps: {
      now: () => clock,
      exporterCheck: async () => config.tokscalePin,
      exporterScan: async () =>
        history.map((r) => JSON.stringify(r)).join("\n"),
      usage: async () => [],
    },
  });
  const fx = mirrorFixture();
  try {
    await addDirectMachine(fx.db, server.url, { now: () => clock });
    await pullDirectFromMachines(fx.db, {
      now: () => clock,
    });
    clock += 60_000;
    history = [
      { ...history[0]!, cost: 2 },
      { ...row, dedup_key: "late", timestamp: clock - 3 * 86_400_000, cost: 3 },
    ];
    expect(
      (
        await pullDirectFromMachines(fx.db, {
          now: () => clock,
        })
      )[0]!.pulledEvents,
    ).toBe(0);
    clock += 86_400_001;
    expect(
      (
        await pullDirectFromMachines(fx.db, {
          now: () => clock,
        })
      )[0]!.pulledEvents,
    ).toBe(2);
    expect(
      await fx.db.getAllAsync("select cost from usage_events order by cost"),
    ).toEqual([{ cost: "2.000000" }, { cost: "3.000000" }]);
  } finally {
    server.stop();
    fx.native.close();
  }
});

test("a daily reconciliation of a machine whose history is unchanged costs one conditional request", async () => {
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const config = configSchema.parse({ environmentSlug: "idle", environmentName: "Idle" });
  const row = JSON.parse(
    readFileSync(join(import.meta.dir, "../../reporter/fixtures/tokscale-events.jsonl"), "utf8").split("\n")[0]!,
  );
  let history = Array.from({ length: 2500 }, (_, i) => ({
    ...row, dedup_key: `idle-${i}`, timestamp: clock - 5 * 86_400_000 + i,
  }));
  const requests: string[] = [];
  const server = await startLiveServer(config, {
    bind: "127.0.0.1",
    port: 0,
    deps: {
      now: () => clock,
      exporterCheck: async () => config.tokscalePin,
      exporterScan: async () => history.map((r) => JSON.stringify(r)).join("\n"),
      usage: async () => [],
    },
  });
  const fx = mirrorFixture();
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(String(input));
    return fetch(input, init);
  }) as typeof fetch;
  const pull = () => pullDirectFromMachines(fx.db, { now: () => clock, fetchImpl });
  const eventRequests = () => requests.filter((url) => url.includes("/live/events")).length;
  const eventWrites = () => fx.writes.filter((write) => write.sql.includes("insert into usage_events")).length;
  try {
    const machine = await addDirectMachine(fx.db, server.url, { now: () => clock });
    expect((await pull())[0]!.pulledEvents).toBe(2500);
    expect(eventRequests()).toBe(3);
    const fullAt = () => fx.db.getFirstAsync("select value from kv where key=?", [`direct_full_at_${machine.id}`]);
    expect(await fullAt()).toEqual({ value: String(clock) });

    // A day later nothing on the machine has changed: one 304, no rows written.
    clock += 86_400_001;
    const [requestsBefore, writesBefore] = [eventRequests(), eventWrites()];
    const [idle] = await pull();
    expect(idle).toMatchObject({ state: "live", pulledEvents: 0, hasMore: false });
    expect(eventRequests() - requestsBefore).toBe(1);
    expect(eventWrites()).toBe(writesBefore);
    // The reconciliation counts as done, so the next pull is incremental again.
    expect(await fullAt()).toEqual({ value: String(clock) });

    // A late correction changes the snapshot: the next reconciliation downloads it all.
    clock += 86_400_001;
    history = [...history.slice(1), { ...history[0]!, cost: 9 }, { ...row, dedup_key: "late", timestamp: clock - 9 * 86_400_000 }];
    expect((await pull())[0]!.pulledEvents).toBe(2);
    expect(await fx.db.getFirstAsync("select count(*) as n from usage_events")).toEqual({ n: 2501 });

    // An explicit full refresh never trusts a hash.
    const before = eventRequests();
    await pullDirectFromMachines(fx.db, { now: () => clock, fetchImpl, full: true });
    expect(eventRequests() - before).toBe(3);
  } finally {
    server.stop();
    fx.native.close();
  }
});

test("a daily reconciliation of an active machine downloads only from the earliest changed day", async () => {
  const DAY = 86_400_000;
  let clock = Date.parse("2026-10-01T12:00:00Z");
  const config = configSchema.parse({ environmentSlug: "active", environmentName: "Active" });
  const row = JSON.parse(
    readFileSync(join(import.meta.dir, "../../reporter/fixtures/tokscale-events.jsonl"), "utf8").split("\n")[0]!,
  );
  // 100 days of history, 40 rows a day.
  const day0 = Math.floor(clock / DAY) - 100;
  let history = Array.from({ length: 4000 }, (_, i) => ({
    ...row, dedup_key: `active-${i}`, timestamp: (day0 + Math.floor(i / 40)) * DAY + (i % 40) * 60_000,
  }));
  const requests: string[] = [];
  const server = await startLiveServer(config, {
    bind: "127.0.0.1",
    port: 0,
    deps: {
      now: () => clock,
      exporterCheck: async () => config.tokscalePin,
      exporterScan: async () => history.map((r) => JSON.stringify(r)).join("\n"),
      usage: async () => [],
    },
  });
  const fx = mirrorFixture();
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(String(input));
    return fetch(input, init);
  }) as typeof fetch;
  const pull = (options = {}) => pullDirectFromMachines(fx.db, { now: () => clock, fetchImpl, ...options });
  const sinceOf = (from: number) =>
    requests.slice(from).filter((url) => url.includes("/live/events")).map((url) => Number(new URL(url).searchParams.get("since")));
  const rowsWritten = () =>
    fx.writes.filter((write) => write.sql.includes("insert into usage_events")).reduce((sum, write) => sum + write.count / 27, 0);
  const count = async () => ((await fx.db.getFirstAsync("select count(*) as n from usage_events")) as { n: number }).n;
  try {
    const machine = await addDirectMachine(fx.db, server.url, { now: () => clock });
    await pull();
    expect(await count()).toBe(4000);
    const held = () => fx.db.getFirstAsync("select value from kv where key=?", [`direct_digests_${machine.id}`]);
    expect(Object.keys(JSON.parse(((await held()) as { value: string }).value))).toHaveLength(100);

    // Next day: today's usage, plus a price correction three days back.
    clock += DAY + 1;
    const today = Math.floor(clock / DAY);
    const corrected = history.findIndex((r) => Math.floor(r.timestamp / DAY) === today - 4);
    history = [
      ...history.map((r, i) => (i === corrected ? { ...r, cost: 7 } : r)),
      ...Array.from({ length: 25 }, (_, i) => ({ ...row, dedup_key: `new-${i}`, timestamp: today * DAY + i * 1000 })),
    ];
    let mark = requests.length;
    let written = rowsWritten();
    const [status] = await pull();
    // One row changed and 25 are new; the window opens on the corrected day.
    expect(status).toMatchObject({ state: "live", pulledEvents: 26, hasMore: false });
    expect(sinceOf(mark)).toEqual([(today - 4) * DAY]);
    // The three days of history from the corrected day on (yesterday had no
    // usage) plus today's rows, not the hundred days held.
    expect(rowsWritten() - written).toBe(3 * 40 + 25);
    expect(await count()).toBe(4025);
    expect(await fx.db.getFirstAsync("select cost from usage_events where cost = '7.000000'")).toEqual({ cost: "7.000000" });

    // A row that vanished from the machine opens the window at its day; the
    // phone keeps its history (reconciliation never deletes pruned sources).
    clock += DAY + 1;
    history = history.filter((r) => r.dedup_key !== "active-3990");
    mark = requests.length;
    await pull();
    expect(sinceOf(mark)).toEqual([Math.floor(history[3989]!.timestamp / DAY) * DAY]);
    expect(await count()).toBe(4025);

    // Nothing changed since: the next reconciliation is a single 304.
    clock += DAY + 1;
    mark = requests.length;
    written = rowsWritten();
    await pull();
    expect(sinceOf(mark)).toEqual([0]);
    expect(rowsWritten()).toBe(written);

    // An explicit full refresh ignores digests and starts from zero.
    mark = requests.length;
    await pull({ full: true });
    expect(new Set(sinceOf(mark))).toEqual(new Set([0]));
    expect(sinceOf(mark).length).toBeGreaterThan(3);
  } finally {
    server.stop();
    fx.native.close();
  }
});

test("digests from another snapshot than the pages are not kept, and an old reporter still reconciles in full", async () => {
  const { earliestChangedDayMs } = await import("@burn/sync-api");
  const DAY = 86_400_000;
  expect(earliestChangedDayMs(null, [[5, "a"]])).toBe(0);
  expect(earliestChangedDayMs({ "5": "a", "6": "b" }, [[5, "a"], [6, "b"]])).toBeNull();
  expect(earliestChangedDayMs({ "5": "a", "6": "b" }, [[5, "a"], [6, "c"], [7, "d"]])).toBe(6 * DAY);
  // A day only the phone holds, or only the machine has, counts as changed.
  expect(earliestChangedDayMs({ "4": "z", "5": "a" }, [[5, "a"]])).toBe(4 * DAY);
  expect(earliestChangedDayMs({ "5": "a" }, [[3, "y"], [5, "a"]])).toBe(3 * DAY);

  const fx = mirrorFixture();
  const { validateLiveApi } = await import("@burn/sync-api");
  const now = Date.parse("2026-10-01T12:00:00Z");
  const event = (key: string, day: number) => ({
    client: "codex", providerId: "openai", modelId: "gpt-5.2", sessionId: "s", sessionTitle: null,
    workspaceKey: null, workspaceLabel: null, agent: null, occurredAtMs: day * DAY + 5, sourceOffsetMinutes: 0,
    sourceTimezone: "UTC", sourceLocalDate: "2026-01-01", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, messageCount: 1, isTurnStart: false, durationMs: null,
    cost: "0.000001", costSource: "estimated" as const, costIsComplete: true, modelAttributionConflicted: false,
    parserVersion: "tokscale-4.21.0", dedupKey: key,
  });
  const today = Math.floor(now / DAY);
  let digestSnapshot = "snap-1";
  let advertise = true;
  const sinceSeen: (number | null)[] = [];
  const api = validateLiveApi({
    ping: async () => ({
      protocol: 1, slug: "win", displayName: "Win", hostGroup: null, osKind: "windows", reporterVersion: "0.1.0",
      tokscaleVersion: "4.21.0", exportSchema: 1, reportingTimezone: "UTC", sinceMs: 0, serverNowMs: now,
      capabilities: advertise ? ["day-digests"] : [],
    }),
    quotas: async () => ({ generatedAt: new Date(now).toISOString(), quotas: [] }),
    digests: async () => ({
      snapshotId: digestSnapshot, contentHash: "h", generatedAt: new Date(now).toISOString(),
      days: [[today - 1, "d1"], [today, "d2"]],
    }),
    events: async (since: number | null) => {
      sinceSeen.push(since);
      return {
        slug: "win", sinceMs: since, generatedAt: new Date(now).toISOString(), scanStartedAtMs: now,
        snapshotId: "snap-1", contentHash: "h", nextCursor: null,
        events: [event("a", today - 1), event("b", today)].filter((e) => e.occurredAtMs >= (since ?? 0)),
      };
    },
  });
  const kv = async (key: string) =>
    ((await fx.db.getFirstAsync("select value from kv where key=?", [key])) as { value: string } | null)?.value ?? null;
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api, now: () => now });

  // The machine rescanned between the digest list and the first page.
  digestSnapshot = "snap-0";
  await pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => now });
  expect(await kv("direct_digests_direct-win")).toBeNull();
  expect(await kv("direct_digests_pending_direct-win")).toBeNull();
  expect(await kv("direct_full_hash_direct-win")).toBe("h");

  // Same snapshot: kept. Removing the machine forgets them.
  digestSnapshot = "snap-1";
  await pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => now, full: true });
  expect(JSON.parse((await kv("direct_digests_direct-win"))!)).toEqual({ [today - 1]: "d1", [today]: "d2" });

  // A reporter without the capability is never asked and reconciles from zero.
  advertise = false;
  sinceSeen.length = 0;
  await pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => now + DAY + 1 });
  expect(sinceSeen).toEqual([0]);

  const { removeDirectMachine } = await import("../src/lib/direct");
  await removeDirectMachine(fx.db, "direct-win");
  expect(await kv("direct_digests_direct-win")).toBeNull();
});
