/**
 * Live server (D1 v2, docs/adr/0001-tailscale-direct-pull): a read-only HTTP
 * endpoint that serves the not-yet-pushed tail of this machine's event stream
 * to the phone over the tailnet.
 *
 * Auth model: the server binds the tailnet interface (or loopback when no
 * tailnet is detected), so tailnet membership IS the authorization. No tokens
 * cross this boundary — D7's secret surface is unchanged.
 *
 * Everything served is exactly what the next `push` would send: same exporter,
 * same schema gate, same dedup fallback, same cursor-minus-overlap window.
 * The phone merges those rows with revision 0, and the server's own revisioned
 * copy wins the upsert once the real push lands — the two paths converge by
 * construction instead of by reconciliation.
 */
import { EVENT_EXPORT_SCHEMA, type IngestQuotaInput } from "@burn/sync-api";
import { loadConfig, loadCursor, type BurnConfig, type ReporterCursor } from "./config.js";
import {
  exportRowsToIngestInputs,
  parseEventsJsonl,
  pushSinceMs,
} from "./events.js";
import { assertExporterMatchesPin, exporterVersion, fetchEventsJsonl } from "./exporter.js";
import { fetchUsage, spawnRunner, TokscaleError, tokscaleQuotaInputs, REPORTER_VERSION } from "./tokscale.js";

export interface LiveDeps {
  config: BurnConfig;
  now?: () => number;
  cursor?: () => ReporterCursor;
  exporterScan?: (sinceMs: number) => Promise<string>;
  exporterCheck?: () => Promise<string | null>;
  usage?: (pin: string) => Promise<unknown>;
}

export interface LiveServerHandle {
  hostname: string;
  port: number;
  /** What the machine advertises in heartbeats while running. */
  url: string;
  stop(): void;
}

/** Resolve the tailnet IPv4 via the tailscale CLI, or null when absent. */
export async function tailscaleIp(timeoutMs = 5_000): Promise<string | null> {
  try {
    const { stdout } = await spawnRunner({ command: "tailscale", prefix: [] }, ["ip", "-4"], timeoutMs);
    return /^(\d+\.\d+\.\d+\.\d+)\s*$/m.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorText(err: unknown): string {
  if (err instanceof TokscaleError) return err.message;
  return (err as Error).message ?? String(err);
}

/**
 * Pure request handler — Bun.serve-independent so tests exercise it without
 * sockets. `GET /ping`, `GET /live/events`, `GET /live/quotas`; anything else
 * is a 404/405.
 */
export function createLiveFetch(deps: LiveDeps): (req: Request) => Promise<Response> {
  // One exporter scan at a time: it spawns the pinned binary and can take
  // seconds on real histories; overlapping scans would thrash the machine
  // for no information (the second caller gets a 503 and retries).
  let scanInFlight = false;
  const now = deps.now ?? Date.now;

  const pingPayload = () => {
    const cursor = (deps.cursor ?? loadCursor)();
    return {
      protocol: 1 as const,
      slug: deps.config.environmentSlug,
      displayName: deps.config.environmentName,
      hostGroup: deps.config.hostGroup,
      osKind: deps.config.osKind,
      reporterVersion: REPORTER_VERSION,
      tokscaleVersion: null,
      exportSchema: EVENT_EXPORT_SCHEMA,
      reportingTimezone: deps.config.reportingTimezone,
      sinceMs: pushSinceMs(cursor.lastPushAt, false),
      serverNowMs: now(),
    };
  };

  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method !== "GET") return jsonResponse({ error: "GET only" }, 405);
    switch (path) {
      case "/ping":
        return jsonResponse(pingPayload());
      case "/live/events": {
        if (scanInFlight) return jsonResponse({ error: "an events scan is already running" }, 503);
        scanInFlight = true;
        try {
          const exporter = await (deps.exporterCheck ?? exporterVersion)();
          if (exporter === null) {
            return jsonResponse({ error: "burn-events exporter not found on this machine" }, 503);
          }
          assertExporterMatchesPin(exporter, deps.config.tokscalePin);
          const cursor = (deps.cursor ?? loadCursor)();
          const sinceMs = pushSinceMs(cursor.lastPushAt, false);
          const rows = parseEventsJsonl(await (deps.exporterScan ?? fetchEventsJsonl)(sinceMs));
          // The exact transform the push path applies: dedup fallback derived,
          // cost → decimal string, timezone shim, parser version pinned. The
          // phone receives the same rows its Supabase twin will have.
          const events = exportRowsToIngestInputs(rows, deps.config.tokscalePin);
          return jsonResponse({ sinceMs, generatedAt: new Date(now()).toISOString(), events });
        } catch (err) {
          return jsonResponse({ error: errorText(err) }, 500);
        } finally {
          scanInFlight = false;
        }
      }
      case "/live/quotas": {
        try {
          const outputs = await (deps.usage ?? fetchUsage)(deps.config.tokscalePin);
          const quotas: IngestQuotaInput[] = tokscaleQuotaInputs(
            outputs as Awaited<ReturnType<typeof fetchUsage>>,
          );
          return jsonResponse({ generatedAt: new Date(now()).toISOString(), quotas });
        } catch (err) {
          return jsonResponse({ error: errorText(err) }, 500);
        }
      }
      default:
        return jsonResponse({ error: "not found" }, 404);
    }
  };
}

/**
 * Bind and run. `--bind` wins; else the tailnet IP; else loopback (with a
 * loud warning — loopback means only this machine can answer, which is right
 * for a smoke test and useless to the phone).
 */
export async function startLiveServer(
  config: BurnConfig,
  options: { bind?: string; port?: number } = {},
): Promise<LiveServerHandle> {
  const detected = options.bind ? null : await tailscaleIp();
  const hostname = options.bind ?? detected ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (!options.bind && detected === null) {
    console.warn("[live] tailscale not detected — binding 127.0.0.1 (phone cannot reach this)");
  }
  const server = Bun.serve({ hostname, port, fetch: createLiveFetch({ config }) });
  const boundPort = server.port ?? port;
  return {
    hostname,
    port: boundPort,
    url: `http://${hostname}:${boundPort}`,
    stop: () => server.stop(true),
  };
}

/**
 * `burn-report serve` — the live server alone, without the daemon's push
 * loop. Heartbeats once at startup so the phone learns the endpoint even if
 * no push has happened yet; the daemon remains the recommended resident mode.
 */
export async function runServe(args: Map<string, string>): Promise<void> {
  const config = loadConfig();
  const options: { bind?: string; port?: number } = {};
  const bindArg = args.get("bind");
  if (bindArg) options.bind = bindArg;
  const portArg = args.get("port");
  if (portArg) options.port = Number(portArg);
  const live = await startLiveServer(config, options);
  const advertised = args.get("live-url") ?? live.url;
  console.log(`[serve] ${config.environmentSlug} live at ${live.url} (advertised: ${advertised})`);
  try {
    const { reporterApiFor } = await import("./backend.js");
    await reporterApiFor(config).heartbeat({
      reporterVersion: REPORTER_VERSION,
      tokscaleVersion: null,
      exportSchema: EVENT_EXPORT_SCHEMA,
      reportingTimezone: config.reportingTimezone,
      liveEndpoint: advertised,
    });
  } catch (err) {
    console.warn(`[serve] heartbeat failed (phone will learn the endpoint on the next push): ${(err as Error).message}`);
  }
  await new Promise<never>(() => {
    process.on("SIGINT", () => {
      live.stop();
      console.log("\n[serve] stopped");
      process.exit(0);
    });
  });
}
