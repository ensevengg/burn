import { describe, expect, test } from "bun:test";
import { bucketKey, bucketLabel, formatCost, formatPercent, formatTokens } from "../src/lib/format";

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
  test("tokens compact", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });

  test("cost never renders as $0 for nonzero decimal strings", () => {
    expect(formatCost(0.000123)).toBe("$0.0001");
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(4.5)).toBe("$4.50");
    expect(formatCost(1234)).toBe("$1234");
  });

  test("percent one decimal", () => {
    expect(formatPercent(0.8734)).toBe("87.3%");
  });
});
