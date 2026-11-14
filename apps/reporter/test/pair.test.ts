/** Pairing: the saved port and the QR payload the phone scans. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadOrInitConfig, reporterPort, saveConfig } from "../src/config";
import { runInit } from "../src/commands";
import { pairingLink, renderQr } from "../src/pair";

let dir: string;
let distro: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "burn-pair-"));
  process.env["BURN_CONFIG_DIR"] = dir;
  distro = process.env["WSL_DISTRO_NAME"];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["BURN_CONFIG_DIR"];
  if (distro === undefined) delete process.env["WSL_DISTRO_NAME"];
  else process.env["WSL_DISTRO_NAME"] = distro;
});

describe("reporter port", () => {
  test("flag, then saved port, then 8787", () => {
    expect(reporterPort({})).toBe(8787);
    expect(reporterPort({ port: 9000 })).toBe(9000);
    expect(reporterPort({ port: 9000 }, "9100")).toBe(9100);
    expect(() => reporterPort({}, "0")).toThrow("--port");
    expect(() => reporterPort({}, "80a")).toThrow("--port");
  });

  test.skipIf(platform() !== "linux")("a fresh WSL install takes 8788 so it can share Windows' tailnet address", () => {
    process.env["WSL_DISTRO_NAME"] = "Ubuntu";
    expect(loadOrInitConfig().config.port).toBe(8788);
    delete process.env["WSL_DISTRO_NAME"];
    rmSync(join(dir, "config.json"));
    expect(loadOrInitConfig().config.port).toBeUndefined();
  });

  test("renaming keeps the saved port and enabled controls", () => {
    const { config } = loadOrInitConfig();
    saveConfig({ ...config, port: 9001, controls: { powerMode: true } });
    runInit(new Map([["name", "Renamed"]]));
    expect(loadConfig()).toMatchObject({ environmentName: "Renamed", port: 9001, controls: { powerMode: true } });
  });
});

describe("pairing code", () => {
  test("links to the add flow with the URL encoded", () => {
    expect(pairingLink("http://100.64.0.7:8788")).toBe("burn://add?url=http%3A%2F%2F100.64.0.7%3A8788");
  });

  test("sets its own colors on a terminal so either theme scans", () => {
    const plain = renderQr("burn://add?url=x", false).split("\n");
    const colored = renderQr("burn://add?url=x", true).split("\n");
    expect(plain.length).toBe(colored.length);
    expect(colored.every((line) => line.includes("\x1b[97;40m") && line.endsWith("\x1b[0m"))).toBe(true);
    expect(plain.some((line) => line.includes("\x1b"))).toBe(false);
  });
});

describe("WSL port choice", () => {
  test("a port held by another reporter is taken; this machine's own reporter is not", async () => {
    const { portHolder } = await import("../src/service");
    const ping = (slug: string) => () => Response.json({ protocol: 1, slug });
    const other = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: ping("box-wsl-debian") });
    const own = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: ping("box-wsl-ubuntu") });
    try {
      expect(await portHolder(other.port!, null, "box-wsl-ubuntu")).toBe("other");
      // Bound only on the tailnet address (here loopback): still answers.
      expect(await portHolder(own.port!, "127.0.0.1", "box-wsl-ubuntu")).toBe("self");
      expect(await portHolder(own.port!, "127.0.0.1", "box-wsl-debian")).toBe("other");
    } finally {
      other.stop(true);
      own.stop(true);
    }
    expect(await portHolder(other.port!, null, "box-wsl-ubuntu")).toBe("free");
  });
});
