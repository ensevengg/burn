import { describe, expect, test } from "bun:test";
import {
  eventIdentityDescription,
  normalizeCostSource,
  quotaAccountKey,
  quotaMetricLabel,
} from "../src/keys";
describe("keys", () => {
  test("event identity is stable sha256 of slug|client|dedup_key", () => {
    expect(eventIdentityDescription()).toBe(
      "sha256(environment_slug | client | dedup_key)",
    );
  });

  test("quota account key falls back for accountless providers", () => {
    expect(quotaAccountKey("acct-1")).toBe("acct-1");
    expect(quotaAccountKey(null)).toBe("no-account");
    expect(quotaAccountKey("   ")).toBe("no-account");
  });

  test("quota metric labels are snake_cased", () => {
    expect(quotaMetricLabel("Session (5h)")).toBe("session_(5h)");
    expect(quotaMetricLabel("")).toBe("unknown");
  });

  test("cost source normalization accepts tokscale camelCase and snake_case", () => {
    expect(normalizeCostSource("providerReported")).toBe("provider_reported");
    expect(normalizeCostSource("estimated")).toBe("estimated");
    expect(normalizeCostSource(undefined)).toBe("unknown");
  });
});
