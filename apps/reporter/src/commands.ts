import { BurnBackendError, type IngestQuotaInput } from "@burn/sync-api";
import { reporterApiFor } from "./backend.js";
import { loadConfig, loadCursor, saveConfig, configPath, setupSqlPath, type BurnConfig } from "./config.js";
import { renderSetupSql } from "./setup-sql.js";
import { generateToken } from "./tokens.js";
import { fetchUsage, tokscaleVersion, TokscaleError } from "./tokscale.js";
import { quotaAccountKey, quotaMetricLabel, TOKSCALE_PIN } from "@burn/sync-api";
import { writeFileSync } from "node:fs";
import { platform } from "node:os";

export const REPORTER_VERSION = "0.1.0";

export function detectOsKind(): "windows" | "wsl" | "linux" | "macos" {
  if (platform() === "win32") return "windows";
  if (platform() === "darwin") return "macos";
  if (platform() === "linux" && process.env["WSL_DISTRO_NAME"]) return "wsl";
  return "linux";
}

export function currentUtcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export function tokscaleQuotaInputs(outputs: Awaited<ReturnType<typeof fetchUsage>>): IngestQuotaInput[] {
  const offset = currentUtcOffsetMinutes();
  const inputs: IngestQuotaInput[] = [];
  for (const out of outputs) {
    const accountKey = quotaAccountKey(out.account?.id);
    for (const metric of out.metrics) {
      inputs.push({
        provider: out.provider,
        accountKey,
        accountLabel: out.account?.label ?? null,
        plan: out.plan ?? null,
        metric: quotaMetricLabel(metric.label),
        usedPercent: metric.used_percent,
        remainingPercent: metric.remaining_percent,
        remainingLabel: metric.remaining_label ?? null,
        resetsAt: metric.resets_at ?? null,
        creditStatus: out.credit_status ?? null,
        spendControl: out.spend_control ?? null,
        status: "ok",
        error: null,
        sourceOffsetMinutes: offset,
      });
    }
  }
  return inputs;
}

export function printConfigured(config: BurnConfig): void {
  console.log(`environment  ${config.environmentSlug} (${config.environmentName})`);
  console.log(`backend      ${config.supabaseUrl}`);
  console.log(`tokscale pin ${config.tokscalePin}`);
  console.log(`interval     every ${config.intervalMinutes} min`);
}

// ── init ─────────────────────────────────────────────────────────────────────

export function runInit(args: Map<string, string>): void {
  const missing = ["url", "key", "slug", "name"].filter((k) => !args.get(k));
  if (missing.length > 0) {
    throw new Error(
      `init requires --url <supabase-url> --key <publishable-key> --slug <env-slug> --name <display-name>\n` +
        `optional: --os <windows|wsl|linux|macos> --host-group <group> --tz <IANA zone>`,
    );
  }
  const ingestToken = generateToken();
  const readToken = generateToken();
  const config = {
    supabaseUrl: args.get("url")!.replace(/\/+$/, ""),
    publishableKey: args.get("key")!,
    ingestToken,
    environmentSlug: args.get("slug")!,
    environmentName: args.get("name")!,
    hostGroup: args.get("host-group") ?? null,
    osKind: (args.get("os") ?? detectOsKind()) as BurnConfig["osKind"],
    reportingTimezone: args.get("tz") ?? "Asia/Kolkata",
    intervalMinutes: Number(args.get("interval") ?? 10),
    tokscalePin: args.get("tokscale-pin") ?? TOKSCALE_PIN,
  };
  saveConfig(config);
  const setupSql = renderSetupSql({ config, ingestToken, readToken });
  writeFileSync(setupSqlPath(), setupSql, { mode: 0o600 });

  console.log("burn-report initialized.\n");
  printConfigured(config);
  console.log(`\nconfig       ${configPath()}`);
  console.log("\nNext steps (one-time):");
  console.log(`  1. Paste supabase/migrations/0001_schema.sql into your project's SQL editor, then 0002_api.sql.`);
  console.log(`  2. Paste ${setupSqlPath()} into the SQL editor (registers this machine + your phone).`);
  console.log(`  3. Phone app → Settings → Connect: paste the same URL + publishable key and this read token:`);
  console.log(`\nREAD TOKEN (store it in the app; it is shown only once):\n  ${readToken}`);
  console.log(`\nINGEST TOKEN (already saved to config.json; shown only once):\n  ${ingestToken}`);
  console.log(`\nThen: npx burn-report doctor`);
}

// ── doctor ───────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];
  let config: BurnConfig;
  try {
    config = loadConfig();
    checks.push({ name: "config", ok: true, detail: "valid" });
  } catch (err) {
    checks.push({ name: "config", ok: false, detail: (err as Error).message });
    printChecks(checks);
    return 1;
  }
  printConfigured(config);

  const tokscale = await tokscaleVersion(config.tokscalePin);
  checks.push({
    name: "tokscale",
    ok: tokscale !== null,
    detail: tokscale ? `reachable at pin ${config.tokscalePin}` : `npx tokscale@${config.tokscalePin} failed`,
  });

  const reporter = reporterApiFor(config);
  try {
    const beat = await reporter.heartbeat({
      reporterVersion: REPORTER_VERSION,
      tokscaleVersion: tokscale,
      exportSchema: null,
      reportingTimezone: config.reportingTimezone,
    });
    checks.push({ name: "backend", ok: true, detail: `heartbeat accepted (${beat.slug})` });
  } catch (err) {
    const detail =
      err instanceof BurnBackendError
        ? `${err.message} — did you paste setup-tokens.sql?`
        : (err as Error).message;
    checks.push({ name: "backend", ok: false, detail });
  }

  const offset = currentUtcOffsetMinutes();
  checks.push({
    name: "clock",
    ok: true,
    detail: `UTC offset ${offset >= 0 ? "+" : ""}${offset} min (recorded per row; misconfigurations are auditable, not silent)`,
  });

  const cursor = loadCursor();
  checks.push({ name: "cursor", ok: true, detail: `last revision ${cursor.lastRevision}` });

  printChecks(checks);
  return checks.every((c) => c.ok) ? 0 : 1;
}

function printChecks(checks: Check[]): void {
  for (const check of checks) {
    const mark = check.ok ? "✓" : "✗";
    console.log(`${mark} ${check.name.padEnd(10)} ${check.detail}`);
  }
}

// ── usage (quota snapshots) ──────────────────────────────────────────────────

export async function runUsage(): Promise<number> {
  const config = loadConfig();
  const outputs = await fetchUsage(config.tokscalePin);
  if (outputs.length === 0) {
    console.log("tokscale found no quota providers with credentials on this machine.");
    return 0;
  }
  const reporter = reporterApiFor(config);
  try {
    const pushed = await reporter.pushQuotaSnapshots(tokscaleQuotaInputs(outputs));
    console.log(`pushed ${pushed.snapshots} quota snapshot(s) for ${outputs.length} provider(s)`);
    return 0;
  } catch (err) {
    await reporter.reportError(`usage: ${(err as Error).message}`).catch(() => {});
    throw err;
  }
}

// ── push (usage events) ──────────────────────────────────────────────────────

export async function runPush(): Promise<number> {
  const config = loadConfig();
  const reporter = reporterApiFor(config);
  await reporter.heartbeat({
    reporterVersion: REPORTER_VERSION,
    tokscaleVersion: await tokscaleVersion(config.tokscalePin),
    exportSchema: null,
    reportingTimezone: config.reportingTimezone,
  });
  console.log(
    "push: usage events require the burn-events exporter seam (D2) — deferred post-demo.\n" +
      "      Quota snapshots are live: run `npx burn-report usage`.\n" +
      "      See AGENTS.md → Known deferrals.",
  );
  return 2;
}

// ── daemon (D1: resident eager path + scheduled fallback) ────────────────────

export async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const reporter = reporterApiFor(config);
  const intervalMs = config.intervalMinutes * 60_000;
  let lastPush = 0;

  const cycle = async (reason: string): Promise<void> => {
    const started = Date.now();
    try {
      await reporter.heartbeat({
        reporterVersion: REPORTER_VERSION,
        tokscaleVersion: await tokscaleVersion(config.tokscalePin),
        exportSchema: null,
        reportingTimezone: config.reportingTimezone,
      });
      const quotas = tokscaleQuotaInputs(await fetchUsage(config.tokscalePin));
      if (quotas.length > 0) await reporter.pushQuotaSnapshots(quotas);
      console.log(`[daemon] ${reason}: ok (${Date.now() - started}ms)`);
    } catch (err) {
      const message = err instanceof TokscaleError ? err.message : (err as Error).message;
      console.error(`[daemon] ${reason}: ${message}`);
      await reporter.reportError(`${reason}: ${message}`).catch(() => {});
    }
    lastPush = Date.now();
  };

  console.log(`[daemon] resident mode: polling sync_requests every 30s, scheduled push every ${config.intervalMinutes} min`);
  await cycle("startup");
  const poller = setInterval(() => {
    const scheduled = Date.now() - lastPush >= intervalMs;
    void (async () => {
      try {
        const { requests } = await reporter.pollSyncRequests();
        if (requests.length > 0) await cycle(`sync request ×${requests.length}`);
        else if (scheduled) await cycle("scheduled");
      } catch (err) {
        console.error(`[daemon] poll: ${(err as Error).message}`);
      }
    })();
  }, 30_000);

  await new Promise<never>(() => {
    process.on("SIGINT", () => {
      clearInterval(poller);
      console.log("\n[daemon] stopped");
      process.exit(0);
    });
  });
}
