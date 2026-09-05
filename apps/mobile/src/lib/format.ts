/**
 * Formatting + timezone bucketing (D8). Pure module (no react-native imports)
 * so it is unit-testable. Day/month/year buckets are computed at render time
 * from UTC instants in the persisted reporting_timezone — never stored.
 */

export type Granularity = "daily" | "monthly" | "yearly";

const partsCache = new Map<string, { y: number; m: number; d: number }>();

/** Calendar parts of an instant in the given IANA zone (Intl-backed). */
export function calendarParts(occurredAtMs: number, timeZone: string): { y: number; m: number; d: number } {
  const cacheKey = `${occurredAtMs}|${timeZone}`;
  const cached = partsCache.get(cacheKey);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(occurredAtMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const out = { y: get("year"), m: get("month"), d: get("day") };
  if (partsCache.size > 8192) partsCache.clear();
  partsCache.set(cacheKey, out);
  return out;
}

/** Bucket key for a group-by: 2026-09-05 (daily), 2026-09 (monthly), 2026 (yearly). */
export function bucketKey(occurredAtMs: number, timeZone: string, granularity: Granularity): string {
  const { y, m, d } = calendarParts(occurredAtMs, timeZone);
  if (granularity === "yearly") return String(y).padStart(4, "0");
  if (granularity === "monthly") return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function bucketLabel(key: string, granularity: Granularity): string {
  if (granularity === "yearly") return key;
  if (granularity === "monthly") {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toLocaleString("en", { month: "short" });
  }
  const [, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(2000, (m ?? 1) - 1, d ?? 1)).toLocaleString("en", {
    month: "numeric",
    day: "numeric",
  });
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatCost(cost: number): string {
  if (cost >= 1000) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  if (cost > 0) return `$${cost.toFixed(4)}`;
  return "$0";
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatRelative(iso: string | null, now = Date.now()): string {
  if (iso === null) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
