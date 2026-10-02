import { describe, expect, test } from "bun:test";
import { collectSystemMetric, SystemMetricHistory } from "../src/system-metrics";

describe("system metrics", () => {
  test("collects load, temperature, memory, and GPU data without inventing sensors", async () => {
    const metric = await collectSystemMetric({
      now: () => 123,
      cpuLoad: async () => 12.34,
      memory: () => ({ total: 1000, free: 250 }),
      hwmon: async () => new Map([
        ["coretemp", [70]],
        ["spd5118", [44, 46]],
      ]),
      gpu: async () => ({ utilization: 81.2, temperature: 67 }),
    });
    expect(metric).toEqual({
      capturedAtMs: 123,
      cpuLoadPct: 12.3,
      cpuTempC: 70,
      ramUsedPct: 75,
      ramTempC: 46,
      gpuUtilPct: 81.2,
      gpuTempC: 67,
    });
  });

  test("keeps a bounded 24-hour history and coalesces concurrent probes", async () => {
    let calls = 0;
    let now = 25 * 60 * 60_000;
    const history = new SystemMetricHistory(async () => {
      calls++;
      await Promise.resolve();
      return { capturedAtMs: now, cpuLoadPct: 1, cpuTempC: null, ramUsedPct: 2,
        ramTempC: null, gpuUtilPct: null, gpuTempC: null };
    }, () => now);
    const [first, same] = await Promise.all([history.sample(), history.sample()]);
    expect(first).toBe(same);
    expect(calls).toBe(1);
    now += 25 * 60 * 60_000;
    await history.sample();
    expect((await history.since(0)).every((sample) => sample.capturedAtMs >= now - 24 * 60 * 60_000)).toBe(true);
  });
});
