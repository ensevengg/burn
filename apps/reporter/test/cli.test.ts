import { expect, test } from "bun:test";

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
