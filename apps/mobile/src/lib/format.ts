/**
 * Formatting + timezone bucketing (D8). Pure module (no react-native imports)
 * so it is unit-testable. Day/month/year buckets are computed at render time
 * from UTC instants in the persisted reporting_timezone — never stored.
 */

export type Granularity = "hourly" | "daily" | "monthly" | "yearly";

const DAY_MS = 86_400_000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();
/** `${zone}|${utcDay}` → the zone's offset for that whole UTC day, or NaN on a transition day. */
const dayOffsetCache = new Map<string, number>();

/** Exact UTC offset (ms) of `timeZone` at an instant, via Intl. The slow path. */
function zoneOffsetExact(atMs: number, timeZone: string): number {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    if (formatterCache.size >= 8) formatterCache.delete(formatterCache.keys().next().value!);
    formatterCache.set(timeZone, formatter);
  }
  const whole = Math.floor(atMs / 1000) * 1000;
  const parts = formatter.formatToParts(new Date(whole));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some ICU builds still render midnight as "24" under h23.
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return local - whole;
}

/**
 * Offset at an instant. Zones change offset at most once per UTC day, so two
 * Intl lookups per day (start and end) settle every instant in it; only a
 * DST-transition day falls back to per-instant lookups. On Hermes, Intl is
 * the dominant cost of bucketing tens of thousands of rows.
 */
function zoneOffset(atMs: number, timeZone: string): number {
  const day = Math.floor(atMs / DAY_MS);
  const key = `${timeZone}|${day}`;
  let offset = dayOffsetCache.get(key);
  if (offset === undefined) {
    const start = zoneOffsetExact(day * DAY_MS, timeZone);
    const end = zoneOffsetExact(day * DAY_MS + DAY_MS - 1000, timeZone);
    offset = start === end ? start : Number.NaN;
    if (dayOffsetCache.size > 50_000) dayOffsetCache.clear();
    dayOffsetCache.set(key, offset);
  }
  return Number.isNaN(offset) ? zoneOffsetExact(atMs, timeZone) : offset;
}

/** Calendar parts of an instant in the given IANA zone. */
export function calendarParts(occurredAtMs: number, timeZone: string): { y: number; m: number; d: number; h: number } {
  const local = new Date(occurredAtMs + zoneOffset(occurredAtMs, timeZone));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(), h: local.getUTCHours() };
}

/** Bucket key for a group-by: 2026-09-05T14 (hourly), 2026-09-05 (daily), 2026-09 (monthly), 2026 (yearly). */
export function bucketKey(occurredAtMs: number, timeZone: string, granularity: Granularity): string {
  const { y, m, d, h } = calendarParts(occurredAtMs, timeZone);
  return keyFromParts(y, m, d, h, granularity);
}

/** Key for calendar parts already in the reporting timezone. */
export function keyFromParts(y: number, m: number, d: number, h: number, granularity: Granularity): string {
  const year = String(y).padStart(4, "0");
  if (granularity === "yearly") return year;
  const month = `${year}-${String(m).padStart(2, "0")}`;
  if (granularity === "monthly") return month;
  const day = `${month}-${String(d).padStart(2, "0")}`;
  if (granularity === "daily") return day;
  return `${day}T${String(h).padStart(2, "0")}`;
}

export function bucketLabel(key: string, granularity: Granularity): string {
  if (granularity === "yearly") return key;
  if (granularity === "hourly") return `${key.slice(11, 13)}:00`;
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Long-form bucket title for scrub readouts: "Sun 11 Oct", "Oct 2026", "Fri 16 Oct, 14:00". */
export function bucketTitle(key: string, granularity: Granularity): string {
  if (granularity === "yearly") return key;
  const [y = 1970, m = 1, d = 1] = key.slice(0, 10).split("-").map(Number);
  if (granularity === "monthly") return `${MONTHS[m - 1]} ${y}`;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  if (granularity === "daily") return `${weekday} ${d} ${MONTHS[m - 1]}`;
  return `${weekday} ${d} ${MONTHS[m - 1]}, ${key.slice(11, 13)}:00`;
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
