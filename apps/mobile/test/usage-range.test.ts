import { expect, test } from "bun:test";
import { USAGE_RANGES, usageWindowStart } from "../src/lib/usage-range";

test("All is an unbounded window with yearly buckets", () => {
  expect(USAGE_RANGES.all.days).toBeNull();
  expect(USAGE_RANGES.all.granularity).toBe("yearly");
  expect(usageWindowStart(null, Date.UTC(2026, 8, 9))).toBe(0);
});
