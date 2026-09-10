import { expect, test } from "bun:test";
import { TOKSCALE_PIN, type ReporterSyncApi } from "@burn/sync-api";
import { configSchema } from "../src/config";
import { usageReportSchema } from "../src/tokscale";
import { pushMachineData } from "../src/commands";

test("machine push uploads quotas while the event exporter is slow or failing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploaded!: () => void;
  const quotaUpload = new Promise<void>((resolve) => {
    uploaded = resolve;
  });
  const reporter: ReporterSyncApi = {
    heartbeat: async () => ({ environmentId: "windows", slug: "windows" }),
    reportError: async () => {},
    ingestEvents: async () => ({ revision: 0, changed: 0 }),
    pushQuotaSnapshots: async (rows) => {
      expect(rows[0]?.accountKey).toBe("shared-account");
      uploaded();
      return { snapshots: rows.length };
    },
    pushMachineMetrics: async (rows) => ({ samples: rows.length }),
    pollSyncRequests: async () => ({ requests: [], latestRevision: 0 }),
  };
  const config = configSchema.parse({
    supabaseUrl: "https://example.invalid",
    publishableKey: "test-public-key",
    ingestToken: "test-token-not-a-real-secret",
    environmentSlug: "windows",
    environmentName: "Windows",
    tokscalePin: TOKSCALE_PIN,
  });
  const pending = pushMachineData(config, reporter, false, {
    events: async () => {
      await gate;
      throw new Error("exporter unavailable");
    },
    quotas: async () =>
      usageReportSchema.parse([
        {
          provider: "Codex",
          account: { id: "shared-account" },
          metrics: [{ label: "Weekly", used_percent: 50, remaining_percent: 50 }],
        },
      ]),
    metrics: async () => ({
      capturedAtMs: 1,
      cpuLoadPct: 10,
      cpuTempC: null,
      ramUsedPct: 50,
      ramTempC: null,
      gpuUtilPct: null,
      gpuTempC: null,
    }),
  });
  const rejection = pending.then(
    () => null,
    (err: Error) => err,
  );
  try {
    await quotaUpload;
  } finally {
    release();
  }
  expect((await rejection)?.message).toContain("exporter unavailable");
});

test("machine push uploads one system-health sample", async () => {
  let samples = 0;
  const reporter: ReporterSyncApi = {
    heartbeat: async () => ({ environmentId: "windows", slug: "windows" }),
    reportError: async () => {},
    ingestEvents: async () => ({ revision: 0, changed: 0 }),
    pushQuotaSnapshots: async () => ({ snapshots: 0 }),
    pushMachineMetrics: async (rows) => { samples += rows.length; return { samples: rows.length }; },
    pollSyncRequests: async () => ({ requests: [], latestRevision: 0 }),
  };
  const config = configSchema.parse({
    supabaseUrl: "https://example.invalid", publishableKey: "test-public-key", ingestToken: "x".repeat(32),
    environmentSlug: "windows", environmentName: "Windows", osKind: "windows", tokscalePin: TOKSCALE_PIN,
  });
  await pushMachineData(config, reporter, false, {
    events: async () => ({ rows: 0, changed: 0, revision: 0, batches: 0 }),
    quotas: async () => [],
    metrics: async () => ({ capturedAtMs: 1, cpuLoadPct: 1, cpuTempC: null,
      ramUsedPct: 50, ramTempC: 40, gpuUtilPct: 10, gpuTempC: 50 }),
  });
  expect(samples).toBe(1);
  await pushMachineData({ ...config, osKind: "wsl" }, reporter, false, {
    events: async () => ({ rows: 0, changed: 0, revision: 0, batches: 0 }),
    quotas: async () => [],
    metrics: async () => { throw new Error("WSL must not sample hardware"); },
  });
  expect(samples).toBe(1);
});
