import { describe, expect, test } from "bun:test";
import {
  bucketEvents,
  buildSeries,
  buildStackLayers,
  computeDailyTotals,
  computeGranularityMax,
  computeRecords,
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

describe("computeRecords", () => {
  const DAY = 86_400_000;
  // Deterministic "now": Sep 6 2026 12:00 UTC (an ordinal boundary).
  const now = Date.parse("2026-09-06T12:00:00Z");
  const at = (dayOffsetFromNow: number, hour = 6) =>
    now - dayOffsetFromNow * DAY - (12 - hour) * 3_600_000;

  test("biggest day (by tokens), priciest session", () => {
    const events = [
      event({ occurredAtMs: at(5), sessionId: "cheap", inputTokens: 100, cost: 0.1 }),
      event({ occurredAtMs: at(5), sessionId: "cheap", inputTokens: 100, cost: 0.2 }),
      event({ occurredAtMs: at(10), sessionId: "pricey", inputTokens: 900, cost: 5 }),
    ];
    const records = computeRecords(events, IST, now);
    // Sep 1 holds both cheap events (200 tokens); Aug 27 holds the pricey one (900).
    expect(records.biggestDay?.tokens).toBe(900);
    expect(records.topSession?.sessionId).toBe("pricey");
    expect(records.topSession?.cost).toBe(5);
  });

  test("streaks break on gaps and count back from today", () => {
    const events = [
      // Active 3 days, gap, active 2 days, today inactive.
      event({ occurredAtMs: at(9), sessionId: "a" }),
      event({ occurredAtMs: at(8), sessionId: "b" }),
      event({ occurredAtMs: at(7), sessionId: "c" }),
      event({ occurredAtMs: at(5), sessionId: "d" }),
      event({ occurredAtMs: at(4), sessionId: "e" }),
    ];
    const records = computeRecords(events, IST, now);
    expect(records.longestStreak).toBe(3);
    expect(records.currentStreak).toBe(0);
  });

  test("today's inactivity does not break the current streak", () => {
    const events = [
      event({ occurredAtMs: at(1), sessionId: "a" }),
      event({ occurredAtMs: at(2), sessionId: "b" }),
    ];
    const records = computeRecords(events, IST, now);
    expect(records.currentStreak).toBe(2);
  });
});

describe("buildSeries and layers", () => {
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

  test("series carries per-bucket cache splits for the hit-rate chart", () => {
    const series = buildSeries(events, IST, "daily", "model");
    expect(series).toHaveLength(1);
    expect(series[0]!.stacks["glm-4.7"]).toBe(1000);
    expect(series[0]!.stacks["gpt-5.2-codex"]).toBe(500);
    expect(series[0]!.inputTokens).toBe(1500);
  });

  test("layers accumulate bottom-up in stack order", () => {
    const series = buildSeries(events, IST, "daily", "model");
    const layers = buildStackLayers(series, ["glm-4.7", "gpt-5.2-codex"]);
    expect(layers[0]!.values).toEqual([1000]);
    expect(layers[1]!.values).toEqual([1500]);
  });
});
