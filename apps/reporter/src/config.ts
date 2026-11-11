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
import { homedir, hostname, platform } from "node:os";
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
    tokscalePin: z.string().default(TOKSCALE_PIN).transform(atLeastCheckoutPin),
    /** Opt-in machine controls (ADR 0004). Absent means every control is off;
     * optional so configs without it are not rewritten on load. */
    controls: z.object({ powerMode: z.boolean().optional() }).optional(),
  });

/**
 * `init` saves the pin it ran with, but a checkout builds burn-events at one
 * pin, so a saved pin older than the checkout's would only make the reporter
 * reject its own exporter after an upgrade. Older pins move forward on load;
 * a newer saved pin (checkout rolled back) is kept and still fails loudly.
 */
function atLeastCheckoutPin(saved: string): string {
  const parts = (version: string) => version.split(".").map(Number);
  const [a, b] = [parts(saved), parts(TOKSCALE_PIN)];
  if (a.some(Number.isNaN)) return saved;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta < 0 ? TOKSCALE_PIN : saved;
  }
  return saved;
}

export type BurnConfig = z.infer<typeof configSchema>;

export function detectOsKind(): BurnConfig["osKind"] {
  if (platform() === "win32") return "windows";
  if (platform() === "darwin") return "macos";
  if (process.env["WSL_DISTRO_NAME"]) return "wsl";
  return "linux";
}

/**
 * Identity for a machine nobody has named: its hostname. WSL reports its
 * Windows host's name, so the WSL reporter gets a `-wsl` suffix (slugs must
 * differ per install) and both share that name as their host group.
 */
export function defaultIdentity(
  osKind: BurnConfig["osKind"] = detectOsKind(),
  host: string = hostname(),
): Pick<BurnConfig, "environmentSlug" | "environmentName" | "hostGroup" | "reportingTimezone"> {
  const short = host.split(".")[0] || "machine";
  const base = short.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "machine";
  let zone = "Asia/Kolkata";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone;
  } catch {
    /* keep the schema default */
  }
  return {
    environmentSlug: osKind === "wsl" ? `${base}-wsl` : base,
    environmentName: osKind === "wsl" ? `${short} (WSL)` : short,
    hostGroup: osKind === "wsl" || osKind === "windows" ? base : null,
    reportingTimezone: zone,
  };
}

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

/** Read and validate the saved config, rewriting it in place when the schema
 * normalizes it (legacy credentials removed, an older tokscale pin advanced). */
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

/** The saved config, or one created from this machine's defaults: `daemon`
 * on a fresh machine needs no `init` first. */
export function loadOrInitConfig(): { config: BurnConfig; created: boolean } {
  if (existsSync(configPath())) return { config: loadConfig(), created: false };
  const config = configSchema.parse({ ...defaultIdentity(), osKind: detectOsKind() });
  saveConfig(config);
  return { config, created: true };
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
