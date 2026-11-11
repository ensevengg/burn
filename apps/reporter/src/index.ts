#!/usr/bin/env bun
import { runControls, runDaemon, runDoctor, runInit, runUsage } from "./commands.js";
import { runServe } from "./serve.js";
import { runInstallService } from "./service.js";

function usage(): void {
  console.log(`burn-report — serve AI token usage to your phone over Tailscale

Usage: burn-report <command> [flags]

  daemon    Resident machine backend [--port 8787] [--bind ip]. On a new
            machine this is the only command needed: it names the machine
            after its hostname and waits for Tailscale.
  init      Name this machine (all optional): [--slug s] [--name "Name"]
            [--os windows|wsl|linux|macos] [--host-group g] [--tz zone]
            [--tokscale-pin version]
  install-service
            Start the daemon at every login [--port n] [--bind ip] [--print]
  doctor    Verify config, tokscale pin, burn-events exporter and Tailscale
  usage     Print vendor quota JSON from tokscale for local diagnostics
  serve     Alias for daemon
  controls  Opt-in machine controls: status | enable power-mode |
            disable power-mode | polkit-rule
  help      This text

Then add the machine's Tailscale name or address on the phone's Machines tab.
Docs: https://github.com/ensevengg/burn`);
}

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
    if (!arg.startsWith("--") || !allowed.includes(arg.slice(2)))
      throw new Error(`Unknown argument: ${arg} (try 'npx burn-report help')`);
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
    case "controls":
      if (argv.length > 3) throw new Error("usage: burn-report controls [status|enable|disable|polkit-rule] [power-mode]");
      process.exitCode = await runControls(argv[1] ?? "status", argv[2]);
      break;
    case "help": case "--help": case "-h": usage(); break;
    default: throw new Error(`Unknown command: ${command} (try 'npx burn-report help')`);
  }
} catch (err) {
  console.error(`burn-report: ${(err as Error).message}`);
  process.exitCode = 1;
}
