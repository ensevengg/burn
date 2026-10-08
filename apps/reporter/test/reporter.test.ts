import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";
import { configSchema, loadConfig, saveConfig, configPath } from "../src/config.js";
import { usageReportSchema } from "../src/tokscale.js";
import { detectOsKind, tokscaleQuotaInputs, runInit } from "../src/commands.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "burn-report-"));
  process.env["BURN_CONFIG_DIR"] = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["BURN_CONFIG_DIR"];
});

const baseConfig = {
  environmentSlug: "cachyos",
  environmentName: "CachyOS",
  hostGroup: "nerve",
  osKind: "linux" as const,
  reportingTimezone: "Asia/Kolkata",
  tokscalePin: "4.15.1",
};

describe("config", () => {
  test("round-trips through saveConfig/loadConfig", () => {
    saveConfig(configSchema.parse(baseConfig));
    const loaded = loadConfig();
    expect(loaded.environmentSlug).toBe("cachyos");
    expect(loaded.tokscalePin).toBe("4.15.1");
  });

  test("rejects a bad slug", () => {
    const bad = { ...baseConfig, environmentSlug: "Bad Slug!" };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  test("loadConfig throws with guidance when missing", () => {
    expect(() => loadConfig()).toThrow(/burn-report init/);
  });
});

describe("tokscale adapter", () => {
  test("usage fixture validates and maps to quota inputs", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/tokscale-usage.json"), "utf8"));
    const parsed = usageReportSchema.parse(fixture);
    expect(parsed).toHaveLength(2);

    const inputs = tokscaleQuotaInputs(parsed);
    const codex = inputs.filter((i) => i.provider === "Codex");
    expect(codex).toHaveLength(2);
    expect(codex[0]!.accountKey).toBe("acct_9f2c1e");
    expect(codex[0]!.metric).toBe("session_(5h)");

    const zai = inputs.filter((i) => i.provider === "Z.ai");
    expect(zai[0]!.accountKey).toBe("no-account");
    expect(zai[0]!.creditStatus).toEqual({
      balance: "$12.40",
      has_credits: true,
      unlimited: false,
      overage_limit_reached: false,
    });
  });

  test("schema drift fails loudly (D2)", () => {
    expect(() =>
      usageReportSchema.parse([
        {
          provider: "Codex",
          metrics: [{ label: "Session (5h)", used_percent: "42.0", remaining_percent: 58 }],
        },
      ]),
    ).toThrow();
  });
});

describe("init artifacts", () => {
  test("detectOsKind maps WSL via WSL_DISTRO_NAME", () => {
    // WSL_DISTRO_NAME only distinguishes wsl from linux on a Linux host; on
    // Windows proper the win32 check wins even if the variable leaks in.
    const expected = platform() === "win32" ? "windows" : "wsl";
    const previous = process.env["WSL_DISTRO_NAME"];
    process.env["WSL_DISTRO_NAME"] = "Ubuntu-24.04";
    expect(detectOsKind()).toBe(expected);
    if (previous === undefined) delete process.env["WSL_DISTRO_NAME"];
    else process.env["WSL_DISTRO_NAME"] = previous;
  });

  test("init requires only machine identity and creates no credentials or SQL", () => {
    runInit(new Map([["slug", "test-box"], ["name", "Test Box"]]));
    expect(loadConfig().environmentSlug).toBe("test-box");
    expect(Object.keys(JSON.parse(readFileSync(configPath(), "utf8")))).toEqual([
      "environmentSlug", "environmentName", "hostGroup", "osKind", "reportingTimezone", "tokscalePin",
    ]);
    expect(existsSync(join(dir, "setup-tokens.sql"))).toBe(false);
  });

  test("legacy reporter configs upgrade without reinitializing identity and discard credentials", () => {
    writeFileSync(configPath(), JSON.stringify({ ...baseConfig, mode: "cloud", supabaseUrl: "https://legacy.invalid", publishableKey: "old-key", ingestToken: "old-token", intervalMinutes: 10 }));
    writeFileSync(join(dir, "setup-tokens.sql"), "old setup");
    expect(loadConfig()).toEqual(baseConfig);
    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual(baseConfig);
    expect(existsSync(join(dir, "setup-tokens.sql"))).toBe(false);
  });
});
