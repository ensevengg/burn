import { describe, expect, test } from "bun:test";
import type { SeriesBucket } from "../src/data/repository";
import { bucketKey, bucketTitle } from "../src/lib/format";
import { bucketKeysBetween, fillSeries, monotonePath, resample, rollupYears } from "../src/lib/series";

const IST = "Asia/Kolkata";
const NY = "America/New_York";

function bucket(key: string, cost: number): SeriesBucket {
  return { key, label: key, tokens: cost * 10, cost, stacks: { a: cost }, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

describe("hourly buckets", () => {
  test("keys and titles live in the reporting timezone", () => {
    // 2026-09-04T20:30Z is 02:00 on Sep 5 in IST.
    expect(bucketKey(Date.parse("2026-09-04T20:30:00Z"), IST, "hourly")).toBe("2026-09-05T02");
    expect(bucketKey(Date.parse("2026-09-04T18:30:00Z"), IST, "hourly")).toBe("2026-09-05T00");
    expect(bucketTitle("2026-09-05T02", "hourly")).toBe("Sat 5 Sep, 02:00");
    expect(bucketTitle("2026-10-11", "daily")).toBe("Sun 11 Oct");
    expect(bucketTitle("2026-10", "monthly")).toBe("Oct 2026");
  });

  test("a 24h window spans 25 hour keys", () => {
    const now = Date.parse("2026-09-05T07:10:00Z");
    const keys = bucketKeysBetween(now - 86_400_000, now, IST, "hourly");
    expect(keys.length).toBe(25);
    expect(keys[0]).toBe("2026-09-04T12");
    expect(keys.at(-1)).toBe("2026-09-05T12");
  });

  test("a spring-forward day still yields one key per wall-clock hour", () => {
    const start = Date.parse("2026-03-08T04:00:00Z"); // 23:00 Mar 7 EST
    const keys = bucketKeysBetween(start, start + 5 * 3_600_000, NY, "hourly");
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("2026-03-08T03");
  });
});

describe("fillSeries", () => {
  test("idle days become zero buckets so the line drops instead of bridging", () => {
    const now = Date.parse("2026-10-05T06:00:00Z");
    const filled = fillSeries([bucket("2026-10-01", 5), bucket("2026-10-04", 7)], "daily", IST, now - 7 * 86_400_000, now);
    expect(filled.map((b) => b.key)).toEqual([
      "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
    ]);
    expect(filled.map((b) => b.cost)).toEqual([0, 0, 0, 5, 0, 0, 7, 0]);
  });

  test("an unbounded window starts at the first month with data and keeps skewed future buckets", () => {
    const now = Date.parse("2026-02-10T00:00:00Z");
    const filled = fillSeries([bucket("2025-11", 1), bucket("2026-03", 2)], "monthly", IST, null, now);
    expect(filled.map((b) => b.key)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
    expect(fillSeries([], "monthly", IST, null, now)).toEqual([]);
  });
});

test("rollupYears folds long monthly histories and leaves short ones alone", () => {
  const months = Array.from({ length: 40 }, (_, i) => bucket(`${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, 1));
  const short = rollupYears(months.slice(0, 12));
  expect(short.granularity).toBe("monthly");
  const long = rollupYears(months);
  expect(long.granularity).toBe("yearly");
  expect(long.series.map((b) => [b.key, b.cost, b.stacks["a"]])).toEqual([
    ["2023", 12, 12], ["2024", 12, 12], ["2025", 12, 12], ["2026", 4, 4],
  ]);
});

test("resample keeps endpoints and interpolates between them", () => {
  expect(resample([0, 10], 3)).toEqual([0, 5, 10]);
  expect(resample([4], 3)).toEqual([4, 4, 4]);
  expect(resample([], 2)).toEqual([0, 0]);
  expect(resample([1, 2, 3], 1)).toEqual([3]);
});

test("monotone path never overshoots the data range", () => {
  // A spike between idle buckets: Catmull-Rom dips below the baseline here.
  const ys = [100, 100, 0, 100, 100, 5, 100];
  const d = monotonePath(ys.map((y, i) => ({ x: i * 10, y })));
  const numbers = d.replace(/[MC]/g, " ").trim().split(/\s+/).map(Number);
  const yValues = numbers.filter((_, i) => i % 2 === 1);
  expect(Math.max(...yValues)).toBeLessThanOrEqual(100);
  expect(Math.min(...yValues)).toBeGreaterThanOrEqual(0);
});
