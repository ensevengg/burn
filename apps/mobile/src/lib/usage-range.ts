import type { Granularity } from "./format";

export type UsageRangeId = "1" | "7" | "30" | "90" | "365" | "all";
export type UsageWindowDays = number | null;

export interface UsageRange {
  label: string;
  value: UsageRangeId;
  days: UsageWindowDays;
  granularity: Granularity;
}

export const USAGE_RANGES: Record<UsageRangeId, UsageRange> = {
  "1": { label: "Past 24h", value: "1", days: 1, granularity: "daily" },
  "7": { label: "7d", value: "7", days: 7, granularity: "daily" },
  "30": { label: "30d", value: "30", days: 30, granularity: "daily" },
  "90": { label: "90d", value: "90", days: 90, granularity: "daily" },
  "365": { label: "1y", value: "365", days: 365, granularity: "monthly" },
  all: { label: "All", value: "all", days: null, granularity: "yearly" },
};

export const DASHBOARD_RANGES = [USAGE_RANGES["1"], USAGE_RANGES["7"], USAGE_RANGES["30"], USAGE_RANGES["90"], USAGE_RANGES.all] as const;
export const EXPLORE_RANGES = [USAGE_RANGES["7"], USAGE_RANGES["30"], USAGE_RANGES["365"], USAGE_RANGES.all] as const;

export function usageWindowStart(days: UsageWindowDays, now = Date.now()): number {
  return days === null ? 0 : now - days * 86_400_000;
}
