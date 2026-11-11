import { TOKSCALE_PIN } from "@burn/sync-api";
import { platform, userInfo } from "node:os";
import {
  configSchema, loadConfig, saveConfig, configPath, defaultIdentity, detectOsKind, type BurnConfig,
} from "./config.js";
import { fetchUsage, tokscaleVersion } from "./tokscale.js";
import { exporterVersion, exporterCapabilities } from "./exporter.js";
import { runServe, tailscaleIp } from "./serve.js";
import { PowerModeController } from "./power-mode.js";

export { REPORTER_VERSION, tokscaleQuotaInputs, currentUtcOffsetMinutes } from "./tokscale.js";

export { detectOsKind };

export function printConfigured(config: BurnConfig): void {
  console.log(`environment  ${config.environmentSlug} (${config.environmentName})`);
  console.log("backend      Tailscale");
  console.log(`tokscale pin ${config.tokscalePin}`);
}

export function runInit(args: Map<string, string>): void {
  // Every flag is optional: an unnamed machine is named after its hostname.
  const osKind = configSchema.shape.osKind.parse(args.get("os") ?? detectOsKind());
  const defaults = defaultIdentity(osKind);
  const config = configSchema.parse({
    environmentSlug: args.get("slug") ?? defaults.environmentSlug,
    environmentName: args.get("name") ?? defaults.environmentName,
    hostGroup: args.get("host-group") ?? defaults.hostGroup,
    osKind,
    reportingTimezone: args.get("tz") ?? defaults.reportingTimezone,
    tokscalePin: args.get("tokscale-pin") ?? TOKSCALE_PIN,
  });
  saveConfig(config);
  printConfigured(config);
  console.log(`config       ${configPath()}`);
  console.log("\nRun burn-report daemon, then add this machine on your phone's Machines tab. Both devices must be on your tailnet.");
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
    // Usage rows come from burn-events alone; only vendor limits need the tokscale CLI.
    { name: "tokscale", ok: tokscale !== null, optional: true, detail: tokscale ? `reachable at pin ${config.tokscalePin}` : `tokscale@${config.tokscalePin} could not be run (needs Bun, Node or tokscale on PATH) — usage still syncs, vendor limits will not` },
    { name: "burn-events", ok: exporter === config.tokscalePin && supportsFingerprint, detail: exporter === null ? "exporter not found — install the pinned burn-events binary (or set BURN_EVENTS_BIN)" : exporter === config.tokscalePin && supportsFingerprint ? `matches pin ${config.tokscalePin}; fingerprint cache supported` : exporter === config.tokscalePin ? "fingerprint-v1 capability is missing — rebuild: cargo install --path crates/burn-events" : `version ${exporter} differs from pin ${config.tokscalePin} — rebuild the exporter` },
    { name: "Tailscale", ok: address !== null, detail: address ?? "no tailnet IPv4 address — start Tailscale; the daemon binds to it as soon as it appears" },
  ];
  for (const check of checks)
    console.log(`${check.ok ? "ok" : "optional" in check ? "warn" : "FAIL"} ${check.name}: ${check.detail}`);
  if (address !== null) console.log(`\nOn the phone, add: http://${address}:8787 (or this machine's Tailscale name)`);
  return checks.every((check) => check.ok || "optional" in check) ? 0 : 1;
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

const CONTROLS = ["power-mode"] as const;

/** Polkit rule letting this user's daemon switch power-profiles-daemon modes
 * with nobody signed in. Without it, changes work only during a desktop session. */
export function polkitRule(user: string): string {
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(user)) throw new Error(`unexpected user name: ${user}`);
  return `// burn: allow ${user}'s burn-report daemon to switch power modes while signed out.
polkit.addRule(function (action, subject) {
  if (action.id === "org.freedesktop.UPower.PowerProfiles.switch-profile" && subject.user === "${user}") {
    return polkit.Result.YES;
  }
});
`;
}

/** `controls [status|enable|disable|polkit-rule] [power-mode]` — opt-in machine controls (ADR 0004). */
export async function runControls(action: string, feature: string | undefined): Promise<number> {
  if (action === "polkit-rule") {
    const rule = polkitRule(userInfo().username);
    process.stdout.write(rule);
    // Instructions go to stderr so piping stdout into tee installs only the rule.
    console.error("\nInstall once (needs root); polkit picks up new rules by itself:");
    console.error("  burn-report controls polkit-rule | sudo tee /etc/polkit-1/rules.d/49-burn-power-mode.rules >/dev/null");
    return 0;
  }
  const config = loadConfig();
  if (action === "enable" || action === "disable") {
    if (feature !== "power-mode")
      throw new Error(`controls ${action} needs a control name: ${CONTROLS.join(", ")}`);
    saveConfig({ ...config, controls: { ...config.controls, powerMode: action === "enable" } });
    console.log(`power-mode ${action === "enable" ? "enabled" : "disabled"}. Restart the daemon to apply.`);
    if (action === "enable" && platform() !== "linux")
      console.log("Note: power-mode control currently works on Linux only; other systems will not advertise it.");
    return 0;
  }
  if (action !== "status") throw new Error(`Unknown controls action: ${action} (status, enable, disable, polkit-rule)`);
  const enabled = config.controls?.powerMode === true;
  console.log(`power-mode   ${enabled ? "enabled" : "off (burn-report controls enable power-mode)"}`);
  const controller = new PowerModeController();
  if (!(await controller.supported())) {
    console.log("             no power modes found (needs power-profiles-daemon or /sys/firmware/acpi/platform_profile)");
    return enabled ? 1 : 0;
  }
  const state = await controller.state();
  console.log(`backend      ${state.backend}`);
  console.log(`mode         ${state.mode ?? "unknown"} (of ${state.modes.join(", ")})${state.degraded ? ` — degraded: ${state.degraded}` : ""}`);
  for (const fan of state.fans)
    console.log(`fan          ${fan.label}: ${fan.rpm} rpm${fan.maxRpm ? ` of ${fan.maxRpm}` : ""}`);
  return 0;
}
