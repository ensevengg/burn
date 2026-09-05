import { describe, expect, test } from "bun:test";
import { eventIdentityDescription, normalizeCostSource, quotaAccountKey, quotaMetricLabel } from "../src/keys";
import { parseEventRow, parseEnvironmentRow, parseQuotaRow } from "../src/supabase";

describe("keys", () => {
  test("event identity is server-side sha256 of slug|client|dedup_key", () => {
    expect(eventIdentityDescription()).toBe("sha256(environment_slug | client | dedup_key)");
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

describe("wire parsing", () => {
  test("environment row maps snake_case to domain", () => {
    const env = parseEnvironmentRow({
      id: "11111111-1111-1111-1111-111111111111",
      slug: "cachyos",
      display_name: "CachyOS",
      host_group: "nerve",
      os_kind: "linux",
      latest_revision: 42,
      last_heartbeat_at: "2026-09-05T10:00:00+00:00",
    });
    expect(env.slug).toBe("cachyos");
    expect(env.latestRevision).toBe(42);
    expect(env.hostGroup).toBe("nerve");
  });

  test("event row maps timestamps to epoch ms and cost to decimal string", () => {
    const ev = parseEventRow({
      event_id: "abc",
      environment_id: "e1",
      client: "codex",
      provider_id: "openai",
      model_id: "gpt-5.2-codex",
      session_id: "s1",
      occurred_at: "2026-09-05T10:00:00+00:00",
      input_tokens: 10,
      cost: 0.012345,
      revision: 7,
    });
    expect(ev.occurredAtMs).toBe(Date.parse("2026-09-05T10:00:00+00:00"));
    expect(ev.cost).toBe("0.012345");
    expect(ev.revision).toBe(7);
  });

  test("event row tolerates missing nullable fields", () => {
    const ev = parseEventRow({
      event_id: "abc",
      environment_id: "e1",
      client: "zcode",
      provider_id: "zai",
      model_id: "glm-4.7",
      session_id: "s2",
      occurred_at: "2026-09-05T10:00:00+00:00",
      duration_ms: null,
    });
    expect(ev.durationMs).toBeNull();
    expect(ev.workspaceLabel).toBeNull();
    expect(ev.costIsComplete).toBe(false);
  });

  test("quota row maps percents leniently", () => {
    const q = parseQuotaRow({
      provider: "Codex",
      account_key: "acct",
      metric: "session_5h",
      used_percent: "81.4",
      remaining_percent: null,
      status: "ok",
      fetched_at: "2026-09-05T10:00:00+00:00",
    });
    expect(q.usedPercent).toBeCloseTo(81.4);
    expect(q.remainingPercent).toBeNull();
    expect(q.status).toBe("ok");
  });
});
