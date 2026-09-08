/**
 * Reporter config (D7): lives at $BURN_CONFIG_DIR/config.json, defaulting to
 * XDG on Linux/WSL and the platform app-data dir on Windows. Contains only
 * scoped tokens — the Supabase secret key never goes here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { TOKSCALE_PIN } from "@burn/sync-api";
import { z } from "zod";

export const configSchema = z.object({
  supabaseUrl: z.string().url(),
  publishableKey: z.string().min(10),
  /** Per-environment ingest token; hashes live server-side only. */
  ingestToken: z.string().min(24),
  environmentSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case"),
  environmentName: z.string().min(1),
  /** `windows` and `wsl` on one physical box should share a hostGroup. */
  hostGroup: z.string().nullable().default(null),
  osKind: z.enum(["windows", "wsl", "linux", "macos"]).default("linux"),
  /** Timezone evidence attached to rows; bucketing happens on the phone (D8). */
  reportingTimezone: z.string().default("Asia/Kolkata"),
  /** Minutes between scheduled pushes. */
  intervalMinutes: z.number().int().min(1).max(1440).default(10),
  /** Seconds between eager sync-request polls while the daemon is resident. */
  syncPollSeconds: z.number().int().min(5).max(300).default(10),
  tokscalePin: z.string().default(TOKSCALE_PIN),
});

export type BurnConfig = z.infer<typeof configSchema>;

export function configDir(): string {
  const override = process.env["BURN_CONFIG_DIR"];
  if (override) return override;
  if (platform() === "win32") {
    return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "burn");
  }
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "burn");
}

// Paths resolve lazily so BURN_CONFIG_DIR is honored at call time, not import time.
export const configPath = (): string => join(configDir(), "config.json");
export const cursorPath = (): string => join(configDir(), "cursor.json");
export const setupSqlPath = (): string => join(configDir(), "setup-tokens.sql");

export function loadConfig(): BurnConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`No config at ${path}. Run: npx burn-report init`);
  }
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) throw new Error(`Invalid config at ${path}`);
    throw new Error(`Invalid config at ${path}: ${issue.path.join(".")} — ${issue.message}`);
  }
  return parsed.data;
}

export function saveConfig(config: BurnConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** Local cursor: the last revision the server acknowledged for this environment. */
export interface ReporterCursor {
  lastRevision: number;
  lastPushAt: string;
}

export function loadCursor(): ReporterCursor {
  const path = cursorPath();
  if (!existsSync(path)) return { lastRevision: 0, lastPushAt: new Date(0).toISOString() };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ReporterCursor>;
  return {
    lastRevision: Number(raw.lastRevision ?? 0),
    lastPushAt: typeof raw.lastPushAt === "string" ? raw.lastPushAt : new Date(0).toISOString(),
  };
}

export function saveCursor(cursor: ReporterCursor): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(cursorPath(), JSON.stringify(cursor, null, 2) + "\n");
}
