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
      environmentSlug: "desktop-7-windows", environmentName: "DESKTOP_7", hostGroup: "desktop-7",
    });
    // A dual-boot box named the same on both sides is still two machines.
    expect(defaultIdentity("windows", "Nerve-PC").environmentSlug).not.toBe(defaultIdentity("linux", "Nerve-PC").environmentSlug);
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
    expect(tailnetAddress({ utun4: [entry("100.64.0.1")] }, "darwin")).toBe("100.64.0.1");
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

  test.skipIf(platform() !== "linux")("a supervisor stopped while it looks for the address opens nothing", async () => {
    let release: (address: string) => void = () => {};
    let asked = 0;
    const bound: string[] = [];
    const live = await superviseLiveServer(config, {
      port: 0, deps, pollMs: 5,
      // The first answer (startup) is "no tailnet"; the poll's answer is held.
      detect: () => (asked++ === 0 ? Promise.resolve(null) : new Promise<string>((resolve) => (release = resolve))),
      onBound: (handle) => bound.push(handle.hostname),
    });
    const port = live.current().port;
    while (asked < 2) await Bun.sleep(5);
    live.stop();
    release("127.0.0.2");
    await Bun.sleep(40);
    expect(bound).toEqual(["127.0.0.1"]);
    await expect(fetch(`http://127.0.0.2:${port}/ping`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${port}/ping`)).rejects.toThrow();
  });

  test.skipIf(platform() !== "linux")("a listener that stops answering on the same address is rebound on the same port", async () => {
    let answering = true;
    let checks = 0;
    const bound: string[] = [];
    const live = await superviseLiveServer(config, {
      port: 0, deps, pollMs: 10, detect: async () => "127.0.0.2",
      selfCheck: async () => { checks++; return answering; },
      onBound: (handle) => bound.push(handle.hostname),
    });
    try {
      const port = live.current().port;
      while (checks < 3) await Bun.sleep(5);
      expect(bound).toEqual(["127.0.0.2"]);
      // One miss is tolerated; two in a row rebind.
      answering = false;
      while (bound.length < 2) await Bun.sleep(5);
      answering = true;
      expect(bound).toEqual(["127.0.0.2", "127.0.0.2"]);
      expect(live.current().port).toBe(port);
      expect(parseLivePing(await (await fetch(`http://127.0.0.2:${port}/ping`)).json()).slug).toBe("boot");
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
    const unit = systemdUnit(["/opt/my tools/burn-report", "daemon"], { PATH: "/home/u/.cargo/bin:/usr/bin" }, ["--port", "9000"]);
    expect(unit).toContain('ExecStart="/opt/my tools/burn-report" daemon --port 9000\n');
    expect(unit).toContain("Environment=PATH=/home/u/.cargo/bin:/usr/bin\n");
    // Restarted whenever it exits, and never given up on.
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("the systemd unit escapes specifiers and variables", () => {
    const unit = systemdUnit(
      ["/opt/bun", '/src/100%/"burn"/$HOME/index.ts', "daemon"],
      { PATH: "/a b:/usr/bin", BURN_CONFIG_DIR: "/cfg/%h" },
    );
    expect(unit).toContain('Environment="PATH=/a b:/usr/bin"');
    expect(unit).toContain("Environment=BURN_CONFIG_DIR=/cfg/%%h");
    expect(unit).toContain('ExecStart=/opt/bun "/src/100%%/\\"burn\\"/$$HOME/index.ts" daemon');
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

describe("peer discovery (ADR 0005)", () => {
  const config = configSchema.parse({ environmentSlug: "hub", environmentName: "Hub" });
  const deps = { now: Date.now, exporterCheck: async () => config.tokscalePin, exporterScan: async () => "", usage: async () => [] };

  test("lists other reporters among the tailnet peers and skips everything else", async () => {
    const { PeerDirectory } = await import("../src/peers");
    const { startLiveServer } = await import("../src/serve");
    const { parseLivePeersPage, parseLivePing } = await import("@burn/sync-api");
    // Two real reporters, one unrelated HTTP service and one dead address.
    const other = await startLiveServer(configSchema.parse({ environmentSlug: "laptop", environmentName: "Laptop", osKind: "windows" }), { bind: "127.0.0.1", port: 0, deps, peerDiscovery: false });
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>router</html>") });
    let probes = 0;
    const targets: Record<string, string> = { "100.64.0.2": other.url, "100.64.0.3": `http://127.0.0.1:${stranger.port}`, "100.64.0.4": "http://127.0.0.1:1" };
    const directory = new PeerDirectory(8787, {
      listPeers: async () => Object.keys(targets),
      // Route the tailnet addresses to the local stand-ins.
      fetchImpl: ((input: string, init?: RequestInit) => {
        probes++;
        const url = new URL(String(input));
        expect(url.pathname).toBe("/ping");
        expect(url.port).toBe("8787");
        return fetch(`${targets[url.hostname]}/ping`, init);
      }) as typeof fetch,
    });
    const hub = await startLiveServer(config, { bind: "127.0.0.1", port: 0, deps: { ...deps, peers: directory } });
    try {
      expect(parseLivePing(await (await fetch(`${hub.url}/ping`)).json()).capabilities).toContain("peer-discovery");
      const page = parseLivePeersPage(await (await fetch(`${hub.url}/live/peers`)).json());
      expect(page.peers).toEqual([{ url: "http://100.64.0.2:8787", slug: "laptop", displayName: "Laptop", osKind: "windows" }]);
      // Answers are cached for a minute rather than re-probing the tailnet.
      await fetch(`${hub.url}/live/peers`);
      expect(probes).toBe(3);
      // A reporter started without discovery neither advertises nor answers it.
      expect(parseLivePing(await (await fetch(`${other.url}/ping`)).json()).capabilities).not.toContain("peer-discovery");
      expect((await fetch(`${other.url}/live/peers`)).status).toBe(404);
    } finally {
      hub.stop();
      other.stop();
      stranger.stop(true);
    }
  });

  test("a peer that redirects its ping is skipped without following it", async () => {
    const { PeerDirectory } = await import("../src/peers");
    let followed = 0;
    const outside = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { followed++; return Response.json({}); } });
    const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${outside.port}/ping`, 302) });
    try {
      const directory = new PeerDirectory(8787, {
        listPeers: async () => ["100.64.0.9"],
        fetchImpl: ((_input: string, init?: RequestInit) => fetch(`http://127.0.0.1:${peer.port}/ping`, init)) as typeof fetch,
      });
      expect(await directory.list()).toEqual([]);
      expect(followed).toBe(0);
    } finally {
      peer.stop(true);
      outside.stop(true);
    }
  });

  test("a peer list cannot hand the phone an arbitrary URL", async () => {
    const { parseLivePeersPage } = await import("@burn/sync-api");
    const peer = { url: "http://100.64.0.2:8787", slug: "a", displayName: "A", osKind: "linux" };
    expect(parseLivePeersPage({ peers: [peer] }).peers).toHaveLength(1);
    expect(parseLivePeersPage({ peers: [{ ...peer, url: "http://100.127.255.254" }] }).peers).toHaveLength(1);
    for (const url of [
      "http://evil.example/steal?x=1", "javascript:alert(1)", "http://host/path", "ftp://100.64.0.2",
      // Names and addresses outside Tailscale's range, whatever the port.
      "http://evil.example:8787", "http://192.168.1.4:8787", "http://100.63.0.1:8787", "http://100.128.0.1:8787",
      "https://100.64.0.2:8787", "http://100.64.0.2:8787/", "http://100.64.0.2.evil.example:8787",
      // A URL parser reads a leading zero as octal: 100.064.0.1 is 100.52.0.1.
      "http://100.064.0.1:8787", "http://100.64.01.1:8787", "http://100.64.0.010:8787", "http://100.64.0.256:8787",
    ])
      expect(() => parseLivePeersPage({ peers: [{ ...peer, url }] })).toThrow("invalid endpoint");
    expect(() => parseLivePeersPage({ peers: [{ ...peer, osKind: "plan9" }] })).toThrow();
  });
});

test("an interface named for Tailscale wins over another address in the shared range", () => {
  const entry = (address: string) => ({ address, internal: false, family: "IPv4", netmask: "", mac: "", cidr: null }) as never;
  expect(tailnetAddress({ CloudflareWARP: [entry("100.96.0.7")], tailscale0: [entry("100.101.102.103")] })).toBe("100.101.102.103");
  expect(tailnetAddress({ Tailscale: [entry("100.70.1.2")], wwan0: [entry("100.64.9.9")] })).toBe("100.70.1.2");
  expect(tailnetAddress({ utun3: [entry("100.96.0.7")] }, "darwin")).toBe("100.96.0.7");
});

test("an uplink in the carrier-NAT range is never taken for the tailnet", () => {
  const entry = (address: string) => ({ address, internal: false, family: "IPv4", netmask: "", mac: "", cidr: null }) as never;
  // No Tailscale interface: the server stays on loopback rather than binding
  // an unauthenticated endpoint to an ISP's shared network.
  for (const os of ["linux", "win32", "darwin"]) {
    expect(tailnetAddress({ wwan0: [entry("100.64.9.9")] }, os)).toBeNull();
    expect(tailnetAddress({ en0: [entry("100.72.3.4")], "Ethernet 2": [entry("100.100.1.1")] }, os)).toBeNull();
  }
  expect(tailnetAddress({ utun3: [entry("100.96.0.7")] }, "linux")).toBeNull();
});
