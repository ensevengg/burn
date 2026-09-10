import { describe, expect, test } from "bun:test";
import {
  bucketEvents,
  buildSeries,
  computeGranularityMax,
  eventTokens,
  type EventRow,
} from "../src/data/repository";

const IST = "Asia/Kolkata";
const UTC = "UTC";

/** Minimal EventRow factory — only aggregation-relevant fields vary. */
function event(overrides: Partial<EventRow> & { occurredAtMs: number; sessionId: string }): EventRow {
  return {
    eventId: overrides.sessionId + "-m",
    environmentId: "env-1",
    client: "codex",
    providerId: "openai",
    modelId: "gpt-5.2-codex",
    sessionId: overrides.sessionId,
    sessionTitle: null,
    workspaceLabel: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    messageCount: 1,
    durationMs: null,
    cost: 0,
    costSource: "estimated",
    costIsComplete: true,
    ...overrides,
  };
}

describe("eventTokens", () => {
  test("sums the five buckets once, for everyone", () => {
    expect(
      eventTokens({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 1000,
        cacheWriteTokens: 50,
        reasoningTokens: 5,
      }),
    ).toBe(1165);
  });
});

describe("bucketEvents", () => {
  test("day buckets respect the reporting timezone, not the device", () => {
    // 2026-09-04T20:30Z is Sep 5 in IST, Sep 4 in UTC.
    const events = [
      event({ occurredAtMs: Date.parse("2026-09-04T20:30:00Z"), sessionId: "s1", inputTokens: 10 }),
    ];
    const ist = bucketEvents(events, IST, "daily");
    const utc = bucketEvents(events, UTC, "daily");
    expect([...ist.keys()]).toEqual(["2026-09-05"]);
    expect([...utc.keys()]).toEqual(["2026-09-04"]);
  });

  test("aggregates tokens, cost, and the cache splits per day", () => {
    const events = [
      event({
        occurredAtMs: Date.parse("2026-09-05T06:00:00Z"),
        sessionId: "s1",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 400,
        cacheWriteTokens: 20,
        cost: 0.5,
      }),
      event({
        occurredAtMs: Date.parse("2026-09-05T07:00:00Z"),
        sessionId: "s2",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.25,
      }),
    ];
    const agg = bucketEvents(events, IST, "daily").get("2026-09-05")!;
    expect(agg.tokens).toBe(585);
    expect(agg.cost).toBeCloseTo(0.75);
    expect(agg.cacheReadTokens).toBe(400);
  });
});

describe("computeGranularityMax", () => {
  const events = [
    event({ occurredAtMs: Date.parse("2026-08-20T06:00:00Z"), sessionId: "a", inputTokens: 3_000_000 }),
    event({ occurredAtMs: Date.parse("2026-09-05T06:00:00Z"), sessionId: "b", inputTokens: 700_000 }),
  ];
  test("daily max ignores the window and reports the historical peak", () => {
    expect(computeGranularityMax(events, IST, "daily")).toBe(3_000_000);
  });
  test("monthly buckets sum days before taking the max", () => {
    // The two events land in different months — the max is the larger single month.
    expect(computeGranularityMax(events, IST, "monthly")).toBe(3_000_000);
  });
});

describe("buildSeries", () => {
  const events = [
    event({
      occurredAtMs: Date.parse("2026-09-05T06:00:00Z"),
      sessionId: "s1",
      modelId: "glm-4.7",
      inputTokens: 1000,
    }),
    event({
      occurredAtMs: Date.parse("2026-09-05T07:00:00Z"),
      sessionId: "s2",
      modelId: "gpt-5.2-codex",
      inputTokens: 500,
    }),
  ];

  test("series carries per-bucket cache splits", () => {
    const series = buildSeries(events, IST, "daily", "model");
    expect(series).toHaveLength(1);
    expect(series[0]!.stacks["glm-4.7"]).toBe(1000);
    expect(series[0]!.stacks["gpt-5.2-codex"]).toBe(500);
    expect(series[0]!.inputTokens).toBe(1500);
  });

});
