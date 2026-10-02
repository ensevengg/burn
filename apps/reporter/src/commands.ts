import { TOKSCALE_PIN } from "@burn/sync-api";
import { platform } from "node:os";
import { configSchema, loadConfig, saveConfig, configPath, type BurnConfig } from "./config.js";
import { fetchUsage, tokscaleVersion } from "./tokscale.js";
import { exporterVersion, exporterCapabilities } from "./exporter.js";
import { runServe, tailscaleIp } from "./serve.js";

export { REPORTER_VERSION, tokscaleQuotaInputs, currentUtcOffsetMinutes } from "./tokscale.js";

export function detectOsKind(): BurnConfig["osKind"] {
  if (platform() === "win32") return "windows";
  if (platform() === "darwin") return "macos";
  if (process.env["WSL_DISTRO_NAME"]) return "wsl";
  return "linux";
}

export function printConfigured(config: BurnConfig): void {
  console.log(`environment  ${config.environmentSlug} (${config.environmentName})`);
  console.log("backend      Tailscale");
  console.log(`tokscale pin ${config.tokscalePin}`);
}

export function runInit(args: Map<string, string>): void {
  const missing = ["slug", "name"].filter((key) => !args.get(key));
  if (missing.length) throw new Error("init requires --slug <machine-slug> --name <display-name>");
  const config = configSchema.parse({
    environmentSlug: args.get("slug"),
    environmentName: args.get("name"),
    hostGroup: args.get("host-group") ?? null,
    osKind: args.get("os") ?? detectOsKind(),
    reportingTimezone: args.get("tz") ?? "Asia/Kolkata",
    tokscalePin: args.get("tokscale-pin") ?? TOKSCALE_PIN,
  });
  saveConfig(config);
  printConfigured(config);
  console.log(`config       ${configPath()}`);
  console.log("\nRun npx burn-report daemon, then add its printed URL on your phone's Machines tab. Both devices must be on your tailnet.");
}

export async function runDoctor(): Promise<number> {
  let config: BurnConfig;
  try { config = loadConfig(); }
  catch (err) { console.error(`FAIL config: ${(err as Error).message}`); return 1; }
  printConfigured(config);
  const [tokscale, exporter, capabilities, address] = await Promise.all([
    tokscaleVersion(config.tokscalePin), exporterVersion(), exporterCapabilities(), tailscaleIp(),
  ]);
  const supportsFingerprint = capabilities?.tokscaleVersion === config.tokscalePin && capabilities.capabilities.includes("fingerprint-v1");
  const checks = [
    { name: "tokscale", ok: tokscale !== null, detail: tokscale ? `reachable at pin ${config.tokscalePin}` : `npx tokscale@${config.tokscalePin} failed` },
    { name: "burn-events", ok: exporter === config.tokscalePin && supportsFingerprint, detail: exporter === null ? "exporter not found — install the pinned burn-events binary (or set BURN_EVENTS_BIN)" : exporter === config.tokscalePin && supportsFingerprint ? `matches pin ${config.tokscalePin}; fingerprint cache supported` : exporter === config.tokscalePin ? "fingerprint-v1 capability is missing — rebuild: cargo install --path crates/burn-events" : `version ${exporter} differs from pin ${config.tokscalePin} — rebuild the exporter` },
    { name: "Tailscale", ok: address !== null, detail: address ?? "no tailnet IPv4 address — start Tailscale before serving this machine" },
  ];
  for (const check of checks) console.log(`${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.detail}`);
  return checks.every((check) => check.ok) ? 0 : 1;
}

/** Local diagnostic output; the resident HTTP server supplies phone quotas. */
export async function runUsage(): Promise<number> {
  const config = loadConfig();
  console.log(JSON.stringify(await fetchUsage(config.tokscalePin), null, 2));
  return 0;
}

/** Both resident commands expose the same cached, read-only machine backend. */
export async function runDaemon(args: Map<string, string>): Promise<void> {
  await runServe(args);
}
