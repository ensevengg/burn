#!/usr/bin/env bun
import { runControls, runDaemon, runDoctor, runInit, runUsage } from "./commands.js";
import { runServe } from "./serve.js";
import { runInstallService, runUninstallService } from "./service.js";
import { runPair } from "./pair.js";

function usage(): void {
  console.log(`burn-report — serve AI token usage to your phone over Tailscale

Usage: burn-report <command> [flags]

  daemon    Resident machine backend [--port n] [--bind ip]. On a new
            machine this is the only command needed: it names the machine
            after its hostname and waits for Tailscale.
  init      Name this machine (all optional): [--slug s] [--name "Name"]
            [--os windows|wsl|linux|macos] [--host-group g] [--tz zone]
            [--tokscale-pin version]
  install-service
            Start the daemon at boot (Linux) or sign-in (Windows, WSL) and
            restart it if it exits [--port n] [--bind ip] [--print]
  uninstall-service
            Remove that autostart entry
  pair      Show the QR code and URL that add this machine on the phone
  doctor    Verify config, tokscale pin, burn-events exporter and Tailscale
  usage     Print vendor quota JSON from tokscale for local diagnostics
  serve     Alias for daemon
  controls  Opt-in machine controls: status | enable power-mode |
            disable power-mode | polkit-rule
  help      This text

Then scan 'burn-report pair' on the phone (Machines → + → Scan QR).
Docs: https://github.com/ensevengg/burn`);
}

// Options from the removed upload backend point at their replacement.
const removed = new Map([
  ["no-live", "--no-live ran the removed upload daemon; replace that service with 'burn-report install-service'"],
  ["live-url", "--live-url was removed; add the URL the phone should use (e.g. a tailscale serve HTTPS URL) under Machines → +"],
]);

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
try {
  const allowed = command === "init"
    ? ["slug", "name", "os", "host-group", "tz", "tokscale-pin", "direct"]
    : command === "daemon" || command === "serve" ? ["bind", "port"]
    : command === "install-service" ? ["bind", "port", "print"] : [];
  const args = new Map<string, string>();
  // `controls` takes positional words, not flags.
  for (let i = 1; command !== "controls" && i < argv.length; i++) {
    const arg = argv[i]!;
    const hint = arg.startsWith("--") ? removed.get(arg.slice(2)) : undefined;
    if (hint) throw new Error(hint);
    if (!arg.startsWith("--") || !allowed.includes(arg.slice(2)))
      throw new Error(`Unknown argument: ${arg} (try 'burn-report help')`);
    const name = arg.slice(2);
    // Compatibility with previously documented machine-only init commands.
    if (name === "direct" || name === "print") { args.set(name, ""); continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    args.set(name, value);
  }
  switch (command) {
    case "init": runInit(args); break;
    case "doctor": process.exitCode = await runDoctor(); break;
    case "usage": process.exitCode = await runUsage(); break;
    case "daemon": await runDaemon(args); break;
    case "serve": await runServe(args); break;
    case "install-service": process.exitCode = await runInstallService(args); break;
    case "uninstall-service": process.exitCode = runUninstallService(); break;
    case "pair": process.exitCode = await runPair(); break;
    case "controls":
      if (argv.length > 3) throw new Error("usage: burn-report controls [status|enable|disable|polkit-rule] [power-mode]");
      process.exitCode = await runControls(argv[1] ?? "status", argv[2]);
      break;
    case "help": case "--help": case "-h": usage(); break;
    default: throw new Error(`Unknown command: ${command} (try 'burn-report help')`);
  }
} catch (err) {
  console.error(`burn-report: ${(err as Error).message}`);
  process.exitCode = 1;
}
