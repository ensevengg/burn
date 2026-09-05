/**
 * Tokscale adapter (D2): shell out to the pinned tokscale CLI, validate every
 * payload against a schema, fail loudly on drift. Raw per-message events come
 * from the `burn-events` exporter seam (deferred post-demo); quota snapshots
 * already work against the real CLI.
 */
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { z } from "zod";

export class TokscaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokscaleError";
  }
}

// tokscale usage --json — crates/tokscale-cli/src/commands/usage/mod.rs (UsageOutput)
export const usageOutputSchema = z.object({
  provider: z.string(),
  account: z
    .object({ id: z.string(), label: z.string().nullable().optional(), is_active: z.boolean().default(false) })
    .nullable()
    .optional(),
  credential_source: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  metrics: z
    .array(
      z.object({
        label: z.string(),
        used_percent: z.number(),
        remaining_percent: z.number(),
        remaining_label: z.string().nullable().optional(),
        resets_at: z.string().nullable().optional(),
      }),
    )
    .default([]),
  credit_status: z.record(z.string(), z.unknown()).nullable().optional(),
  spend_control: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type TokscaleUsageOutput = z.infer<typeof usageOutputSchema>;

export const usageReportSchema = z.array(usageOutputSchema);
export type TokscaleUsageReport = z.infer<typeof usageReportSchema>;

const npxBin = platform() === "win32" ? "npx.cmd" : "npx";

function run(
  pin: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(npxBin, ["-y", `tokscale@${pin}`, ...args], {
      shell: false,
      env: { ...process.env, NPM_CONFIG_YES: "true" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new TokscaleError(`tokscale ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new TokscaleError(`failed to launch npx (is Node.js installed?): ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new TokscaleError(
            `tokscale ${args.join(" ")} exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`,
          ),
        );
    });
  });
}

export async function tokscaleVersion(pin: string): Promise<string | null> {
  try {
    const { stdout } = await run(pin, ["--version"], 60_000);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function extractJsonArray(text: string): unknown {
  // tokscale may print warnings on stderr only, but be lenient about leading noise.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new TokscaleError(`tokscale output contained no JSON array: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

export async function fetchUsage(pin: string): Promise<TokscaleUsageReport> {
  const { stdout } = await run(pin, ["usage", "--json"]);
  const parsed = usageReportSchema.safeParse(extractJsonArray(stdout));
  if (!parsed.success) {
    // D2: fail loudly on schema drift — never push unvalidated payloads.
    const issue = parsed.error.issues[0];
    if (issue !== undefined) {
      throw new TokscaleError(
        `tokscale usage --json schema drift at ${issue.path.join(".")}: ${issue.message} (pinned ${pin})`,
      );
    }
    throw new TokscaleError(`tokscale usage --json failed schema validation (pinned ${pin})`);
  }
  return parsed.data;
}
