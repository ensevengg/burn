import { expect, test } from "bun:test";
import { machineMetricId, parseLiveMetricsPage, validateLiveApi } from "../src";

const metric = { capturedAtMs: 1000, cpuLoadPct: 12, cpuTempC: null, ramUsedPct: 50,
  ramTempC: 43, gpuUtilPct: 75, gpuTempC: 60 };
const generatedAt = "2026-10-02T00:00:00Z";
test("machine health gates reject invalid timestamps, ranges and invented sensor values", () => {
  expect(parseLiveMetricsPage({ generatedAt, metrics: [metric] }).metrics).toEqual([metric]);
  for (const bad of [{ capturedAtMs: 1.5 }, { cpuLoadPct: -1 }, { ramUsedPct: 101 },
    { gpuUtilPct: NaN }, { gpuTempC: 201 }, { ramTempC: "44" }]) {
    expect(() => parseLiveMetricsPage({ generatedAt, metrics: [{ ...metric, ...bad }] })).toThrow();
  }
  expect(machineMetricId("a", 1000)).not.toBe(machineMetricId("b", 1000));
  expect(machineMetricId("a", 1000)).not.toBe(machineMetricId("a", 1001));
});
test("optional injected health adapters pass the same validation gate", async () => {
  const api = validateLiveApi({ ping: async () => ({}), events: async () => ({}),
    quotas: async () => ({}), metrics: async () => ({ generatedAt, metrics: [{ ...metric, ramUsedPct: "50" }] }) });
  await expect(api.metrics!(0)).rejects.toThrow();
});
