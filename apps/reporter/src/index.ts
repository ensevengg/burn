#!/usr/bin/env bun
import { runDaemon, runDoctor, runInit, runUsage } from "./commands.js";
import { runServe } from "./serve.js";

function usage(): void {
  console.log(`burn-report — serve AI token usage to your phone over Tailscale

Usage: npx burn-report <command> [flags]

  init      Configure this machine: --slug --name
            [--os windows|wsl|linux|macos] [--host-group g] [--tz Asia/Kolkata]
            [--tokscale-pin version]
  doctor    Verify config, tokscale pin, burn-events exporter and Tailscale
  usage     Print vendor quota JSON from tokscale for local diagnostics
  daemon    Resident read-only machine backend [--port 8787] [--bind ip]
  serve     Alias for daemon
  help      This text

Add the server's printed URL on the phone's Machines tab.
Docs: https://github.com/ensevengg/burn`);
}

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
try {
  const allowed = command === "init"
    ? ["slug", "name", "os", "host-group", "tz", "tokscale-pin", "direct"]
    : command === "daemon" || command === "serve" ? ["bind", "port"] : [];
  const args = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") || !allowed.includes(arg.slice(2)))
      throw new Error(`Unknown argument: ${arg} (try 'npx burn-report help')`);
    const name = arg.slice(2);
    // Compatibility with previously documented machine-only init commands.
    if (name === "direct") { args.set(name, ""); continue; }
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
    case "help": case "--help": case "-h": usage(); break;
    default: throw new Error(`Unknown command: ${command} (try 'npx burn-report help')`);
  }
} catch (err) {
  console.error(`burn-report: ${(err as Error).message}`);
  process.exitCode = 1;
}
