/** First-run setup: identity defaults, tailnet detection, rebinding, services. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parseLivePing } from "@burn/sync-api";
import { configPath, configSchema, defaultIdentity, loadConfig, loadOrInitConfig } from "../src/config";
import { runInit } from "../src/commands";
import { superviseLiveServer, tailnetAddress } from "../src/serve";
import { daemonCommand, systemdUnit } from "../src/service";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "burn-setup-"));
  process.env["BURN_CONFIG_DIR"] = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["BURN_CONFIG_DIR"];
});

describe("identity defaults", () => {
  test("an unnamed machine is named after its hostname", () => {
    expect(defaultIdentity("linux", "Nerve-PC.lan")).toMatchObject({
      environmentSlug: "nerve-pc", environmentName: "Nerve-PC", hostGroup: null,
    });
    // WSL shares its Windows host's name: distinct slugs, one host group.
    expect(defaultIdentity("windows", "DESKTOP_7")).toMatchObject({
      environmentSlug: "desktop-7", environmentName: "DESKTOP_7", hostGroup: "desktop-7",
    });
    expect(defaultIdentity("wsl", "DESKTOP_7")).toMatchObject({
      environmentSlug: "desktop-7-wsl", environmentName: "DESKTOP_7 (WSL)", hostGroup: "desktop-7",
    });
    expect(defaultIdentity("linux", "").environmentSlug).toBe("machine");
    expect(defaultIdentity("linux", "東京").environmentSlug).toBe("machine");
    // The machine's own zone, not a fixed one; always a valid config.
    const zone = defaultIdentity("linux", "x").reportingTimezone;
    expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(() => configSchema.parse({ ...defaultIdentity("macos", "Mac mini"), osKind: "macos" })).not.toThrow();
  });

  test("init needs no flags, and flags still win", () => {
    runInit(new Map());
    expect(loadConfig().environmentSlug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    runInit(new Map([["slug", "test-box"], ["name", "Test Box"], ["tz", "Europe/Berlin"]]));
    expect(loadConfig()).toMatchObject({ environmentSlug: "test-box", environmentName: "Test Box", reportingTimezone: "Europe/Berlin" });
  });

  test("the daemon creates a config on first run and never replaces one", () => {
    expect(existsSync(configPath())).toBe(false);
    const first = loadOrInitConfig();
    expect(first.created).toBe(true);
    expect(loadConfig()).toEqual(first.config);
    runInit(new Map([["slug", "named"], ["name", "Named"]]));
    expect(loadOrInitConfig()).toMatchObject({ created: false, config: { environmentSlug: "named" } });
  });
});

describe("tailnet address", () => {
  const entry = (address: string, internal = false, family = "IPv4") =>
    ({ address, internal, family, netmask: "", mac: "", cidr: null }) as never;
  test("is the interface address inside 100.64.0.0/10", () => {
    expect(tailnetAddress({ lo: [entry("127.0.0.1", true)], eth0: [entry("192.168.1.9")], tailscale0: [entry("fd7a::1", false, "IPv6"), entry("100.101.102.103")] })).toBe("100.101.102.103");
    expect(tailnetAddress({ eth0: [entry("192.168.1.9"), entry("100.63.0.1"), entry("100.128.0.1"), entry("10.100.64.1")] })).toBeNull();
    expect(tailnetAddress({ utun4: [entry("100.64.0.1")] })).toBe("100.64.0.1");
    expect(tailnetAddress({})).toBeNull();
  });
});

describe("following Tailscale", () => {
  const config = configSchema.parse({ environmentSlug: "boot", environmentName: "Boot" });
  const deps = {
    now: Date.now,
    exporterCheck: async () => config.tokscalePin,
    exporterScan: async () => "",
    usage: async () => [],
  };
  // Every 127/8 address is bindable on Linux, which stands in for a tailnet
  // address appearing after the daemon has started.
  test.skipIf(platform() !== "linux")("moves from loopback to the tailnet address when it appears, on the same port", async () => {
    let address: string | null = null;
    const bound: [string, boolean][] = [];
    const live = await superviseLiveServer(config, {
      port: 0, deps, pollMs: 10, detect: async () => address,
      onBound: (handle, tailnet) => bound.push([handle.hostname, tailnet]),
    });
    try {
      const port = live.current().port;
      expect(bound).toEqual([["127.0.0.1", false]]);
      expect(parseLivePing(await (await fetch(`http://127.0.0.1:${port}/ping`)).json()).slug).toBe("boot");
      address = "127.0.0.2";
      await Bun.sleep(120);
      expect(bound).toEqual([["127.0.0.1", false], ["127.0.0.2", true]]);
      expect(live.current().url).toBe(`http://127.0.0.2:${port}`);
      expect(parseLivePing(await (await fetch(`http://127.0.0.2:${port}/ping`)).json()).slug).toBe("boot");
      // The loopback listener is gone, and a steady address is left alone.
      await expect(fetch(`http://127.0.0.1:${port}/ping`)).rejects.toThrow();
      await Bun.sleep(60);
      expect(bound).toHaveLength(2);
      // Tailscale stopping does not tear the listener down.
      address = null;
      await Bun.sleep(60);
      expect(live.current().hostname).toBe("127.0.0.2");
    } finally {
      live.stop();
    }
  });

  test("an explicit --bind is never moved", async () => {
    let asked = 0;
    const live = await superviseLiveServer(config, {
      bind: "127.0.0.1", port: 0, deps, pollMs: 5, detect: async () => { asked++; return "127.0.0.2"; },
    });
    await Bun.sleep(40);
    expect(live.current().hostname).toBe("127.0.0.1");
    expect(asked).toBe(0);
    live.stop();
  });
});

describe("service install", () => {
  test("starts the daemon the way this process was started", () => {
    expect(daemonCommand("/usr/local/bin/burn-report", "/$bunfs/root/burn-report")).toEqual(["/usr/local/bin/burn-report", "daemon"]);
    expect(daemonCommand("C:\\burn\\burn-report.exe", "B:/~BUN/root/burn-report.exe")).toEqual(["C:\\burn\\burn-report.exe", "daemon"]);
    expect(daemonCommand("/home/u/.bun/bin/bun", "/src/burn/apps/reporter/src/index.ts")).toEqual([
      "/home/u/.bun/bin/bun", "/src/burn/apps/reporter/src/index.ts", "daemon",
    ]);
  });

  test("the systemd unit carries the command, flags and the installing PATH", () => {
    const unit = systemdUnit(["/opt/my tools/burn-report", "daemon"], "/home/u/.cargo/bin:/usr/bin", ["--port", "9000"]);
    expect(unit).toContain('ExecStart="/opt/my tools/burn-report" daemon --port 9000\n');
    expect(unit).toContain("Environment=PATH=/home/u/.cargo/bin:/usr/bin\n");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("exporter lookup", () => {
  test.skipIf(platform() === "win32")("finds a release binary dropped into burn's config directory", async () => {
    const { resolveExporter, exporterVersion } = await import("../src/exporter");
    mkdirSync(join(dir, "bin"));
    const bin = join(dir, "bin", "burn-events");
    writeFileSync(bin, '#!/bin/sh\necho "burn-events 9.9.9"\n');
    chmodSync(bin, 0o755);
    const previous = process.env["BURN_EVENTS_BIN"];
    // An override that does not exist falls through to the usual places.
    process.env["BURN_EVENTS_BIN"] = join(dir, "missing");
    try {
      expect((await resolveExporter()).command).toBe(bin);
      expect(await exporterVersion()).toBe("9.9.9");
    } finally {
      if (previous === undefined) delete process.env["BURN_EVENTS_BIN"];
      else process.env["BURN_EVENTS_BIN"] = previous;
    }
  });
});
