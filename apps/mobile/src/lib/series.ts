/**
 * Chart series shaping. Pure (no react-native imports) and unit-tested.
 * The read layer returns only buckets that contain events; charts need the
 * whole calendar so idle periods read as zero instead of being interpolated
 * across, and a fixed bucket count per range lets one shape morph into the
 * next on refresh.
 */
import type { SeriesBucket } from "../data/repository";
import { bucketLabel, calendarParts, keyFromParts, type Granularity } from "./format";

type Parts = { y: number; m: number; d: number; h: number };

const MAX_BUCKETS = 4000;

function partsFromKey(key: string): Parts {
  const [y = 1970, m = 1, d = 1] = key.slice(0, 10).split("-").map(Number);
  const h = key.length > 11 ? Number(key.slice(11, 13)) : 0;
  return { y, m, d, h };
}

/** Every bucket key from `a` through `b` (inclusive), both already in the reporting zone. */
function keysBetweenParts(a: Parts, b: Parts, granularity: Granularity): string[] {
  const keys: string[] = [];
  if (granularity === "yearly") {
    for (let y = a.y; y <= b.y && keys.length < MAX_BUCKETS; y++) keys.push(keyFromParts(y, 1, 1, 0, granularity));
    return keys;
  }
  if (granularity === "monthly") {
    let y = a.y;
    let m = a.m;
    while ((y < b.y || (y === b.y && m <= b.m)) && keys.length < MAX_BUCKETS) {
      keys.push(keyFromParts(y, m, 1, 0, granularity));
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
    return keys;
  }
  // A UTC Date is only a calendar calculator here: local parts in, local parts
  // out. A DST gap yields one empty bucket; a repeated hour shares its key.
  const hourly = granularity === "hourly";
  const step = hourly ? 3_600_000 : 86_400_000;
  const last = Date.UTC(b.y, b.m - 1, b.d, hourly ? b.h : 0);
  for (let t = Date.UTC(a.y, a.m - 1, a.d, hourly ? a.h : 0); t <= last && keys.length < MAX_BUCKETS; t += step) {
    const at = new Date(t);
    keys.push(keyFromParts(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate(), at.getUTCHours(), granularity));
  }
  return keys;
}

export function bucketKeysBetween(startMs: number, endMs: number, timeZone: string, granularity: Granularity): string[] {
  return keysBetweenParts(calendarParts(startMs, timeZone), calendarParts(endMs, timeZone), granularity);
}

function emptyBucket(key: string, granularity: Granularity): SeriesBucket {
  return {
    key,
    label: bucketLabel(key, granularity),
    tokens: 0,
    cost: 0,
    stacks: {},
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * Zero-fill a sparse series across its window. An unbounded window (`null`)
 * starts at the first bucket with data. Buckets outside the computed range
 * (machine clock skew) are kept rather than dropped.
 */
export function fillSeries(
  series: readonly SeriesBucket[],
  granularity: Granularity,
  timeZone: string,
  windowStartMs: number | null,
  nowMs: number,
): SeriesBucket[] {
  if (windowStartMs === null && series.length === 0) return [];
  const end = calendarParts(nowMs, timeZone);
  const start = windowStartMs === null ? partsFromKey(series[0]!.key) : calendarParts(windowStartMs, timeZone);
  const byKey = new Map(series.map((bucket) => [bucket.key, bucket]));
  const keys = new Set(keysBetweenParts(start, end, granularity));
  for (const key of byKey.keys()) keys.add(key);
  return [...keys].sort().map((key) => byKey.get(key) ?? emptyBucket(key, granularity));
}

/** Long histories read better by year: fold a monthly series once it passes `maxMonths`. */
export function rollupYears(series: readonly SeriesBucket[], maxMonths = 36): { series: SeriesBucket[]; granularity: "monthly" | "yearly" } {
  if (series.length <= maxMonths) return { series: [...series], granularity: "monthly" };
  const years = new Map<string, SeriesBucket>();
  for (const bucket of series) {
    const key = bucket.key.slice(0, 4);
    const year = years.get(key) ?? emptyBucket(key, "yearly");
    year.tokens += bucket.tokens;
    year.cost += bucket.cost;
    year.inputTokens += bucket.inputTokens;
    year.cacheReadTokens += bucket.cacheReadTokens;
    year.cacheWriteTokens += bucket.cacheWriteTokens;
    for (const [stack, value] of Object.entries(bucket.stacks)) year.stacks[stack] = (year.stacks[stack] ?? 0) + value;
    years.set(key, year);
  }
  return { series: [...years.values()], granularity: "yearly" };
}

/** Linear resample onto `n` evenly spaced points — lets a 7-bucket shape morph into a 30-bucket one. */
export function resample(values: readonly number[], n: number): number[] {
  if (n <= 0) return [];
  if (values.length === 0) return new Array<number>(n).fill(0);
  if (values.length === 1) return new Array<number>(n).fill(values[0]!);
  if (n === 1) return [values[values.length - 1]!];
  const out = new Array<number>(n);
  const scale = (values.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const at = i * scale;
    const lo = Math.floor(at);
    const hi = Math.min(values.length - 1, lo + 1);
    out[i] = values[lo]! + (values[hi]! - values[lo]!) * (at - lo);
  }
  return out;
}

/**
 * Monotone cubic (Fritsch–Carlson) path through the points. Unlike
 * Catmull-Rom it never overshoots, so a spike next to an idle day cannot dip
 * the line below zero.
 */
export function monotonePath(points: readonly { x: number; y: number }[]): string {
  const n = points.length;
  if (n === 0) return "";
  const f = (v: number) => v.toFixed(1);
  if (n === 1) return `M${f(points[0]!.x)} ${f(points[0]!.y)}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1]!.x - points[i]!.x);
    slope.push((points[i + 1]!.y - points[i]!.y) / (dx[i] || 1));
  }
  const tangent: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    tangent.push(a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b));
  }
  tangent.push(slope[n - 2]!);
  let d = `M${f(points[0]!.x)} ${f(points[0]!.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    const third = dx[i]! / 3;
    d += `C${f(p.x + third)} ${f(p.y + tangent[i]! * third)} ${f(q.x - third)} ${f(q.y - tangent[i + 1]! * third)} ${f(q.x)} ${f(q.y)}`;
  }
  return d;
}
