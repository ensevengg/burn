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

/**
 * Runner resolution probes once and caches (first-check finding: on machines
 * where npx/npm resolve to wrapper shims — e.g. AppImage profiles — the npx
 * spawn rejects flags, while `bun x` works). Order: bun x → npx → bare binary.
 */
interface Runner {
  command: string;
  prefix: string[];
}

let cachedRunner: Runner | null = null;

function spawnRunner(
  runner: Runner,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(runner.command, [...runner.prefix, ...args], {
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
      reject(new TokscaleError(`failed to launch ${runner.command}: ${err.message}`));
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

async function resolveRunner(pin: string): Promise<Runner> {
  if (cachedRunner !== null) return cachedRunner;
  const candidates: Runner[] = [
    { command: "bun", prefix: ["x", `tokscale@${pin}`] },
    { command: npxBin, prefix: ["-y", `tokscale@${pin}`] },
    { command: "tokscale", prefix: [] },
  ];
  for (const candidate of candidates) {
    try {
      await spawnRunner(candidate, ["--version"], 60_000);
      cachedRunner = candidate;
      return candidate;
    } catch {
      /* probe the next strategy */
    }
  }
  throw new TokscaleError(
    `could not run tokscale (pin ${pin}) via bun x, npx, or PATH — install tokscale or bun`,
  );
}

export async function tokscaleVersion(pin: string): Promise<string | null> {
  try {
    const runner = await resolveRunner(pin);
    const { stdout } = await spawnRunner(runner, ["--version"], 60_000);
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
  const runner = await resolveRunner(pin);
  const { stdout } = await spawnRunner(runner, ["usage", "--json"], 120_000);
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
