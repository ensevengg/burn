/** A machine whose clock ran ahead and was then corrected (dual-boot RTC,
 * NTP) must not leave the mirror stuck behind its bad timestamps. */
import { expect, test } from "bun:test";
import { queryQuotas } from "../src/data/repository";
import { mirrorFixture } from "./mirror-fixture";
import {
  addDirectMachine,
  pullDirectFromMachines,
} from "../src/lib/direct";
import {
  LiveError,
  type LiveApi,
  type LivePing,
  type MachineEventInput,
} from "@burn/sync-api";

const HOUR = 3_600_000;

function row(over: Partial<MachineEventInput> = {}): MachineEventInput {
  return {
    client: "codex", providerId: "openai", modelId: "gpt-5.2", sessionId: "s1",
    sessionTitle: null, workspaceKey: null, workspaceLabel: null, agent: null,
    occurredAtMs: 0, sourceOffsetMinutes: 0, sourceTimezone: "UTC", sourceLocalDate: "2026-01-01",
    inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    messageCount: 1, isTurnStart: true, durationMs: 1, cost: "0.000100", costSource: "estimated",
    costIsComplete: true, modelAttributionConflicted: false, parserVersion: "tokscale-4.21.0",
    dedupKey: "k", ...over,
  };
}
function ping(serverNowMs: number, over: Partial<LivePing> = {}): LivePing {
  return {
    protocol: 1, slug: "win", displayName: "Win", hostGroup: null, osKind: "linux",
    reporterVersion: "0.1.0", tokscaleVersion: "4.21.0", exportSchema: 1,
    reportingTimezone: "UTC", sinceMs: 0, serverNowMs, ...over,
  };
}

test("a clock rollback discards a saved incremental window instead of skipping rows", async () => {
  const fx = mirrorFixture();
  // Machine clock was 2 days ahead (F), then NTP corrected it to real time R.
  const real0 = Date.UTC(2026, 10, 10, 0, 0, 0);
  const F = real0 - 2 * HOUR + 48 * HOUR;
  let serverNow = F;
  let snapshotEvents: MachineEventInput[] = [row({ occurredAtMs: F - 2 * HOUR, dedupKey: "old" })];
  let snapshot = { id: "snap-a", startedAtMs: F };
  const expired = new Set<string>();
  const seen: { since: number | null; cursor?: string }[] = [];
  const api: LiveApi = {
    ping: async () => ping(serverNow),
    quotas: async () => ({ generatedAt: new Date(serverNow).toISOString(), quotas: [] }),
    events: async (since, _signal, page = {}) => {
      seen.push({ since, ...(page.cursor ? { cursor: page.cursor } : {}) });
      if (page.cursor && expired.has(page.cursor.split(":")[0]!)) throw new LiveError("snapshot expired", 410);
      const window = snapshotEvents.filter((e) => e.occurredAtMs >= (since ?? 0)).sort((a, b) => b.occurredAtMs - a.occurredAtMs);
      const offset = page.cursor ? Number(page.cursor.split(":")[2]) : 0;
      const limit = 1; // one row per page to force a multi-page window
      const events = window.slice(offset, offset + limit);
      const next = offset + events.length < window.length ? `${snapshot.id}:${since}:${offset + events.length}:desc` : null;
      return {
        slug: "win", sinceMs: since, generatedAt: new Date(snapshot.startedAtMs).toISOString(),
        scanStartedAtMs: snapshot.startedAtMs, snapshotId: snapshot.id, events, nextCursor: next,
      };
    },
  };
  // Phone clock is correct real time throughout; only the machine clock was 48h ahead.
  let phoneNow = real0 - 2 * HOUR;
  const opts = { apiFor: () => api, now: () => phoneNow };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  // First pull: full reconciliation completes; cursor = F.
  await pullDirectFromMachines(fx.db, opts);
  expect(fx.native.query("select value from kv where key='direct_since_v3_direct-win'").get()).toEqual({ value: String(F) });

  // An incremental window with two rows spans passes (maxPages 1) -> saved progress.
  serverNow = F + 10 * 60_000;
  phoneNow = real0 - 2 * HOUR + 10 * 60_000;
  snapshotEvents.push(row({ occurredAtMs: F + 1 * 60_000, dedupKey: "n1" }), row({ occurredAtMs: F + 2 * 60_000, dedupKey: "n2" }));
  snapshot = { id: "snap-b", startedAtMs: serverNow };
  await pullDirectFromMachines(fx.db, { ...opts, maxPages: 1 });
  const saved = fx.native.query("select value from kv where key='direct_backfill_direct-win'").get() as { value: string } | null;
  expect(saved).not.toBeNull();
  expect(JSON.parse(saved!.value).reconciliation).toBe(false);

  // Machine clock corrected back to real time (rollback of ~2 days). Reporter
  // restarted (snapshot b expired). Usage continues at real time for 5 hours.
  const R = real0 + 5 * HOUR;
  serverNow = R;
  phoneNow = R;
  expired.add("snap-b");
  snapshotEvents = [
    ...snapshotEvents,
    row({ occurredAtMs: real0 + 1 * HOUR, dedupKey: "after-1h" }),
    row({ occurredAtMs: real0 + 2 * HOUR, dedupKey: "after-2h" }),
    row({ occurredAtMs: real0 + 3 * HOUR, dedupKey: "after-3h" }),
    row({ occurredAtMs: real0 + 4.5 * HOUR, dedupKey: "after-4.5h" }),
  ];
  snapshot = { id: "snap-c", startedAtMs: R };
  const s1 = await pullDirectFromMachines(fx.db, opts);
  // Next regular pass: is rollback still detected?
  serverNow = R + 60_000;
  phoneNow = R + 60_000;
  snapshot = { id: "snap-d", startedAtMs: serverNow };
  await pullDirectFromMachines(fx.db, opts);
  const keys = (fx.native.query("select count(*) as n from usage_events").get() as { n: number }).n;
  expect(keys).toBe(snapshotEvents.length);
});

test("health samples taken on the wrong clock are dropped after a rollback", async () => {
  const fx = mirrorFixture();
  const phoneNow = Date.UTC(2026, 10, 10, 12, 0, 0);
  let serverNow = phoneNow + 2 * HOUR; // machine clock 2h ahead
  let samples = [{ capturedAtMs: serverNow - 30_000 }, { capturedAtMs: serverNow }];
  const sinceSeen: number[] = [];
  const api: LiveApi = {
    ping: async () => ping(serverNow),
    quotas: async () => ({ generatedAt: new Date(serverNow).toISOString(), quotas: [] }),
    events: async (since) => ({ sinceMs: since, generatedAt: new Date(serverNow).toISOString(), scanStartedAtMs: serverNow, events: [] }),
    metrics: async (since) => {
      sinceSeen.push(since);
      return {
        generatedAt: new Date(serverNow).toISOString(),
        metrics: samples.filter((s) => s.capturedAtMs >= since).map((s) => ({
          capturedAtMs: s.capturedAtMs, cpuLoadPct: 99, cpuTempC: null, ramUsedPct: 99, ramTempC: null, gpuUtilPct: null, gpuTempC: null,
        })),
      };
    },
  };
  await addDirectMachine(fx.db, "http://win", { apiFor: () => api });
  await pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => phoneNow });
  // NTP fixes the machine clock; new samples are at real time.
  serverNow = phoneNow + 60_000;
  samples = [{ capturedAtMs: phoneNow }, { capturedAtMs: phoneNow + 30_000 }, { capturedAtMs: phoneNow + 60_000 }];
  await pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => phoneNow + 60_000 });
  await pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => phoneNow + 90_000 });
  const latest = fx.native.query("select max(captured_at_ms) as at from machine_metrics").get() as { at: number };
  expect(latest.at).toBe(phoneNow + 60_000);
});

test("quotas keep updating after a machine clock is corrected backwards", async () => {
  const fx = mirrorFixture();
  const real = Date.UTC(2026, 10, 10, 12, 0, 0);
  let serverNow = real + 5.5 * HOUR; // booted from Windows: RTC in local time, clock 5h30 ahead
  let used = 10;
  const api: LiveApi = {
    ping: async () => ping(serverNow, { slug: "cachy", displayName: "Cachy" }),
    events: async (since) => ({ sinceMs: since, generatedAt: new Date(serverNow).toISOString(), scanStartedAtMs: serverNow, events: [] }),
    quotas: async () => ({ generatedAt: new Date(serverNow).toISOString(), quotas: [
      { provider: "claude", accountKey: "a", accountLabel: null, plan: null, metric: "5h", usedPercent: used,
        remainingPercent: null, remainingLabel: null, resetsAt: null, creditStatus: null, spendControl: null,
        status: "ok", error: null, sourceOffsetMinutes: 0 },
    ] }),
  };
  await addDirectMachine(fx.db, "http://cachy", { apiFor: () => api });
  await pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => real });
  // NTP corrects the clock; usage climbs.
  serverNow = real + 10 * 60_000;
  used = 80;
  const [status] = await pullDirectFromMachines(fx.db, { apiFor: () => api, now: () => real + 10 * 60_000 });
  const cards = await queryQuotas(fx.db);
  expect(cards[0]!.usedPercent).toBe(80);
});

test("a machine whose clock runs ahead cannot outrank a correct machine's fresher quota", async () => {
  const fx = mirrorFixture();
  const real = Date.UTC(2026, 10, 10, 12, 0, 0);
  const quota = (used: number) => ({
    provider: "claude", accountKey: "a", accountLabel: null, plan: null, metric: "5h", usedPercent: used,
    remainingPercent: null, remainingLabel: null, resetsAt: null, creditStatus: null, spendControl: null,
    status: "ok" as const, error: null, sourceOffsetMinutes: 0,
  });
  // CachyOS booted 5h30 ahead; Windows on the same account has a correct clock.
  const machine = (slug: string, aheadMs: number, used: () => number): LiveApi => ({
    ping: async () => ping(clock + aheadMs, { slug, displayName: slug }),
    events: async (since) => ({ sinceMs: since, generatedAt: new Date(clock + aheadMs).toISOString(), scanStartedAtMs: clock + aheadMs, events: [] }),
    quotas: async () => ({ generatedAt: new Date(clock + aheadMs).toISOString(), quotas: [quota(used())] }),
  });
  let clock = real;
  let windowsUsed = 35;
  const apis: Record<string, LiveApi> = {
    "http://cachy": machine("cachy", 5.5 * HOUR, () => 10),
    "http://windows": machine("windows", 0, () => windowsUsed),
  };
  const apiFor = (endpoint: string) => apis[endpoint]!;
  await addDirectMachine(fx.db, "http://cachy", { apiFor });
  await pullDirectFromMachines(fx.db, { apiFor, now: () => clock });
  // Stored on the phone's clock, not five and a half hours from now.
  expect(await fx.db.getFirstAsync("select fetched_at from quota_snapshots")).toEqual({ fetched_at: new Date(real).toISOString() });

  // The box reboots into Windows; CachyOS is never pulled again.
  delete apis["http://cachy"];
  apis["http://cachy"] = { ...machine("cachy", 0, () => 10), ping: async () => { throw new Error("offline"); } };
  await addDirectMachine(fx.db, "http://windows", { apiFor });
  for (const used of [35, 60, 85]) {
    clock += HOUR;
    windowsUsed = used;
    await pullDirectFromMachines(fx.db, { apiFor, now: () => clock });
    expect((await queryQuotas(fx.db))[0]!.usedPercent).toBe(used);
  }
});

test("a reading stamped in the future by an older app version ranks behind plausible ones", async () => {
  const fx = mirrorFixture();
  const insert = (key: string, used: number, fetchedAt: string) =>
    fx.native.query(
      `insert into quota_snapshots (row_key, environment_id, provider, account_key, metric, used_percent, status, fetched_at)
       values (?, ?, 'claude', 'a', '5h', ?, 'ok', ?)`,
    ).run(key, key, used, fetchedAt);
  insert("ahead", 10, new Date(Date.now() + 5 * HOUR).toISOString());
  expect((await queryQuotas(fx.db))[0]!.usedPercent).toBe(10);
  insert("correct", 80, new Date(Date.now() - 60_000).toISOString());
  expect((await queryQuotas(fx.db)).map((card) => card.usedPercent)).toEqual([80]);
});
