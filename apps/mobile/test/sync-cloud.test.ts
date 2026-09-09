import { expect, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import type { MobileSyncApi, QuotaSnapshot, UsageEvent } from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";
import { pullCloud } from "../src/lib/sync-cloud";
import { followMachineUpdates } from "../src/lib/refresh";
import {
  queryQuotas,
  querySessions,
  queryGranularityMax,
  invalidateEventCache,
  removeEnvironmentLocal,
  queryModels,
  queryWindowOverview,
} from "../src/data/repository";
import { generateDemoDataset } from "../src/data/demo-generator";
import { mirrorFixture } from "./mirror-fixture";

const quota: QuotaSnapshot = {
  environmentId: "windows",
  provider: "Codex",
  accountKey: "one",
  accountLabel: "Personal",
  plan: null,
  metric: "weekly",
  usedPercent: 50,
  remainingPercent: 50,
  remainingLabel: null,
  resetsAt: null,
  creditStatus: null,
  spendControl: null,
  status: "ok",
  error: null,
  fetchedAt: "2026-09-06T12:00:00Z",
  sourceOffsetMinutes: 330,
};
const phone = (overrides: Partial<MobileSyncApi> = {}): MobileSyncApi => ({
  fetchDelta: async () => ({ cursorVersion: 2, environments: [], events: [], maxRevision: 0, hasMore: false }),
  fetchQuotaLatest: async () => [quota],
  requestSync: async () => ({ generation: 1 }),
  removeEnvironment: async () => ({ removedSlug: "windows" }),
  ...overrides,
});
const event = generateDemoDataset().events[0]!;
const usage = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  ...event,
  environmentId: "windows",
  revision: 1,
  ...overrides,
});

test("a failed event download does not prevent the newer Windows quota from rendering", async () => {
  const fixture = mirrorFixture();
  try {
    const changes: string[] = [];
    await expect(
      pullCloud(
        fixture.db,
        phone({
          fetchDelta: async () => {
            throw new Error("events offline");
          },
        }),
        undefined,
        (kind) => changes.push(kind),
      ),
    ).rejects.toThrow("events offline");
    expect(changes).toEqual(["quotas"]);
    expect((await queryQuotas(fixture.db))[0]?.usedPercent).toBe(50);
  } finally {
    fixture.native.close();
  }
});

test("quotas commit before a slow event download finishes", async () => {
  const fixture = mirrorFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let published!: () => void;
  const publication = new Promise<void>((resolve) => {
    published = resolve;
  });
  const pending = pullCloud(
    fixture.db,
    phone({
      fetchDelta: async () => {
        await gate;
        return { cursorVersion: 2, environments: [], events: [], maxRevision: 0, hasMore: false };
      },
    }),
    undefined,
    (kind) => {
      if (kind === "quotas") published();
    },
  );
  try {
    await publication;
    expect((await queryQuotas(fixture.db))[0]?.accountKey).toBe("one");
  } finally {
    release();
    await pending;
    fixture.native.close();
  }
});

test("cloud inserts use large bound batches, preserve decimals, and stay idempotent", async () => {
  const fixture = mirrorFixture();
  const events = Array.from({ length: 401 }, (_, i) =>
    usage({ eventId: `e${i}`, cost: "0.123456", sessionTitle: "O'Brien ?" }),
  );
  const api = phone({
    fetchDelta: async () => ({ cursorVersion: 2, environments: [], events, maxRevision: 1, hasMore: false }),
  });
  try {
    await pullCloud(fixture.db, api);
    const inserts = fixture.writes.filter((w) => w.sql.includes("insert or replace into usage_events"));
    expect(inserts).toHaveLength(2);
    expect(Math.max(...inserts.map((w) => w.count))).toBe(11_200);
    expect(fixture.native.query("select cost, session_title from usage_events limit 1").get()).toEqual({
      cost: "0.123456",
      session_title: "O'Brien ?",
    });
    await pullCloud(fixture.db, api);
    expect(fixture.native.query("select count(*) as n from usage_events").get()).toEqual({ n: 401 });
    expect(fixture.native.query("select value from kv where key='watermark_sync_revision_v2'").get()).toEqual({
      value: "1",
    });
  } finally {
    fixture.native.close();
  }
});

test("All includes old usage and one model card combines providers and clients", async () => {
  const fixture = mirrorFixture();
  const old = Date.UTC(1999, 0, 1);
  const events = [
    usage({ eventId: "codex-sol", modelId: "gpt-5.6-sol", providerId: "openai-codex", client: "codex", occurredAtMs: old, inputTokens: 100_000_000, outputTokens: 1 }),
    usage({ eventId: "pi-sol", environmentId: "wsl", modelId: "gpt-5.6-sol", providerId: "openai", client: "pi", occurredAtMs: old, inputTokens: 200_000_000, outputTokens: 2 }),
  ];
  try {
    await pullCloud(fixture.db, phone({ fetchDelta: async () => ({ cursorVersion: 2, environments: [], events, maxRevision: 2, hasMore: false }) }));
    expect((await queryWindowOverview(fixture.db, "UTC", 90, "tokens")).totals.inputTokens).toBe(0);
    expect((await queryWindowOverview(fixture.db, "UTC", null, "tokens", "yearly")).totals.inputTokens).toBe(300_000_000);
    const models = await queryModels(fixture.db, null, null);
    expect(models).toHaveLength(1);
    expect(models[0]?.providers).toEqual(["openai", "openai-codex"]);
    expect(models[0]?.clients).toEqual(["codex", "pi"]);
  } finally {
    fixture.native.close();
  }
});

test("legacy cloud cursor is ignored and an old backend cannot poison the v2 cursor", async () => {
  const fixture = mirrorFixture();
  await fixture.db.runAsync("insert into kv (key, value) values ('watermark_revision', '999')");
  const seen: number[] = [];
  try {
    await expect(pullCloud(fixture.db, phone({ fetchDelta: async (since) => {
      seen.push(since);
      return { cursorVersion: 1, environments: [], events: [], maxRevision: 999, hasMore: false };
    } }))).rejects.toThrow("migration 0008");
    expect(seen).toEqual([0]);
    expect(fixture.native.query("select value from kv where key='watermark_sync_revision_v2'").get()).toBeNull();
  } finally {
    fixture.native.close();
  }
});

test("failed page rolls back its events and watermark while quotas survive", async () => {
  const fixture = mirrorFixture();
  fixture.native.exec(
    "create trigger fail_event before insert on usage_events when NEW.event_id='bad' begin select raise(abort, 'bad event'); end",
  );
  const events = Array.from({ length: 33 }, (_, i) => usage({ eventId: i === 32 ? "bad" : `e${i}` }));
  try {
    await expect(
      pullCloud(
        fixture.db,
        phone({ fetchDelta: async () => ({ cursorVersion: 2, environments: [], events, maxRevision: 1, hasMore: false }) }),
      ),
    ).rejects.toThrow("bad event");
    expect(fixture.native.query("select count(*) as n from usage_events").get()).toEqual({ n: 0 });
    expect(fixture.native.query("select value from kv where key='watermark_revision'").get()).toBeNull();
    expect(await queryQuotas(fixture.db)).toHaveLength(1);
  } finally {
    fixture.native.close();
  }
});

test("cancelled backend responses cannot write into a reset mirror", async () => {
  const fixture = mirrorFixture();
  let active = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = pullCloud(
    fixture.db,
    phone({
      fetchQuotaLatest: async () => {
        started();
        await gate;
        return [quota];
      },
      fetchDelta: async () => {
        await gate;
        return { cursorVersion: 2, environments: [], events: [], maxRevision: 0, hasMore: false };
      },
    }),
    () => {
      if (!active) throw new Error("cancelled");
    },
  );
  const result = pending.then(
    () => null,
    (err: Error) => err,
  );
  try {
    await downloading;
    active = false;
    release();
    expect((await result)?.message).toBe("cancelled");
    expect(fixture.writes).toHaveLength(0);
  } finally {
    release();
    await result;
    fixture.native.close();
  }
});

test("follow-up captures a daemon update after 30 seconds and stops on cancellation", async () => {
  let now = 0;
  let displayed = 20;
  const controller = new AbortController();
  const times: number[] = [];
  let settles = 0;
  await followMachineUpdates(
    controller.signal,
    async () => {
      times.push(now);
      if (now >= 35_000) displayed = 50;
    },
    {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      onSettle: () => {
        settles++;
      },
    },
  );
  expect(displayed).toBe(50);
  expect(times.at(-1)).toBe(120_000);
  expect(settles).toBe(1);
  now = 0;
  let pulls = 0;
  await followMachineUpdates(
    controller.signal,
    async () => {
      pulls++;
    },
    {
      now: () => now,
      wait: async () => {
        controller.abort();
      },
    },
  );
  expect(pulls).toBe(1);
  // A request cancelled before any pull (reset, disconnect) still releases
  // the refresh spinner exactly once.
  let latePulls = 0;
  let lateSettles = 0;
  const dead = new AbortController();
  dead.abort();
  await followMachineUpdates(
    dead.signal,
    async () => {
      latePulls++;
    },
    { onSettle: () => lateSettles++ },
  );
  expect(latePulls).toBe(0);
  expect(lateSettles).toBe(1);
});

test("machine removal evicts the event cache after its delete commits, not before", async () => {
  const fixture = mirrorFixture();
  // Noon UTC keeps both events in one calendar day regardless of run time.
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  const events = [
    usage({ eventId: "w", sessionId: "s-w", environmentId: "windows", occurredAtMs: noon.getTime() - 1000 }),
    usage({ eventId: "c", sessionId: "s-c", environmentId: "cachyos", occurredAtMs: noon.getTime() - 2000 }),
  ];
  try {
    await pullCloud(
      fixture.db,
      phone({ fetchDelta: async () => ({ cursorVersion: 2, environments: [], events, maxRevision: 1, hasMore: false }) }),
    );
    const first = await queryGranularityMax(fixture.db, "UTC", "daily");
    expect(first).toBeGreaterThan(0);
    // Hold the usage_events delete open while a read races it and caches
    // pre-delete rows; only a post-commit eviction can unstick the cache.
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const gated = {
      ...fixture.db,
      runAsync: (sql: string, params: SQLQueryBindings[] = []) =>
        sql.startsWith("delete from usage_events")
          ? deleteGate.then(() => fixture.db.runAsync(sql, params))
          : fixture.db.runAsync(sql, params),
    } as unknown as SQLiteDatabase;
    const pending = removeEnvironmentLocal(gated, "windows");
    const racing = await queryGranularityMax(gated, "UTC", "daily");
    expect(racing).toBe(first);
    releaseDelete();
    await pending;
    expect(await queryGranularityMax(gated, "UTC", "daily")).toBe(first / 2);
  } finally {
    fixture.native.close();
  }
});

test("session limit applies before decoding and identities include the machine", async () => {
  const fixture = mirrorFixture();
  const now = Date.now();
  const events = Array.from({ length: 100 }, (_, i) =>
    usage({ eventId: `old${i}`, sessionId: `old${i}`, occurredAtMs: now - 100_000 - i }),
  );
  events.push(
    usage({ eventId: "w", sessionId: "shared", environmentId: "windows", occurredAtMs: now - 1, cost: "2" }),
  );
  events.push(
    usage({ eventId: "c", sessionId: "shared", environmentId: "cachyos", occurredAtMs: now - 2, cost: "3" }),
  );
  try {
    await pullCloud(
      fixture.db,
      phone({ fetchDelta: async () => ({ cursorVersion: 2, environments: [], events, maxRevision: 1, hasMore: false }) }),
    );
    const rows = await querySessions(fixture.db, 7, null, 2);
    expect(rows.map((r) => [r.environmentId, r.cost])).toEqual([
      ["windows", 2],
      ["cachyos", 3],
    ]);
    expect(fixture.readRows).toBe(2);
    expect(rows[0]!.key).not.toBe(rows[1]!.key);
  } finally {
    fixture.native.close();
  }
});

test("historical queries share decoding, yield to input, and reload after mirror changes", async () => {
  const fixture = mirrorFixture();
  const events = Array.from({ length: 1024 }, (_, i) =>
    usage({
      eventId: `e${i}`,
      occurredAtMs: Date.now() - i * 60_000,
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    }),
  );
  try {
    await pullCloud(
      fixture.db,
      phone({ fetchDelta: async () => ({ cursorVersion: 2, environments: [], events, maxRevision: 1, hasMore: false }) }),
    );
    let inputHandled = false;
    const pending = queryGranularityMax(fixture.db, "UTC", "yearly");
    setTimeout(() => {
      inputHandled = true;
    }, 0);
    const values = await Promise.all([pending, queryGranularityMax(fixture.db, "UTC", "yearly", "cost")]);
    expect(inputHandled).toBe(true);
    expect(values[0]).toBe(1024);
    expect(fixture.readRows).toBe(1024);
    fixture.native.exec("update usage_events set input_tokens=2");
    invalidateEventCache(fixture.db);
    expect(await queryGranularityMax(fixture.db, "UTC", "yearly")).toBe(2048);
  } finally {
    fixture.native.close();
  }
});
