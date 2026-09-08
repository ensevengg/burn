import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";
import { configSchema, loadConfig, saveConfig, configPath, setupSqlPath } from "../src/config.js";
import { renderSetupSql } from "../src/setup-sql.js";
import { generateToken, sha256Hex } from "../src/tokens.js";
import { usageReportSchema } from "../src/tokscale.js";
import { detectOsKind, tokscaleQuotaInputs } from "../src/commands.js";

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
  supabaseUrl: "https://xyzcompany.supabase.co",
  publishableKey: "sb_publishable_KEY_1234567890",
  ingestToken: "ingest-token-0123456789abcdef",
  environmentSlug: "cachyos",
  environmentName: "CachyOS",
  hostGroup: "nerve",
  osKind: "linux" as const,
  reportingTimezone: "Asia/Kolkata",
  intervalMinutes: 10,
  tokscalePin: "4.15.1",
};

describe("config", () => {
  test("round-trips through saveConfig/loadConfig", () => {
    saveConfig(configSchema.parse(baseConfig));
    const loaded = loadConfig();
    expect(loaded.environmentSlug).toBe("cachyos");
    expect(loaded.intervalMinutes).toBe(10);
    expect(loaded.syncPollSeconds).toBe(10);
  });

  test("rejects a bad slug", () => {
    const bad = { ...baseConfig, environmentSlug: "Bad Slug!" };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  test("loadConfig throws with guidance when missing", () => {
    expect(() => loadConfig()).toThrow(/burn-report init/);
  });
});

describe("tokens", () => {
  test("sha256Hex matches the SQL-side recipe", () => {
    // burn_api uses encode(sha256(convert_to(t,'utf8')),'hex')
    expect(sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  test("generateToken is url-safe and long enough", () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("setup sql", () => {
  test("embeds token hashes and escapes quotes", () => {
    const config = configSchema.parse({ ...baseConfig, environmentName: "Cachy's Box" });
    const sql = renderSetupSql({ config, ingestToken: "ing-1234567890123456", readToken: "read-1234567890123456" });
    expect(sql).toContain(sha256Hex("ing-1234567890123456"));
    expect(sql).toContain(sha256Hex("read-1234567890123456"));
    expect(sql).toContain("'Cachy''s Box'");
    expect(sql).toContain("on conflict (slug)");
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

  test("renderSetupSql is deterministic and hash-only", () => {
    const config = configSchema.parse(baseConfig);
    const a = renderSetupSql({ config, ingestToken: "t".repeat(30), readToken: "r".repeat(30) });
    const b = renderSetupSql({ config, ingestToken: "t".repeat(30), readToken: "r".repeat(30) });
    expect(a).toBe(b);
    expect(a).not.toContain("t".repeat(30)); // plaintext never written
  });
});
