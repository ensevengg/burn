import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { USAGE_RANGES, usageWindowStart } from "../src/lib/usage-range";

test("All is an unbounded window with yearly buckets", () => {
  expect(USAGE_RANGES.all.days).toBeNull();
  expect(USAGE_RANGES.all.granularity).toBe("yearly");
  expect(usageWindowStart(null, Date.UTC(2026, 8, 9))).toBe(0);
});

test("Android permits the reporter's HTTP endpoint inside the encrypted tailnet", () => {
  const config = JSON.parse(readFileSync(join(import.meta.dir, "../app.json"), "utf8"));
  expect(config.expo.android.usesCleartextTraffic).toBe(true);
});
