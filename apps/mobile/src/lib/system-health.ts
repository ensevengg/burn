import type { EnvironmentRow } from "../data/repository";
import { formatRelative } from "./format";
import type { DirectPullStatus } from "./direct";
import type { LivePullStatus } from "./live";

export const REPORTER_STALE_AFTER_MS = 30 * 60_000;

export type ProbeStatus = LivePullStatus | DirectPullStatus | undefined;

/** One actionable reporter problem, ordered from explicit failure to staleness. */
export function reporterIssue(
  machine: EnvironmentRow,
  probe: ProbeStatus,
  now = Date.now(),
): string | null {
  if (machine.lastError !== null) return machine.lastError;
  if (machine.directInitialSyncComplete === false) return "Initial history sync is incomplete.";
  if (probe !== undefined && probe.state !== "live") return probe.error ?? `Live probe ${probe.state}.`;
  if (probe !== undefined && "quotaError" in probe && probe.quotaError !== null) {
    return `Quota refresh failed: ${probe.quotaError}`;
  }
  if (machine.lastHeartbeatAt === null) return "No reporter heartbeat received yet.";
  const heartbeatAt = Date.parse(machine.lastHeartbeatAt);
  if (!Number.isNaN(heartbeatAt) && now - heartbeatAt > REPORTER_STALE_AFTER_MS) {
    return `Reporter heartbeat is stale (${formatRelative(machine.lastHeartbeatAt, now)}).`;
  }
  return null;
}

export function latestQuotaAt(quotas: readonly { fetchedAt: string }[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const quota of quotas) {
    const parsed = Date.parse(quota.fetchedAt);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latest = quota.fetchedAt;
      latestMs = parsed;
    }
  }
  return latest;
}
