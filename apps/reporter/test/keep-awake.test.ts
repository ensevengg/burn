import { describe, expect, test } from "bun:test";
import { parseKeepAwakeRequest, parseKeepAwakeState } from "@burn/sync-api";
import type { BurnConfig } from "../src/config.js";
import { detectKeepAwakeDriver, holdArgs, KeepAwakeController, type AwakeHold, type KeepAwakeDriver } from "../src/keep-awake.js";
import { createLiveFetch, type LiveDeps } from "../src/serve.js";

/** A fake inhibitor: each hold records its length and can be ended early. */
function fakeDriver(options: { failWith?: string } = {}) {
  const holds: { seconds: number; stopped: boolean; end: () => void }[] = [];
  const driver: KeepAwakeDriver = {
    backend: "systemd-inhibit",
    hold: (seconds): AwakeHold => {
      let end!: (value: { code: number | null; stderr: string }) => void;
      const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => (end = resolve));
      const record = { seconds, stopped: false, end: () => end({ code: 0, stderr: "" }) };
      holds.push(record);
      if (options.failWith !== undefined) end({ code: 1, stderr: options.failWith });
      return {
        exited,
        stop: () => {
          record.stopped = true;
          end({ code: null, stderr: "" });
        },
      };
    },
  };
  return { driver, holds };
}

describe("keep awake (ADR 0007)", () => {
  test("holds for the asked time, extends without a gap, releases on 0", async () => {
    let now = Date.parse("2026-11-26T10:00:00Z");
    const { driver, holds } = fakeDriver();
    const controller = new KeepAwakeController({ detect: async () => driver, now: () => now, settleMs: 1 });
    expect((await controller.state()).until).toBeNull();

    const first = await controller.set(60);
    expect(first.until).toBe("2026-11-26T11:00:00.000Z");
    expect(holds.map((h) => h.seconds)).toEqual([3600]);

    now += 30 * 60_000;
    const extended = await controller.set(120);
    expect(extended.until).toBe("2026-11-26T12:30:00.000Z");
    // The new hold was started before the old one was stopped.
    expect(holds.map((h) => [h.seconds, h.stopped])).toEqual([[3600, true], [7200, false]]);

    const off = await controller.set(0);
    expect(off.until).toBeNull();
    expect(holds[1]!.stopped).toBe(true);
  });

  test("a hold that ends by itself (timer or killed) reads as off", async () => {
    const { driver, holds } = fakeDriver();
    const controller = new KeepAwakeController({ detect: async () => driver, settleMs: 1 });
    await controller.set(5);
    holds[0]!.end();
    await Bun.sleep(1);
    expect((await controller.state()).until).toBeNull();
  });

  test("an inhibitor that refuses to start is reported, not shown as awake", async () => {
    const { driver } = fakeDriver({ failWith: "Access denied" });
    const controller = new KeepAwakeController({ detect: async () => driver, settleMs: 50 });
    await expect(controller.set(30)).rejects.toThrow("Access denied");
    expect((await controller.state()).until).toBeNull();
  });

  test("out-of-range requests never start a hold", async () => {
    const { driver, holds } = fakeDriver();
    const controller = new KeepAwakeController({ detect: async () => driver, settleMs: 1 });
    for (const minutes of [-1, 1.5, 721]) await expect(controller.set(minutes)).rejects.toThrow();
    expect(holds).toEqual([]);
    expect(() => parseKeepAwakeRequest({ minutes: 721 })).toThrow();
    expect(() => parseKeepAwakeRequest({ minutes: 60, forever: true })).toThrow();
    expect(parseKeepAwakeRequest({ minutes: 0 })).toEqual({ minutes: 0 });
  });

  test("every backend's hold is time-limited and shell-free", () => {
    for (const backend of ["systemd-inhibit", "caffeinate", "windows-execution-state"] as const) {
      const [command, args] = holdArgs(backend, 5400.7);
      expect(command).not.toContain(" ");
      expect(args.join(" ")).toContain("5400");
    }
    expect(holdArgs("systemd-inhibit", 60)[1]).toContain("--what=sleep:idle");
  });

  test("WSL and unknown systems are never offered", async () => {
    const run = async () => "";
    expect(await detectKeepAwakeDriver({ os: "linux", osKind: "wsl", run })).toBeNull();
    expect(await detectKeepAwakeDriver({ os: "aix", run })).toBeNull();
    expect((await detectKeepAwakeDriver({ os: "linux", osKind: "linux", run }))?.backend).toBe("systemd-inhibit");
    expect(
      await detectKeepAwakeDriver({ os: "linux", run: async () => Promise.reject(new Error("ENOENT")) }),
    ).toBeNull();
  });
});

describe("keep-awake endpoint", () => {
  const CONFIG: BurnConfig = {
    environmentSlug: "box",
    environmentName: "Box",
    hostGroup: null,
    osKind: "linux",
    reportingTimezone: "UTC",
    tokscalePin: "4.21.0",
  } as BurnConfig;
  const deps = (config: BurnConfig, keepAwake: KeepAwakeController): LiveDeps =>
    ({
      config,
      keepAwake,
      exporterScan: async () => "",
      exporterCheck: async () => config.tokscalePin,
      usage: async () => [],
      now: () => Date.parse("2026-11-26T10:00:00Z"),
    }) as unknown as LiveDeps;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://machine/controls/keep-awake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-burn-control": "1", ...headers },
      body: JSON.stringify(body),
    });

  test("off by default; enabled it is advertised and switchable", async () => {
    const { driver, holds } = fakeDriver();
    const controller = () => new KeepAwakeController({ detect: async () => driver, settleMs: 1 });
    const off = createLiveFetch(deps(CONFIG, controller()));
    const offPing = (await (await off(new Request("http://machine/ping"))).json()) as { capabilities: string[] };
    expect(offPing.capabilities).not.toContain("keep-awake");
    expect((await off(post({ minutes: 60 }))).status).toBe(404);

    const on = createLiveFetch(deps({ ...CONFIG, controls: { keepAwake: true } }, controller()));
    const ping = (await (await on(new Request("http://machine/ping"))).json()) as { capabilities: string[] };
    expect(ping.capabilities).toContain("keep-awake");
    expect(ping.capabilities).not.toContain("power-mode");
    const response = await on(post({ minutes: 90 }));
    expect(response.status).toBe(200);
    expect(parseKeepAwakeState(await response.json()).until).not.toBeNull();
    expect(holds.map((h) => h.seconds)).toEqual([5400]);
    const read = parseKeepAwakeState(await (await on(new Request("http://machine/controls/keep-awake"))).json());
    expect(read.backend).toBe("systemd-inhibit");

    // The shared write guard applies here too.
    for (const [request, status] of [
      [post({ minutes: 60 }, { origin: "http://evil.example" }), 403],
      [post({ minutes: 60 }, { "x-burn-control": "" }), 403],
      [post({ minutes: 9999 }), 400],
      [new Request("http://machine/controls/keep-awake", { method: "PUT" }), 405],
    ] as const)
      expect((await on(request)).status).toBe(status);
    expect(holds).toHaveLength(1);
  });
});
