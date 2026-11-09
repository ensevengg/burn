import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../src/index.ts", import.meta.url).pathname;
async function run(...args: string[]) {
  const process = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI documents the machine-only workflow and rejects removed upload commands and flags", async () => {
  const help = await run("help");
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Tailscale");
  expect(help.stdout).not.toMatch(/Supabase|--url|--key|scheduled push/);
  for (const args of [["push"], ["init", "--url", "https://legacy.invalid"], ["daemon", "--no-live"]]) {
    const result = await run(...args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown");
  }
});

test("controls toggles the opt-in flag and rejects unknown controls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "burn-cli-"));
  const env = { ...process.env, BURN_CONFIG_DIR: dir };
  const exec = async (...args: string[]) => {
    const child = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  };
  expect((await exec("init", "--slug", "box", "--name", "Box", "--os", "linux")).code).toBe(0);
  const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  expect(config().controls).toBeUndefined();
  expect((await exec("controls", "enable", "power-mode")).code).toBe(0);
  expect(config().controls).toEqual({ powerMode: true });
  expect((await exec("controls", "disable", "power-mode")).code).toBe(0);
  expect(config().controls).toEqual({ powerMode: false });
  const unknown = await exec("controls", "enable", "reboot");
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("power-mode");
  const rule = await exec("controls", "polkit-rule");
  expect(rule.stdout.startsWith("// burn:")).toBe(true);
  expect(rule.stdout).not.toContain("sudo");
});
