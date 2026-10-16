import { describe, expect, test } from "bun:test";
import { bucketKey, bucketLabel, calendarParts, formatCost, formatCount, formatPercent, formatTokens, formatUntil } from "../src/lib/format";
import { humanize } from "../src/lib/labels";

// 2026-09-05 12:30 IST == 07:00 UTC. IST day buckets must not depend on the
// device's timezone (D8) — that's the whole point of the explicit zone arg.
const IST = "Asia/Kolkata";
const UTC = "UTC";

describe("bucketKey", () => {
  test("daily buckets respect the reporting timezone, not the device", () => {
    // 2026-09-04T20:30:00Z is already Sep 5 in IST but still Sep 4 in UTC.
    const instant = Date.parse("2026-09-04T20:30:00Z");
    expect(bucketKey(instant, IST, "daily")).toBe("2026-09-05");
    expect(bucketKey(instant, UTC, "daily")).toBe("2026-09-04");
  });

  test("monthly and yearly keys are zero-padded", () => {
    const instant = Date.parse("2026-01-09T12:00:00Z");
    expect(bucketKey(instant, IST, "monthly")).toBe("2026-01");
    expect(bucketKey(instant, IST, "yearly")).toBe("2026");
  });

  test("bucketLabel renders compact labels", () => {
    expect(bucketLabel("2026-09", "monthly")).toBe("Sep");
    expect(bucketLabel("2026", "yearly")).toBe("2026");
  });
});

describe("formatting", () => {
  test("known OpenAI and current model ids preserve product casing", () => {
    expect(humanize("openai-codex")).toBe("OpenAI Codex");
    expect(humanize("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  });
  test("tokens compact", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    // Tweens pass fractional in-between values.
    expect(formatTokens(734.6)).toBe("735");
  });

  test("counts group thousands without Intl", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999.4)).toBe("999");
    expect(formatCount(12_486)).toBe("12,486");
    expect(formatCount(1_234_567)).toBe("1,234,567");
  });

  test("cost never renders as $0 for nonzero decimal strings", () => {
    expect(formatCost(0.000123)).toBe("$0.0001");
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(4.5)).toBe("$4.50");
    expect(formatCost(1234)).toBe("$1,234");
    expect(formatCost(1234567.4)).toBe("$1,234,567");
  });

  test("percent one decimal", () => {
    expect(formatPercent(0.8734)).toBe("87.3%");
  });
});

test("formatUntil counts down to quota resets", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  expect(formatUntil("2026-10-16T00:45:00Z", now)).toBe("45m");
  expect(formatUntil("2026-10-16T03:12:00Z", now)).toBe("3h 12m");
  expect(formatUntil("2026-10-18T04:00:00Z", now)).toBe("2d 4h");
  expect(formatUntil("2026-10-15T23:00:00Z", now)).toBeNull();
  expect(formatUntil(null, now)).toBeNull();
});

test("dash-separated model versions read as decimals without merging dates", () => {
  expect(humanize("claude-opus-5-5")).toBe("Claude Opus 5.5");
  expect(humanize("claude-sonnet-4-5-20250929")).toBe("Claude Sonnet 4.5 20250929");
  expect(humanize("gpt-6-astra")).toBe("GPT-6 Astra");
  expect(humanize("glm-4.7")).toBe("GLM-4.7");
  expect(humanize("gpt-6-1-sol")).toBe("GPT-6.1 Sol");
  expect(humanize("gpt-5.2-codex")).toBe("GPT-5.2 Codex");
});

test("cached zone offsets match Intl exactly, including DST transition days", () => {
  const zones = ["Asia/Kolkata", "America/New_York", "Europe/Berlin", "Australia/Lord_Howe", "Pacific/Chatham", "UTC"];
  const reference = (ms: number, timeZone: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24 };
  };
  // Every 7 minutes across both 2026 transitions in each hemisphere, plus a year of random instants.
  const instants: number[] = [];
  for (const center of ["2026-03-08T07:00:00Z", "2026-03-29T01:00:00Z", "2026-04-04T15:00:00Z", "2026-10-04T15:00:00Z", "2026-10-25T01:00:00Z", "2026-11-01T06:00:00Z"]) {
    const at = Date.parse(center);
    for (let t = at - 6 * 3_600_000; t <= at + 6 * 3_600_000; t += 7 * 60_000) instants.push(t);
  }
  let seed = 7;
  for (let i = 0; i < 2000; i++) {
    seed = (seed * 48271) % 2147483647;
    instants.push(Date.parse("2025-11-01T00:00:00Z") + (seed % 400) * 86_400_000 + (seed % 86_400_000));
  }
  for (const zone of zones) for (const t of instants) expect(calendarParts(t, zone)).toEqual(reference(t, zone));
});
