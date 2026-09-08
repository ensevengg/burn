import { describe, expect, test } from "bun:test";
import type { BurnConfig } from "../src/config.js";
import { createLiveFetch, type LiveDeps } from "../src/serve.js";

const CONFIG: BurnConfig = {
  supabaseUrl: "https://example.supabase.co",
  publishableKey: "sb_publishable_test",
  ingestToken: "x".repeat(32),
  environmentSlug: "lenovo-windows",
  environmentName: "Lenovo Windows",
  hostGroup: null,
  osKind: "windows",
  reportingTimezone: "Asia/Kolkata",
  intervalMinutes: 10,
  syncPollSeconds: 10,
  tokscalePin: "4.15.1",
};

// Exporter wire shape (EventExportRow): snake_case, numeric cost, tokens object.
const EXPORTER_ROW_WITH_KEY = {
  client: "codex",
  provider_id: "openai",
  model_id: "gpt-5.2",
  session_id: "sess-1",
  session_title: null,
  workspace_key: null,
  workspace_label: null,
  agent: null,
  timestamp: 1725599000000,
  date: "2024-09-06",
  tokens: { input: 100, output: 10, cache_read: 5, cache_write: 0, reasoning: 0 },
  cost: 0.000123,
  cost_source: "provider_reported",
  duration_ms: 900,
  message_count: 1,
  is_turn_start: true,
  dedup_key: "v1:codex:sess-1:1725599000000:1",
};
const EXPORTER_ROW_WITHOUT_KEY = {
  ...EXPORTER_ROW_WITH_KEY,
  session_id: "sess-2",
  timestamp: 1725599500000,
  cost: 0,
  cost_source: "unknown",
  is_turn_start: false,
  dedup_key: null,
};

const CURSOR = { lastRevision: 5, lastPushAt: "2026-09-07T10:00:00.000Z" };
const SINCE = Date.parse(CURSOR.lastPushAt) - 60 * 60_000;

function deps(overrides: Partial<LiveDeps> = {}): LiveDeps {
  return {
    config: CONFIG,
    now: () => Date.parse("2026-09-07T10:05:00.000Z"),
    cursor: () => CURSOR,
    exporterCheck: async () => "4.15.1",
    exporterScan: async () => `${JSON.stringify(EXPORTER_ROW_WITH_KEY)}\n${JSON.stringify(EXPORTER_ROW_WITHOUT_KEY)}\n`,
    usage: async () => [
      {
        provider: "codex",
        account: { id: "acc-1", label: "Personal", is_active: true },
        plan: "chatgpt_plus",
        metrics: [{ label: "5h", used_percent: 12, remaining_percent: 88, remaining_label: "3h left" }],
      },
    ],
    ...overrides,
  };
}

describe("live server", () => {
  test("/ping advertises identity, contract version, and the cursor-minus-overlap window", async () => {
    const res = await createLiveFetch(deps())(new Request("http://machine/ping"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.protocol).toBe(1);
    expect(body.slug).toBe("lenovo-windows");
    expect(body.displayName).toBe("Lenovo Windows");
    expect(body.osKind).toBe("windows");
    expect(body.reportingTimezone).toBe("Asia/Kolkata");
    expect(body.exportSchema).toBe(1);
    expect(body.sinceMs).toBe(SINCE);
    expect(body.serverNowMs).toBe(Date.parse("2026-09-07T10:05:00.000Z"));
  });

  test("/live/events serves ingest-shaped rows with server-matchable identities", async () => {
    const res = await createLiveFetch(deps())(new Request("http://machine/live/events"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sinceMs: number; events: Record<string, unknown>[] };
    expect(body.sinceMs).toBe(SINCE);
    expect(body.events).toHaveLength(2);
    const [first, second] = body.events;
    // Decimal-string cost (D8), pinned parser version, identity fields.
    expect(first!.cost).toBe("0.000123");
    expect(first!.dedupKey).toBe("v1:codex:sess-1:1725599000000:1");
    expect(first!.parserVersion).toBe("tokscale-4.15.1");
    expect(first!.client).toBe("codex");
    expect(first!.inputTokens).toBe(100);
    // Missing dedup_key got the deterministic D2 fallback.
    expect(second!.dedupKey).toBe(`v1:codex:sess-2:1725599500000:1`);
    expect(second!.cost).toBe("0.000000");
    expect(second!.costSource).toBe("unknown");
    expect(second!.costIsComplete).toBe(false);
  });

  test("/live/events coalesces callers requesting the same scan", async () => {
    let scans = 0;
    let release!: () => void;
    const gate = new Promise<string>((resolve) => {
      release = () => resolve(`${JSON.stringify(EXPORTER_ROW_WITH_KEY)}\n`);
    });
    const fetcher = createLiveFetch(
      deps({
        exporterScan: () => {
          scans += 1;
          return gate;
        },
      }),
    );
    const first = fetcher(new Request("http://machine/live/events"));
    const second = fetcher(new Request("http://machine/live/events"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scans).toBe(1);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  test("/live/events reports a missing exporter as 503, a pin mismatch as 500", async () => {
    const missing = await createLiveFetch(deps({ exporterCheck: async () => null }))(
      new Request("http://machine/live/events"),
    );
    expect(missing.status).toBe(503);
    const mismatched = await createLiveFetch(deps({ exporterCheck: async () => "0.0.1" }))(
      new Request("http://machine/live/events"),
    );
    expect(mismatched.status).toBe(500);
    expect(((await mismatched.json()) as { error: string }).error).toContain("pin");
  });

  test("/live/events fails loudly on schema drift (D2), never serves unvalidated rows", async () => {
    const res = await createLiveFetch(deps({ exporterScan: async () => '{"client": "x"}\n' }))(
      new Request("http://machine/live/events"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("schema drift");
  });

  test("/live/events honors a ?since= cursor (direct mode) over the machine's own", async () => {
    let scanned: number | null = null;
    const res = await createLiveFetch(
      deps({ exporterScan: async (sinceMs) => { scanned = sinceMs; return `${JSON.stringify(EXPORTER_ROW_WITH_KEY)}\n`; } }),
    )(new Request("http://machine/live/events?since=1725590000000"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sinceMs: number };
    expect(body.sinceMs).toBe(1725590000000);
    expect(scanned!).toBe(1725590000000);
    // Invalid values fall back to the machine cursor window.
    const fallback = await createLiveFetch(
      deps({ exporterScan: async (sinceMs) => { scanned = sinceMs; return `${JSON.stringify(EXPORTER_ROW_WITH_KEY)}\n`; } }),
    )(new Request("http://machine/live/events?since=potato"));
    expect(((await fallback.json()) as { sinceMs: number }).sinceMs).toBe(SINCE);
    expect(scanned!).toBe(SINCE);
  });

  test("/live/quotas maps tokscale usage rows into ingest snapshots", async () => {
    const res = await createLiveFetch(deps())(new Request("http://machine/live/quotas"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quotas: Record<string, unknown>[] };
    expect(body.quotas).toHaveLength(1);
    expect(body.quotas[0]).toMatchObject({
      provider: "codex",
      accountKey: "acc-1",
      accountLabel: "Personal",
      plan: "chatgpt_plus",
      metric: "5h",
      status: "ok",
    });
  });

  test("/live/quotas reuses a recent vendor response", async () => {
    let now = Date.parse("2026-09-07T10:05:00.000Z");
    let calls = 0;
    const base = deps();
    const fetcher = createLiveFetch({
      ...base,
      now: () => now,
      usage: async (pin) => {
        calls += 1;
        return base.usage!(pin);
      },
    });

    expect((await fetcher(new Request("http://machine/live/quotas"))).status).toBe(200);
    now += 60_000;
    expect((await fetcher(new Request("http://machine/live/quotas"))).status).toBe(200);
    expect(calls).toBe(1);
    now += 5 * 60_000;
    expect((await fetcher(new Request("http://machine/live/quotas"))).status).toBe(200);
    expect(calls).toBe(2);
  });

  test("routing: unknown path 404, non-GET 405", async () => {
    const fetcher = createLiveFetch(deps());
    expect((await fetcher(new Request("http://machine/nope"))).status).toBe(404);
    expect((await fetcher(new Request("http://machine/ping", { method: "POST" }))).status).toBe(405);
  });
});
