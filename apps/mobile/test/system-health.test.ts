import { describe, expect, test } from "bun:test";
import type { EnvironmentRow } from "../src/data/repository";
import { latestQuotaAt, reporterIssue, REPORTER_STALE_AFTER_MS } from "../src/lib/system-health";

const NOW = Date.parse("2026-09-09T12:00:00Z");

function machine(overrides: Partial<EnvironmentRow> = {}): EnvironmentRow {
  return {
    id: "env-1",
    slug: "windows",
    displayName: "Windows",
    hostGroup: null,
    osKind: "windows",
    tokscaleVersion: "4.15.1",
    reporterVersion: "0.1.0",
    lastHeartbeatAt: new Date(NOW - 60_000).toISOString(),
    lastSuccessAt: new Date(NOW - 60_000).toISOString(),
    lastError: null,
    latestRevision: 4,
    directInitialSyncComplete: true,
    ...overrides,
  };
}

describe("reporterIssue", () => {
  test("reports explicit, initial-sync, probe, quota, and stale-heartbeat failures", () => {
    expect(reporterIssue(machine({ lastError: "export failed" }), undefined, NOW)).toBe("export failed");
    expect(reporterIssue(machine({ directInitialSyncComplete: false }), undefined, NOW)).toContain("incomplete");
    expect(
      reporterIssue(
        machine(),
        {
          environmentId: "env-1",
          slug: "windows",
          endpoint: "http://windows:8787",
          state: "offline",
          pulledEvents: 0,
          clockSkewMs: null,
          error: "unreachable",
          elapsedMs: 10,
        },
        NOW,
      ),
    ).toBe("unreachable");
    expect(
      reporterIssue(
        machine(),
        {
          environmentId: "env-1",
          slug: "windows",
          endpoint: "http://windows:8787",
          state: "live",
          pulledEvents: 1,
          pulledQuotas: 0,
          quotaError: "quota timeout",
          clockSkewMs: 0,
          error: null,
          elapsedMs: 10,
          initialSyncComplete: true,
        },
        NOW,
      ),
    ).toContain("quota timeout");
    expect(
      reporterIssue(
        machine({ lastHeartbeatAt: new Date(NOW - REPORTER_STALE_AFTER_MS - 1).toISOString() }),
        undefined,
        NOW,
      ),
    ).toContain("stale");
  });

  test("returns null for a fresh, error-free reporter", () => {
    expect(reporterIssue(machine(), undefined, NOW)).toBeNull();
  });
});

test("latestQuotaAt ignores invalid dates and returns the newest snapshot", () => {
  expect(
    latestQuotaAt([
      { fetchedAt: "invalid" },
      { fetchedAt: "2026-09-09T10:00:00Z" },
      { fetchedAt: "2026-09-09T11:00:00Z" },
    ]),
  ).toBe("2026-09-09T11:00:00Z");
  expect(latestQuotaAt([])).toBeNull();
});
