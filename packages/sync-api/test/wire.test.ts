import { describe, expect, test } from "bun:test";
import {
  eventIdentityDescription,
  normalizeCostSource,
  quotaAccountKey,
  quotaMetricLabel,
  quotaMirrorRowKey,
} from "../src/keys";
import { parseEventRow, parseEnvironmentRow, parseMachineMetricRow, parseQuotaRow } from "../src/supabase";
import { httpLiveApiFor, parseLiveEventsPage, parseLiveMetricsPage } from "../src/live";

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

  test("quota mirror rows are environment-scoped", () => {
    expect(quotaMirrorRowKey("windows", "codex", "personal", "session_5h")).toBe(
      "windows|codex|personal|session_5h",
    );
    expect(quotaMirrorRowKey(null, "codex", "personal", "weekly")).toBe(
      "no-env|codex|personal|weekly",
    );
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

  test("live generation round-trips and is sent on the next request", async () => {
    const generation = "a".repeat(64);
    expect(
      parseLiveEventsPage({
        sinceMs: 0,
        generatedAt: "2026-09-07T10:00:00.000Z",
        generation,
        events: [],
      }).generation,
    ).toBe(generation);
    let requested = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(
        JSON.stringify({ sinceMs: 0, generatedAt: "2026-09-07T10:00:00.000Z", generation, events: [] }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const api = httpLiveApiFor("http://machine:8787", fetchImpl);
    await api.events(0, undefined, generation);
    expect(requested).toContain(`since=0&generation=${generation}`);
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

  test("machine metrics validate live sensor ranges and map cloud timestamps", () => {
    const live = parseLiveMetricsPage({
      generatedAt: "2026-09-10T10:00:00.000Z",
      metrics: [{ capturedAtMs: 123, cpuLoadPct: 10, cpuTempC: null, ramUsedPct: 55,
        ramTempC: 42, gpuUtilPct: 80, gpuTempC: 70 }],
    });
    expect(live.metrics[0]?.ramTempC).toBe(42);
    expect(() => parseLiveMetricsPage({ generatedAt: "x", metrics: [{
      capturedAtMs: 1, cpuLoadPct: 101, ramUsedPct: 50,
    }] })).toThrow("0–100");
    expect(parseMachineMetricRow({
      id: "m1", environment_id: "windows", captured_at: "2026-09-10T10:00:00.000Z",
      cpu_load_pct: "10.2", cpu_temp_c: null, ram_used_pct: "55.5", ram_temp_c: "42.1",
      gpu_util_pct: "80", gpu_temp_c: "70", revision: 4,
    })).toMatchObject({ capturedAtMs: Date.parse("2026-09-10T10:00:00.000Z"), ramTempC: 42.1 });
  });
});
