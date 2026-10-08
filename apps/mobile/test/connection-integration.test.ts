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
