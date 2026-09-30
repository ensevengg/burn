import { expect, test } from "bun:test";
import { createBurnBackend } from "../src/supabase";
import {
  parseLiveEventsPage,
  parseLiveQuotasPage,
  parseLivePing,
  httpLiveApiFor,
} from "../src/live";
import {
  parseEventRow,
  parseEnvironmentRow,
  parseQuotaRow,
} from "../src/supabase";

const config = {
  url: "https://example.supabase.co",
  publishableKey: "test-key",
};
const delta = {
  protocol: 2,
  environments: [],
  events: [],
  cursors: {},
  has_more: false,
};
test("cloud reads retry transient failures and use environment continuations", async () => {
  let calls = 0;
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls++;
    expect(String(url)).toContain("burn_fetch_delta_v2");
    expect(JSON.parse(String(init?.body)).p_cursors).toEqual({
      env: { revision: 8, eventId: "a" },
    });
    return new Response(
      JSON.stringify(calls === 1 ? { message: "busy" } : delta),
      {
        status: calls === 1 ? 503 : 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  expect(
    (
      await createBurnBackend({ ...config, fetchImpl })
        .phone("phone")
        .fetchDelta({ env: { revision: 8, eventId: "a" } })
    ).events,
  ).toEqual([]);
  expect(calls).toBe(2);
});

test("cloud deadlines abort the transport; authentication failures are not retried", async () => {
  let calls = 0;
  let aborted = false;
  const fetchImpl = (async (url, init) => {
    calls++;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      };
      if (init?.signal?.aborted) onAbort();
      else init?.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return new Response();
  }) as typeof fetch;
  await expect(
    createBurnBackend({ ...config, fetchImpl, requestTimeoutMs: 20 })
      .phone("phone")
      .fetchDelta({}),
  ).rejects.toThrow();
  expect(aborted).toBe(true);
  expect(calls).toBe(1);
  calls = 0;
  const unauthorized = (async (
    _url: string | URL | Request,
    _init?: RequestInit,
  ) => {
    calls++;
    return new Response(
      JSON.stringify({ message: "invalid read token", code: "P0001" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  await expect(
    createBurnBackend({ ...config, fetchImpl: unauthorized })
      .phone("phone")
      .fetchDelta({}),
  ).rejects.toThrow("invalid read token");
  expect(calls).toBe(1);
});

test("mutating retries preserve the quota collection identity and empty scans reach the backend", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const fetchImpl = (async (url, init) => {
    calls++;
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify(
        calls === 1
          ? { message: "response lost" }
          : { snapshots: 1, revision: 8, changed: 0 },
      ),
      {
        status: calls === 1 ? 503 : 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  const reporter = createBurnBackend({ ...config, fetchImpl }).reporter(
    "machine",
  );
  await reporter.pushQuotaSnapshots([
    {
      provider: "codex",
      accountKey: "a",
      accountLabel: null,
      plan: null,
      metric: "5h",
      usedPercent: 20,
      remainingPercent: 80,
      remainingLabel: null,
      resetsAt: null,
      creditStatus: null,
      spendControl: null,
      status: "ok",
      error: null,
      sourceOffsetMinutes: null,
    },
  ]);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(await reporter.ingestEvents([])).toEqual({ revision: 8, changed: 0 });
  expect(calls).toBe(3);
});

test("malformed money, booleans, tokens and dates fail before mirror writes", () => {
  const event = {
    event_id: "id",
    environment_id: "env",
    client: "codex",
    provider_id: "openai",
    model_id: "gpt",
    session_id: "session",
    occurred_at: "2026-09-30T10:00:00Z",
    parser_version: "pin",
    revision: 1,
    cost: "0.000001",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
  };
  expect(parseEventRow(event).cost).toBe("0.000001");
  for (const bad of [
    { cost: "NaN" },
    { input_tokens: -1 },
    { input_tokens: 1.5 },
    { occurred_at: "not-a-date" },
    { cost_is_complete: "true" },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { session_id: "" },
  ])
    expect(() => parseEventRow({ ...event, ...bad })).toThrow();
  expect(() =>
    parseEnvironmentRow({
      id: "env",
      slug: "machine",
      display_name: "Machine",
      os_kind: "linux",
      latest_revision: 0,
      last_heartbeat_at: "yesterday",
    }),
  ).toThrow();
  expect(() =>
    parseQuotaRow({
      provider: "codex",
      account_key: "a",
      metric: "5h",
      status: "maybe",
      fetched_at: "2026-09-30T10:00:00Z",
    }),
  ).toThrow();
  expect(() => parseLivePing({ protocol: 2 })).toThrow(
    "Unsupported live protocol",
  );
  expect(() =>
    parseLiveEventsPage({ events: [], generatedAt: "bad" }),
  ).toThrow();
  expect(() =>
    parseLiveQuotasPage({ quotas: [], generatedAt: "bad" }),
  ).toThrow();
});

test("weak conditional validators preserve the snapshot content hash", async () => {
  const fetchImpl = (async (
    _url: string | URL | Request,
    _init?: RequestInit,
  ) =>
    new Response(null, {
      status: 304,
      headers: {
        etag: 'W/"abcdef"',
        "x-generated-at": "2026-09-30T10:00:00Z",
        "x-scan-started-at-ms": "1000",
        "x-burn-slug": "machine",
      },
    })) as typeof fetch;
  const page = await httpLiveApiFor("http://machine", fetchImpl).events(
    0,
    undefined,
    { knownHash: "abcdef" },
  );
  expect(page.contentHash).toBe("abcdef");
  expect(page.notModified).toBe(true);
  expect(page.events).toEqual([]);
});

test("cloud numeric fields reject coercions and required event content cannot default to zero", () => {
  const row = {
    event_id: "id",
    environment_id: "env",
    client: "codex",
    provider_id: "openai",
    model_id: "model",
    session_id: "s",
    occurred_at: "2026-10-01T00:00:00Z",
    parser_version: "pin",
    revision: 1,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost: "0.1",
  };
  for (const key of [
    "cost",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "revision",
    "parser_version",
  ]) {
    const malformed: Record<string, unknown> = { ...row };
    delete malformed[key];
    expect(() => parseEventRow(malformed)).toThrow();
  }
  for (const value of [true, false, "", " ", [], {}, "NaN"]) {
    expect(() =>
      parseQuotaRow({
        provider: "openai",
        account_key: "a",
        metric: "weekly",
        status: "ok",
        fetched_at: "2026-10-01T00:00:00Z",
        used_percent: value,
      }),
    ).toThrow();
  }
  expect(
    parseQuotaRow({
      provider: "openai",
      account_key: "a",
      metric: "weekly",
      status: "ok",
      fetched_at: "2026-10-01T00:00:00Z",
      used_percent: "12.50",
    }).usedPercent,
  ).toBe(12.5);
});

test("timestamp gates reject impossible days and instants without a timezone", () => {
  const row = {
    provider: "codex",
    account_key: "a",
    metric: "weekly",
    status: "ok",
  };
  for (const fetched_at of [
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-10-01T00:00:00",
    "2026-10-01T24:00:00Z",
  ]) {
    expect(() => parseQuotaRow({ ...row, fetched_at })).toThrow();
  }
  expect(
    parseQuotaRow({ ...row, fetched_at: "2024-02-29T00:00:00+05:30" })
      .fetchedAt,
  ).toBe("2024-02-29T00:00:00+05:30");
});

test("validated live adapters are reused and injected adapters still pass through the schema gate", async () => {
  const { validateLiveApi } = await import("../src/live");
  const api = httpLiveApiFor(
    "http://machine",
    (async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          generatedAt: "2026-10-01T00:00:00Z",
          sinceMs: 0,
          events: [],
        }),
      )) as typeof fetch,
  );
  expect(validateLiveApi(api)).toBe(api);
  const injected = validateLiveApi({
    ping: async () => ({ protocol: 999 }),
    events: async () => ({ events: [{}] }),
    quotas: async () => ({ quotas: "bad" }),
  });
  await expect(injected.ping()).rejects.toThrow("Unsupported live protocol");
  await expect(injected.events(0)).rejects.toThrow();
  await expect(injected.quotas()).rejects.toThrow();
});
