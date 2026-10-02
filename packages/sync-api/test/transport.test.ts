import { expect, test } from "bun:test";
import { parseLiveEventsPage, parseLiveQuotasPage, parseLivePing, httpLiveApiFor } from "../src/live";

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

const generatedAt = "2026-10-01T00:00:00Z";
const event = {
  client: "codex", providerId: "openai", modelId: "gpt", sessionId: "s",
  occurredAtMs: 1000, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, parserVersion: "pin",
  cost: "0.000001", dedupKey: "row",
};

test("machine events reject malformed money, booleans, tokens and missing content", () => {
  expect(parseLiveEventsPage({ generatedAt, events: [event] }).events[0]!.cost).toBe("0.000001");
  for (const bad of [
    { cost: "NaN" }, { inputTokens: -1 }, { inputTokens: 1.5 },
    { occurredAtMs: Number.MAX_SAFE_INTEGER + 1 }, { costIsComplete: "true" },
    { sessionId: "" }, { costSource: "free" },
  ]) expect(() => parseLiveEventsPage({ generatedAt, events: [{ ...event, ...bad }] })).toThrow();
  for (const key of Object.keys(event)) {
    const malformed: Record<string, unknown> = { ...event };
    delete malformed[key];
    expect(() => parseLiveEventsPage({ generatedAt, events: [malformed] })).toThrow();
  }
  expect(() => parseLivePing({ protocol: 2 })).toThrow("Unsupported live protocol");
});

test("machine quota percentages require finite numbers", () => {
  const quota = { provider: "codex", accountKey: "a", metric: "weekly" };
  for (const usedPercent of [true, false, "", " ", [], {}, "NaN", "12.50"])
    expect(() => parseLiveQuotasPage({ generatedAt, quotas: [{ ...quota, usedPercent }] })).toThrow();
  expect(parseLiveQuotasPage({ generatedAt, quotas: [{ ...quota, usedPercent: 12.5 }] }).quotas[0]!.usedPercent).toBe(12.5);
});

test("machine timestamp gates reject impossible dates and timezone-free instants", () => {
  for (const invalid of ["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-01T00:00:00", "2026-10-01T24:00:00Z"])
    expect(() => parseLiveQuotasPage({ generatedAt: invalid, quotas: [] })).toThrow();
  expect(parseLiveQuotasPage({ generatedAt: "2024-02-29T00:00:00+05:30", quotas: [] }).generatedAt).toBe("2024-02-29T00:00:00+05:30");
});
