import {
  eventFingerprint,
  eventIndexKey,
  loadEventIndex,
  saveEventIndex,
  lockPush,
} from "./event-index";
import { type MachineSnapshots, snapshotsFor } from "./snapshots";
import {
  BurnBackendError,
  EVENT_EXPORT_SCHEMA,
  type IngestQuotaInput,
  type ReporterSyncApi,
} from "@burn/sync-api";
import { reporterApiFor } from "./backend.js";
import {
  configSchema,
  loadConfig,
  loadCursor,
  saveConfig,
  saveCursor,
  configPath,
  setupSqlPath,
  type BurnConfig,
} from "./config.js";
import { renderSetupSql } from "./setup-sql.js";
import { generateToken } from "./tokens.js";
import {
  currentUtcOffsetMinutes,
  fetchUsage,
  REPORTER_VERSION,
  tokscaleQuotaInputs,
  tokscaleVersion,
  TokscaleError,
} from "./tokscale.js";
import { planBatches } from "./events.js";
import { exporterVersion } from "./exporter.js";
import {
  quotaAccountKey,
  quotaMetricLabel,
  TOKSCALE_PIN,
} from "@burn/sync-api";
import { writeFileSync } from "node:fs";
import { platform } from "node:os";

// Shared with the live server (serve.ts) — re-exported for compatibility.
export {
  REPORTER_VERSION,
  tokscaleQuotaInputs,
  currentUtcOffsetMinutes,
} from "./tokscale.js";

export function detectOsKind(): "windows" | "wsl" | "linux" | "macos" {
  if (platform() === "win32") return "windows";
  if (platform() === "darwin") return "macos";
  if (platform() === "linux" && process.env["WSL_DISTRO_NAME"]) return "wsl";
  return "linux";
}

export function printConfigured(config: BurnConfig): void {
  console.log(
    `environment  ${config.environmentSlug} (${config.environmentName})`,
  );
  console.log(
    `backend      ${config.mode === "direct" ? "direct (Tailscale)" : config.supabaseUrl}`,
  );
  console.log(`tokscale pin ${config.tokscalePin}`);
  console.log(`interval     every ${config.intervalMinutes} min`);
}

// ── init ─────────────────────────────────────────────────────────────────────

export function runInit(args: Map<string, string>): void {
  const direct = args.has("direct");
  const missing = (
    direct ? ["slug", "name"] : ["url", "key", "slug", "name"]
  ).filter((k) => !args.get(k));
  if (missing.length > 0) {
    throw new Error(
      `init requires --url <supabase-url> --key <publishable-key> --slug <env-slug> --name <display-name>\n` +
        `optional: --os <windows|wsl|linux|macos> --host-group <group> --tz <IANA zone>`,
    );
  }
  const ingestToken = generateToken();
  const readToken = generateToken();
  const config = configSchema.parse({
    mode: direct ? "direct" : "cloud",
    ...(direct
      ? {}
      : {
          supabaseUrl: args.get("url")!.replace(/\/+$/, ""),
          publishableKey: args.get("key")!,
          ingestToken,
        }),
    environmentSlug: args.get("slug")!,
    environmentName: args.get("name")!,
    hostGroup: args.get("host-group") ?? null,
    osKind: (args.get("os") ?? detectOsKind()) as BurnConfig["osKind"],
    reportingTimezone: args.get("tz") ?? "Asia/Kolkata",
    intervalMinutes: Number(args.get("interval") ?? 10),
    tokscalePin: args.get("tokscale-pin") ?? TOKSCALE_PIN,
  });
  saveConfig(config);
  if (direct) {
    console.log(
      `Configured ${config.environmentName}. Run burn-report serve, then add its printed URL on your phone. Cloud backup is optional.`,
    );
    return;
  }
  const setupSql = renderSetupSql({ config, ingestToken, readToken });
  writeFileSync(setupSqlPath(), setupSql, { mode: 0o600 });

  console.log("burn-report initialized.\n");
  printConfigured(config);
  console.log(`\nconfig       ${configPath()}`);
  console.log("\nNext steps (one-time):");
  console.log(
    `  1. Apply every supabase/migrations/*.sql file in numeric order in your project's SQL editor.`,
  );
  console.log(
    `  2. Paste ${setupSqlPath()} into the SQL editor (registers this machine + your phone).`,
  );
  console.log(
    `  3. Phone app → Settings → Connect: paste the same URL + publishable key and this read token:`,
  );
  console.log(
    `\nREAD TOKEN (store it in the app; it is shown only once):\n  ${readToken}`,
  );
  console.log(
    `\nINGEST TOKEN (already saved to config.json; shown only once):\n  ${ingestToken}`,
  );
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
    detail: tokscale
      ? `reachable at pin ${config.tokscalePin}`
      : `npx tokscale@${config.tokscalePin} failed`,
  });

  const exporter = await exporterVersion();
  checks.push({
    name: "burn-events",
    ok: exporter !== null && exporter === config.tokscalePin,
    detail:
      exporter === null
        ? "exporter not found — cargo install --path crates/burn-events (or set BURN_EVENTS_BIN)"
        : exporter === config.tokscalePin
          ? `matches pin ${config.tokscalePin}`
          : `version ${exporter} ≠ pin ${config.tokscalePin} — rebuild: cargo install --path crates/burn-events`,
  });

  if (config.mode === "direct") {
    printChecks(checks);
    return checks.every((c) => c.ok) ? 0 : 1;
  }
  const reporter = reporterApiFor(config);
  try {
    const beat = await reporter.heartbeat({
      reporterVersion: REPORTER_VERSION,
      tokscaleVersion: tokscale,
      exportSchema: EVENT_EXPORT_SCHEMA,
      reportingTimezone: config.reportingTimezone,
    });
    checks.push({
      name: "backend",
      ok: true,
      detail: `heartbeat accepted (${beat.slug})`,
    });
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

  const cursor = loadCursor(config);
  checks.push({
    name: "cursor",
    ok: true,
    detail: `last revision ${cursor.lastRevision}`,
  });

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
    console.log(
      "tokscale found no quota providers with credentials on this machine.",
    );
    return 0;
  }
  if (config.mode === "direct") {
    console.log(JSON.stringify(outputs, null, 2));
    return 0;
  }
  const reporter = reporterApiFor(config);
  try {
    const pushed = await reporter.pushQuotaSnapshots(
      tokscaleQuotaInputs(outputs),
    );
    console.log(
      `pushed ${pushed.snapshots} quota snapshot(s) for ${outputs.length} provider(s)`,
    );
    return 0;
  } catch (err) {
    await reporter
      .reportError(`usage: ${(err as Error).message}`, "quotas")
      .catch(() => {});
    throw err;
  }
}

// ── push (usage events, D2 seam) ─────────────────────────────────────────────

export interface PushOutcome {
  rows: number;
  changed: number;
  revision: number;
  batches: number;
}

/** Share the full normalized machine snapshot with live reads. Persist hashes
 * only after every batch is acknowledged, so lost responses replay safely.
 * Comparing content catches corrections and late rows regardless of event time. */
export async function pushEvents(
  config: BurnConfig,
  reporter: ReporterSyncApi,
  options: { full?: boolean; snapshots?: Pick<MachineSnapshots, "get"> } = {},
): Promise<PushOutcome> {
  const release = lockPush(config);
  try {
    const snapshot = await (
      options.snapshots ?? snapshotsFor(config).events
    ).get(options.full);
    const cursor = loadCursor(config);
    const index = loadEventIndex(config);
    const inputs = snapshot.events.filter(
      (event) =>
        options.full || index[eventIndexKey(event)] !== eventFingerprint(event),
    );
    const batches = planBatches(inputs);
    let changed = 0;
    let revision = cursor.lastRevision;
    if (batches.length === 0)
      revision = (await reporter.ingestEvents([])).revision;
    for (const [i, batch] of batches.entries()) {
      const out = await reporter.ingestEvents(batch);
      changed += out.changed;
      revision = out.revision;
      if (batches.length > 1)
        console.log(
          `[push] batch ${i + 1}/${batches.length}: ${batch.length} rows, ${out.changed} changed`,
        );
    }
    // Retain older identities if source logs were rotated; history is append-only.
    for (const event of snapshot.events)
      index[eventIndexKey(event)] = eventFingerprint(event);
    saveEventIndex(config, index);
    saveCursor(
      {
        lastRevision: revision,
        lastPushAt: new Date(snapshot.startedAtMs).toISOString(),
      },
      config,
    );
    return { rows: inputs.length, changed, revision, batches: batches.length };
  } finally {
    release();
  }
}

export async function runPush(args: Map<string, string>): Promise<number> {
  const config = loadConfig();
  const reporter = reporterApiFor(config);
  await reporter
    .heartbeat({
      reporterVersion: REPORTER_VERSION,
      tokscaleVersion: await tokscaleVersion(config.tokscalePin),
      exportSchema: EVENT_EXPORT_SCHEMA,
      reportingTimezone: config.reportingTimezone,
    })
    .catch(async (err) => {
      console.warn(`heartbeat: ${(err as Error).message}`);
      await reporter
        .reportError((err as Error).message, "heartbeat")
        .catch(() => {});
    });
  return pushMachineData(config, reporter, args.has("full"));
}

/** One machine cycle: independent event and quota sources, shared scoped ingest API. */
export async function pushMachineData(
  config: BurnConfig,
  reporter: ReporterSyncApi,
  full = false,
  sources: { events: typeof pushEvents; quotas: typeof fetchUsage } = {
    events: pushEvents,
    quotas: fetchUsage,
  },
): Promise<number> {
  // Scheduled push is the reliability floor for both events and quotas.
  // Neither channel waits for the other, and either can succeed independently.
  const results = await Promise.allSettled([
    (async () => {
      try {
        const outcome = await sources.events(config, reporter, { full });
        console.log(
          `push: ${outcome.rows} row(s), ${outcome.changed} changed; revision ${outcome.revision}`,
        );
      } catch (err) {
        await reporter
          .reportError(`push: ${(err as Error).message}`, "events")
          .catch(() => {});
        throw err;
      }
    })(),
    (async () => {
      try {
        const quotas =
          sources.quotas === fetchUsage
            ? await snapshotsFor(config)
                .quotas.get()
                .then((page) =>
                  page.quotas.map((q) => ({
                    ...q,
                    fetchedAt: page.generatedAt,
                  })),
                )
            : tokscaleQuotaInputs(await sources.quotas(config.tokscalePin));
        if (quotas.length > 0) {
          const result = await reporter.pushQuotaSnapshots(quotas);
          console.log(`push: ${result.snapshots} quota snapshot(s)`);
        } else {
          console.log(
            "push: no quota providers with credentials on this machine",
          );
        }
      } catch (err) {
        await reporter
          .reportError(`usage: ${(err as Error).message}`, "quotas")
          .catch(() => {});
        throw err;
      }
    })(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [String(result.reason)] : [],
  );
  if (failures.length > 0) throw new Error(failures.join("; "));
  return 0;
}

// ── daemon (D1: resident eager path + scheduled fallback + live server) ──────

export async function runDaemon(
  args: Map<string, string> = new Map(),
): Promise<void> {
  const config = loadConfig();
  if (config.mode === "direct") {
    if (args.has("no-live"))
      throw new Error(
        "Direct-only daemon needs its live server; omit --no-live",
      );
    const { runServe } = await import("./serve");
    return runServe(args);
  }
  const reporter = reporterApiFor(config);
  const intervalMs = config.intervalMinutes * 60_000;
  let lastPush = 0;

  // The live server rides the daemon (D1 v2). Failure to bind must not kill
  // the push floor — it is an enhancement, logged and skipped.
  const liveOptions: { bind?: string; port?: number } = {};
  const bindArg = args.get("bind");
  if (bindArg) liveOptions.bind = bindArg;
  const portArg = args.get("port");
  if (portArg) liveOptions.port = Number(portArg);
  let liveUrl: string | null = args.get("live-url") ?? null;
  let live: import("./serve.js").LiveServerHandle | null = null;
  if (!args.has("no-live")) {
    try {
      const { startLiveServer } = await import("./serve.js");
      live = await startLiveServer(config, liveOptions);
      liveUrl ??= live.url;
      console.log(`[live] serving ${liveUrl}`);
    } catch (err) {
      console.warn(`[live] not started: ${(err as Error).message}`);
    }
  }

  const cycle = async (reason: string): Promise<boolean> => {
    const started = Date.now();
    try {
      await reporter.heartbeat({
        reporterVersion: REPORTER_VERSION,
        tokscaleVersion: await tokscaleVersion(config.tokscalePin),
        exportSchema: EVENT_EXPORT_SCHEMA,
        reportingTimezone: config.reportingTimezone,
        ...(liveUrl !== null ? { liveEndpoint: liveUrl } : {}),
      });
    } catch (err) {
      const message =
        err instanceof BurnBackendError ? err.message : (err as Error).message;
      console.error(`[daemon] ${reason}: heartbeat: ${message}`);
      await reporter
        .reportError(`heartbeat: ${message}`, "heartbeat")
        .catch(() => {});
    }
    try {
      await pushMachineData(config, reporter);
      console.log(`[daemon] ${reason}: ok (${Date.now() - started}ms)`);
      lastPush = Date.now();
      return true;
    } catch (err) {
      console.error(`[daemon] ${reason}: ${(err as Error).message}`);
      return false;
    }
  };

  console.log(
    `[daemon] resident mode: polling sync_requests every 30s, scheduled push every ${config.intervalMinutes} min`,
  );
  await cycle("startup");
  let polling = false;
  const poller = setInterval(() => {
    if (polling) return;
    polling = true;
    const scheduled = Date.now() - lastPush >= intervalMs;
    void (async () => {
      try {
        const { requests } = await reporter.pollSyncRequests();
        if (requests.length > 0) {
          const success = await cycle(`sync request ×${requests.length}`);
          await reporter.completeSyncRequests?.(
            requests.map((r) => r.generation),
            success,
          );
        } else if (scheduled) await cycle("scheduled");
      } catch (err) {
        console.error(`[daemon] poll: ${(err as Error).message}`);
        if (scheduled) await cycle("scheduled (poll unavailable)");
      } finally {
        polling = false;
      }
    })();
  }, 30_000);

  await new Promise<never>(() => {
    const shutdown = () => {
      clearInterval(poller);
      live?.stop();
      console.log("\n[daemon] stopped");
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
