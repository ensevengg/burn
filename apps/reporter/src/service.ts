/**
 * `burn-report install-service`: start the daemon with the machine and
 * restart it whenever it exits. A daemon in a terminal dies with the
 * terminal, and "machine offline" on the phone is usually exactly that.
 *
 * Linux gets a systemd user unit with lingering, so it starts at boot without
 * a login. Windows gets a hidden sign-in launcher in the per-user Run key (no
 * administrator rights needed). WSL registers the same Windows launcher to
 * start its distro. macOS prints a launchd agent. The daemon follows
 * Tailscale, so it may start before Tailscale connects.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve, win32 } from "node:path";
import { configDir, loadOrInitConfig } from "./config.js";

const UNIT = "burn-report.service";
const RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

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

/** The service's environment. Service managers start with a minimal PATH,
 * which would hide burn-events, bun and tailscale, so the installing shell's
 * is kept, minus `bun run`'s package-local and temporary entries. Config and
 * exporter overrides are carried over, made absolute. */
export function serviceEnv(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): Record<string, string> {
  const path = [dirname(execPath), ...(env["PATH"] ?? "").split(delimiter)].filter(
    (entry) => entry && !entry.includes("node_modules") && !entry.startsWith(tmpdir()),
  );
  const vars: Record<string, string> = { PATH: [...new Set(path)].join(delimiter) };
  const config = env["BURN_CONFIG_DIR"];
  if (config) vars["BURN_CONFIG_DIR"] = resolve(config);
  const exporter = env["BURN_EVENTS_BIN"];
  if (exporter) vars["BURN_EVENTS_BIN"] = /[\\/]/.test(exporter) ? resolve(exporter) : exporter;
  return vars;
}

/** systemd expands `%` specifiers everywhere and `$` variables in ExecStart. */
function quoteUnit(value: string, exec = false): string {
  let escaped = value.replace(/%/g, "%%");
  if (exec) escaped = escaped.replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped) ? escaped : `"${escaped.replace(/(["\\])/g, "\\$1")}"`;
}

export function systemdUnit(
  command: string[],
  env: Record<string, string>,
  extraArgs: string[] = [],
): string {
  return `[Unit]
Description=burn-report daemon (AI token usage for the burn phone app)
Documentation=https://github.com/ensevengg/burn
After=network-online.target tailscaled.service
Wants=network-online.target
# Keep retrying: a missing tool or busy port can be fixed while it waits.
StartLimitIntervalSec=0

[Service]
ExecStart=${[...command, ...extraArgs].map((part) => quoteUnit(part, true)).join(" ")}
${Object.entries(env).map(([key, value]) => `Environment=${quoteUnit(`${key}=${value}`)}`).join("\n")}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function systemdUnitPath(): string {
  return join(unitDir(), UNIT);
}

const unitDir = () =>
  join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "systemd", "user");

/** Hand-written units that ran this reporter would hold its port. */
export function legacyUnits(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    if (name === UNIT || !name.endsWith(".service")) return false;
    const text = readFileSync(join(dir, name), "utf8");
    return /burn-report|apps[\\/]reporter/.test(text) && /^ExecStart=.*\b(daemon|serve)\b/m.test(text);
  });
}

function launchdPlist(command: string[], extraArgs: string[], env: Record<string, string>): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.burn.report</string>
  <key>ProgramArguments</key><array>
${[...command, ...extraArgs].map((part) => `    <string>${escape(part)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([key, value]) => `<key>${escape(key)}</key><string>${escape(value)}</string>`)
    .join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`;
}

const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** MSVCRT command-line quoting; Windows PowerShell joins Start-Process
 * arguments without quoting them. */
export function windowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Hidden supervisor loop: one instance per sign-in session, logs beside it. */
export function windowsLauncher(
  name: string,
  dir: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): string {
  return [
    "# Generated by burn-report install-service: keeps the reporter running.",
    `$mutex = New-Object System.Threading.Mutex($false, ${psString(`Local\\${name}`)})`,
    // An abandoned mutex (killed launcher) is acquired, not held elsewhere.
    "try { if (-not $mutex.WaitOne(0)) { exit } } catch [System.Threading.AbandonedMutexException] {}",
    ...Object.entries(env).map(([key, value]) =>
      key === "PATH"
        ? `$env:PATH = ${psString(value + ";")} + $env:PATH`
        : `$env:${key} = ${psString(value)}`,
    ),
    "while ($true) {",
    `  Start-Process -FilePath ${psString(command)} -ArgumentList ${psString(args.map(windowsArg).join(" "))} -NoNewWindow -Wait` +
      ` -RedirectStandardOutput ${psString(win32.join(dir, `${name}.log`))} -RedirectStandardError ${psString(win32.join(dir, `${name}.err.log`))}`,
    "  Start-Sleep -Seconds 10",
    "}",
    "",
  ].join("\r\n");
}

/** Stop launchers and the daemons they started (never the installer itself).
 * `program` is the compiled binary or the CLI script the daemon runs. */
function windowsStop(launcher: string, program: string): string {
  return [
    "Get-CimInstance Win32_Process | Where-Object {",
    `  $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains(${psString(launcher)}) -or`,
    `  ($_.CommandLine.Contains(${psString(program)}) -and $_.CommandLine -match ' (daemon|serve)( |$)'))`,
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("\r\n");
}

/** Replace any running launcher, register it for sign-in and start it hidden. */
export function windowsInstallScript(name: string, launcher: string, program: string): string {
  const start = `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${windowsArg(launcher)}`;
  return [
    windowsStop(launcher, program),
    `Set-ItemProperty -Path ${psString(RUN_KEY)} -Name ${psString(name)} -Value ${psString(`powershell.exe ${start}`)}`,
    `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList ${psString(start)}`,
  ].join("\r\n");
}

export function windowsUninstallScript(name: string, launcher: string, program: string): string {
  return [
    windowsStop(launcher, program),
    `Remove-ItemProperty -Path ${psString(RUN_KEY)} -Name ${psString(name)} -ErrorAction SilentlyContinue`,
  ].join("\r\n");
}

function run(label: string, command: string[], check = true): { ok: boolean; stdout: string } {
  const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8" });
  const ok = result.status === 0;
  if (check && !ok) {
    const detail = (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return { ok, stdout: result.stdout ?? "" };
}

function powershell(label: string, script: string): string {
  return run(label, [
    "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ]).stdout.trim();
}

type Target = "linux" | "windows" | "wsl" | "macos";
function target(): Target {
  if (platform() === "win32") return "windows";
  if (platform() === "darwin") return "macos";
  return process.env["WSL_DISTRO_NAME"] ? "wsl" : "linux";
}

/** Windows-side launcher identity and paths for the current Windows or WSL user. */
function windowsPaths(kind: "windows" | "wsl") {
  const distro = (process.env["WSL_DISTRO_NAME"] ?? "").replace(/[^A-Za-z0-9._-]/g, "-");
  const name = kind === "wsl" ? `burn-report-wsl-${distro}` : "burn-report";
  if (kind === "windows") {
    const dir = configDir();
    return { name, dir, local: dir, launcher: win32.join(dir, `${name}.ps1`) };
  }
  const appData = powershell("Locating the Windows app-data folder", "[Environment]::GetFolderPath('ApplicationData')");
  const dir = win32.join(appData, "burn");
  const local = run("wslpath", ["wslpath", "-u", dir]).stdout.trim();
  return { name, dir, local, launcher: win32.join(dir, `${name}.ps1`) };
}

/** The binary or script that identifies this reporter's daemon processes. */
const programOf = (command: string[]) => command[command.length - 2]!;

/** Linux-side daemons from this install (not this process) under WSL. */
function stopWslDaemons(program: string): void {
  const pattern = `${program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (daemon|serve)`;
  const found = run("pgrep", ["pgrep", "-f", pattern], false).stdout;
  for (const pid of found.split(/\s+/).filter(Boolean).map(Number)) {
    if (pid !== process.pid) {
      try { process.kill(pid); } catch { /* already exited */ }
    }
  }
}

export async function runInstallService(args: Map<string, string>): Promise<number> {
  const extra: string[] = [];
  for (const flag of ["port", "bind"]) {
    const value = args.get(flag);
    if (value) extra.push(`--${flag}`, value);
  }
  const port = args.get("port");
  const portNumber = port === undefined ? 8787 : Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)
    throw new Error("--port must be an integer between 1 and 65535");
  const command = daemonCommand();
  const env = serviceEnv();
  const printOnly = args.has("print");
  const kind = target();

  if (kind === "macos") {
    const plist = join(homedir(), "Library", "LaunchAgents", "dev.burn.report.plist");
    console.log(`Save this as ${plist}, then run: launchctl load -w ${plist}\n`);
    console.log(launchdPlist(command, extra, env));
    return 0;
  }

  if (kind === "linux") {
    const unit = systemdUnit(command, env, extra);
    const path = systemdUnitPath();
    if (printOnly) {
      process.stdout.write(unit);
      console.error(`\nWould be written to ${path}`);
      return 0;
    }
    // Name the machine now rather than on the service's first start.
    loadOrInitConfig();
    run("systemd user manager", ["systemctl", "--user", "show-environment"]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit);
    for (const legacy of legacyUnits(unitDir())) {
      run(`Disabling ${legacy}`, ["systemctl", "--user", "disable", "--now", legacy], false);
      console.log(`disabled older reporter unit ${legacy} (its file is kept)`);
    }
    run("systemctl daemon-reload", ["systemctl", "--user", "daemon-reload"]);
    run(`Enabling ${UNIT}`, ["systemctl", "--user", "enable", UNIT]);
    // Restart, not start: a reinstall must pick up the new unit.
    run(`Starting ${UNIT}`, ["systemctl", "--user", "restart", UNIT]);
    const user = userInfo().username;
    const linger = run("loginctl", ["loginctl", "show-user", user, "--property=Linger", "--value"], false);
    if (linger.stdout.trim() !== "yes" && !run("loginctl enable-linger", ["loginctl", "enable-linger", user], false).ok)
      console.warn(`warning: could not enable lingering, so ${UNIT} starts at login rather than boot. Run: sudo loginctl enable-linger ${user}`);
    console.log(`installed ${path}: starts at boot and restarts if it exits`);
    console.log(`Status: systemctl --user status burn-report   Logs: journalctl --user -u burn-report -f`);
    return 0;
  }

  const [program, ...rest] = [...command, ...extra];
  const distro = process.env["WSL_DISTRO_NAME"] ?? "";
  const launcherFor = (name: string, dir: string) => kind === "windows"
    ? windowsLauncher(name, dir, program!, rest, env)
    : windowsLauncher(name, dir, "wsl.exe", [
        "-d", distro, "--exec", "/usr/bin/env",
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        program!, ...rest,
      ], {});
  if (printOnly) {
    process.stdout.write(launcherFor(kind === "wsl" ? `burn-report-wsl-${distro}` : "burn-report", "<config dir>"));
    return 0;
  }
  loadOrInitConfig();
  const paths = windowsPaths(kind);
  mkdirSync(paths.local, { recursive: true });
  // Windows PowerShell reads BOM-less scripts in the ANSI code page.
  writeFileSync(join(paths.local, `${paths.name}.ps1`), `\uFEFF${launcherFor(paths.name, paths.dir)}`);
  if (kind === "wsl") stopWslDaemons(programOf(command));
  powershell("Registering the sign-in launcher", windowsInstallScript(paths.name, paths.launcher, programOf(command)));
  console.log(`installed ${paths.launcher}: starts when you sign in to Windows and restarts if it exits`);
  console.log(`Logs: ${win32.join(paths.dir, `${paths.name}.log`)} (and .err.log)`);
  if (kind === "wsl")
    console.log("WSL is reachable over the tailnet with mirrored networking (networkingMode=mirrored in .wslconfig) or Tailscale installed in the distro. Give it a different --port from the Windows reporter.");
  return 0;
}

export function runUninstallService(): number {
  const kind = target();
  const command = daemonCommand();
  if (kind === "macos") {
    const plist = join(homedir(), "Library", "LaunchAgents", "dev.burn.report.plist");
    console.log(`Run: launchctl unload -w ${plist} && rm ${plist}`);
    return 0;
  }
  if (kind === "linux") {
    run(`Disabling ${UNIT}`, ["systemctl", "--user", "disable", "--now", UNIT], false);
    rmSync(systemdUnitPath(), { force: true });
    run("systemctl daemon-reload", ["systemctl", "--user", "daemon-reload"], false);
    console.log(`removed ${UNIT}`);
    return 0;
  }
  const paths = windowsPaths(kind);
  powershell("Removing the sign-in launcher", windowsUninstallScript(paths.name, paths.launcher, programOf(command)));
  if (kind === "wsl") stopWslDaemons(programOf(command));
  rmSync(join(paths.local, `${paths.name}.ps1`), { force: true });
  console.log(`removed the ${paths.name} sign-in launcher`);
  return 0;
}
