/**
 * Reporter config (D7): lives at $BURN_CONFIG_DIR/config.json, defaulting to
 * XDG on Linux/WSL and the platform app-data dir on Windows. Stores machine
 * identity and parser settings; tailnet membership authorizes phone access.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { TOKSCALE_PIN } from "@burn/sync-api";
import { z } from "zod";

export const configSchema = z
  .object({
    environmentSlug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case"),
    environmentName: z.string().min(1),
    /** `windows` and `wsl` on one physical box should share a hostGroup. */
    hostGroup: z.string().nullable().default(null),
    osKind: z.enum(["windows", "wsl", "linux", "macos"]).default("linux"),
    /** Timezone evidence attached to rows; bucketing happens on the phone (D8). */
    reportingTimezone: z.string().default("Asia/Kolkata"),
    tokscalePin: z.string().default(TOKSCALE_PIN),
  });

export type BurnConfig = z.infer<typeof configSchema>;

export function configDir(): string {
  const override = process.env["BURN_CONFIG_DIR"];
  if (override) return override;
  if (platform() === "win32") {
    return join(
      process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"),
      "burn",
    );
  }
  return join(
    process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
    "burn",
  );
}

// Paths resolve lazily so BURN_CONFIG_DIR is honored at call time, not import time.
export const configPath = (): string => join(configDir(), "config.json");
export function atomicJson(path: string, data: unknown): void {
  mkdirSync(configDir(), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function loadConfig(): BurnConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`No config at ${path}. Run: npx burn-report init`);
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) throw new Error(`Invalid config at ${path}`);
    throw new Error(
      `Invalid config at ${path}: ${issue.path.join(".")} — ${issue.message}`,
    );
  }
  // Rewrite legacy configurations through the allowlisted schema so obsolete
  // destination credentials and upload settings are removed from disk.
  if (JSON.stringify(raw) !== JSON.stringify(parsed.data)) {
    atomicJson(path, parsed.data);
  }
  removeLegacySetup();
  return parsed.data;
}

export function saveConfig(config: BurnConfig): void {
  mkdirSync(configDir(), { recursive: true });
  atomicJson(configPath(), configSchema.parse(config));
  removeLegacySetup();
}

function removeLegacySetup(): void {
  const oldSetup = join(configDir(), "setup-tokens.sql");
  if (existsSync(oldSetup)) unlinkSync(oldSetup);
}
