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
