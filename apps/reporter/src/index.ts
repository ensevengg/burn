#!/usr/bin/env bun
import { runDaemon, runDoctor, runInit, runPush, runUsage } from "./commands.js";

function usage(): never {
  console.log(`burn-report — push AI token usage from this machine to your own Supabase

Usage: npx burn-report <command> [flags]

  init      Configure this machine (once): --url --key --slug --name
            [--os windows|wsl|linux|macos] [--host-group g] [--tz Asia/Kolkata] [--interval 10]
  doctor    Verify config, tokscale pin, backend connectivity, clock
  usage     Fetch vendor quotas (tokscale usage) and push snapshots
  push      Push usage event rows since cursor (needs burn-events exporter)
  daemon    Resident mode: 30s sync-request poll + scheduled push
  help      This text

Docs: https://github.com/ensevengg/burn · AGENTS.md is the rulebook`);
  process.exit(0);
}

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const args = new Map<string, string>();
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) args.set(arg.slice(2), argv[++i] ?? "");
}

try {
  switch (command) {
    case "init":
      runInit(args);
      break;
    case "doctor":
      process.exitCode = await runDoctor();
      break;
    case "usage":
      process.exitCode = await runUsage();
      break;
    case "push":
      process.exitCode = await runPush();
      break;
    case "daemon":
      await runDaemon();
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`Unknown command: ${command} (try 'npx burn-report help')`);
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`burn-report: ${(err as Error).message}`);
  process.exitCode = 1;
}
