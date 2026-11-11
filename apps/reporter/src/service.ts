/**
 * `burn-report install-service`: keep the daemon running across logins and
 * reboots. A daemon in a terminal dies with the terminal, and "machine
 * offline" on the phone is usually exactly that.
 *
 * Linux (and WSL with systemd) gets a systemd user unit, written and enabled
 * here. Windows and macOS print the one command that registers the daemon
 * with their own scheduler; nothing is executed on those systems.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawnRunner } from "./tokscale.js";

/** How this process was started, so the service starts it the same way:
 * a compiled burn-report is just its own path; from a checkout it is the
 * runtime plus the entry script. */
export function daemonCommand(
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1],
): string[] {
  const compiled = script === undefined || script.includes("$bunfs") || script.includes("~BUN");
  return compiled ? [execPath, "daemon"] : [execPath, script, "daemon"];
}

function quoteUnit(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/** systemd user unit. PATH is copied from the installing shell: a user unit
 * starts with a minimal one, which would hide burn-events, bun and tailscale. */
export function systemdUnit(command: string[], pathEnv: string, extraArgs: string[] = []): string {
  return `[Unit]
Description=burn-report daemon (AI token usage for the burn phone app)
Documentation=https://github.com/ensevengg/burn
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
ExecStart=${[...command, ...extraArgs].map(quoteUnit).join(" ")}
Environment=${quoteUnit(`PATH=${pathEnv}`)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function systemdUnitPath(): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "systemd", "user", "burn-report.service");
}

function windowsCommand(command: string[], extraArgs: string[]): string {
  const run = [...command, ...extraArgs].map((part) => (/\s/.test(part) ? `\\"${part}\\"` : part)).join(" ");
  return `schtasks /Create /F /SC ONLOGON /TN burn-report /TR "${run}"`;
}

function launchdPlist(command: string[], extraArgs: string[], pathEnv: string): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.burn.report</string>
  <key>ProgramArguments</key><array>
${[...command, ...extraArgs].map((part) => `    <string>${escape(part)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`;
}

export async function runInstallService(args: Map<string, string>): Promise<number> {
  const extra: string[] = [];
  for (const flag of ["port", "bind"]) {
    const value = args.get(flag);
    if (value) extra.push(`--${flag}`, value);
  }
  const command = daemonCommand();
  const pathEnv = process.env["PATH"] ?? "";
  const printOnly = args.has("print");

  if (platform() === "win32") {
    console.log("Run this once (in a terminal as yourself) to start burn-report at every sign-in:\n");
    console.log(`  ${windowsCommand(command, extra)}`);
    console.log("\nRemove it with: schtasks /Delete /TN burn-report /F");
    return 0;
  }
  if (platform() === "darwin") {
    const target = join(homedir(), "Library", "LaunchAgents", "dev.burn.report.plist");
    console.log(`Save this as ${target}, then run: launchctl load -w ${target}\n`);
    console.log(launchdPlist(command, extra, pathEnv));
    return 0;
  }

  const unit = systemdUnit(command, pathEnv, extra);
  const target = systemdUnitPath();
  if (printOnly) {
    process.stdout.write(unit);
    console.error(`\nWould be written to ${target}`);
    return 0;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, unit);
  console.log(`wrote ${target}`);
  try {
    await spawnRunner({ command: "systemctl", prefix: ["--user"] }, ["daemon-reload"], 15_000);
    await spawnRunner({ command: "systemctl", prefix: ["--user"] }, ["enable", "--now", "burn-report.service"], 30_000);
  } catch (err) {
    console.error(`systemd did not take the unit: ${(err as Error).message}`);
    console.error("Is this a systemd user session? Start it by hand with: systemctl --user enable --now burn-report");
    return 1;
  }
  console.log("burn-report is running and will start at every login.");
  console.log(`To keep it running while you are signed out: sudo loginctl enable-linger ${userInfo().username}`);
  console.log("Status: systemctl --user status burn-report   Logs: journalctl --user -u burn-report -f");
  return 0;
}
